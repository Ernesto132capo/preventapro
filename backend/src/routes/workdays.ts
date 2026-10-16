import { Router } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";
import { z } from "zod";

export const workdaysRouter = Router();
workdaysRouter.use(requireAuth);

function today() { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const v = (t: string) => p.find(x => x.type === t)?.value; return `${v("year")}-${v("month")}-${v("day")}`; }
function serial(row: any) { return { id: row.id, server_id: row.id, user_id: row.user_id, work_date: row.work_date, status: row.status, order_count: row.order_count ?? 0, total_cents: row.total_cents ?? 0, created_at: row.created_at, closed_at: row.closed_at ?? null, auto_closed: row.auto_closed === true }; }

async function recalc(id: string) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders WHERE work_day_id = $1 AND status != 'cancelled'", [id]);
  const { count, total } = rows[0];
  await pool.query("UPDATE work_days SET order_count = $2, total_cents = $3, updated_at = $4 WHERE id = $1", [id, count, total, nowIso()]);
  return { orderCount: count, totalCents: total };
}

// Si un preventista olvida cerrar la jornada y cambia el día calendario (00:00
// hora Bolivia), esa jornada vieja quedaría en el limbo: ya no es "hoy" (no
// aparece en ventas del día) pero tampoco está "closed" (no aparece en
// Historial, que solo lista jornadas cerradas) — invisible para siempre con
// todos sus pedidos adentro. Esta función la cierra automáticamente, con sus
// totales reales, justo antes de abrir la jornada del nuevo día.
async function closeStaleOpenWorkDays(currentDate: string): Promise<boolean> {
  const ts = nowIso();
  const { rows } = await pool.query(
    `WITH stale AS (
       SELECT wd.id,
              COUNT(o.id) FILTER (WHERE o.status != 'cancelled')::int AS order_count,
              COALESCE(SUM(o.total_cents) FILTER (WHERE o.status != 'cancelled'), 0)::int AS total_cents
       FROM work_days wd
       LEFT JOIN orders o ON o.work_day_id = wd.id
       WHERE wd.status = 'open' AND wd.work_date < $1
       GROUP BY wd.id
     )
     UPDATE work_days wd
     SET status = 'closed', order_count = stale.order_count, total_cents = stale.total_cents,
         closed_at = $2, updated_at = $2, auto_closed = true
     FROM stale
     WHERE wd.id = stale.id
     RETURNING wd.id`,
    [currentDate, ts]
  );
  return rows.length > 0;
}

// ─── Caché en memoria para /workdays/current ─────────────────────────────────
// Evita releer Postgres en cada poll de 60s cuando la jornada no cambió.
// Se invalida en cada mutación de jornada o pedido; por eso no expira por
// tiempo y los polls sin cambios no leen la base.
interface WorkdayCache {
  date: string;
  data: object;
}
let workdayCacheEntry: WorkdayCache | null = null;

export function invalidateWorkdayCache() {
  workdayCacheEntry = null;
}

workdaysRouter.get("/current", async (req: AuthedRequest, res) => {
  const date = today();
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  // Devolver caché si pertenece al mismo día y no se solicita verificación fresca.
  // Se invalida al crear, editar o cerrar jornadas y al crear/editar/cancelar pedidos.
  if (!fresh && workdayCacheEntry && workdayCacheEntry.date === date) {
    return res.json(workdayCacheEntry.data);
  }

  // 1. Buscar todas las jornadas de hoy (1 query), la más reciente primero
  const todayResult = await pool.query(
    "SELECT * FROM work_days WHERE work_date = $1 ORDER BY COALESCE(updated_at, created_at) DESC",
    [date]
  );
  if (todayResult.rows.length > 0) {
    const row = todayResult.rows[0];
    // NOTA: NO llamamos recalc() aquí — recalc es una operación de escritura
    // que debe ocurrir únicamente en mutaciones (crear/cancelar orden, cerrar jornada).
    // Llamarla en cada GET de 60s generaba cientos de lecturas/escrituras extras.
    const payload = { workDay: serial(row) };
    workdayCacheEntry = { date, data: payload };
    return res.json(payload);
  }

  // 2. Primera vez del día: antes de abrir la jornada nueva, cerrar
  // automáticamente cualquier jornada de un día anterior que haya quedado
  // abierta (ver closeStaleOpenWorkDays). Así nunca queda una jornada
  // huérfana sin poder verse ni en "hoy" ni en el Historial.
  const closedStale = await closeStaleOpenWorkDays(date);
  if (closedStale) {
    invalidateWorkdayCache();
    invalidatePullCache("workdays");
  }

  const id = uuid();
  const ts = nowIso();
  const { rows } = await pool.query(
    `INSERT INTO work_days (id, user_id, work_date, status, order_count, total_cents, created_at, updated_at)
     VALUES ($1, $2, $3, 'open', 0, 0, $4, $4)
     RETURNING *`,
    [id, req.userId, date, ts]
  );
  const payload = { workDay: serial(rows[0]) };
  workdayCacheEntry = { date, data: payload };
  invalidatePullCache("workdays");
  res.json(payload);
});

workdaysRouter.get("/history", async (_req: AuthedRequest, res) => {
  const { rows } = await pool.query("SELECT * FROM work_days WHERE status = 'closed' ORDER BY work_date DESC");
  res.json({ workDays: rows.map(serial) });
});

workdaysRouter.get("/:id/orders", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.business_name, c.neighborhood_id AS client_neighborhood_id
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.work_day_id = $1 AND o.status != 'cancelled'`,
    [req.params.id]
  );
  const orders = rows.map((row) => ({
    ...row,
    client_id: row.client_id,
    work_day_id: row.work_day_id,
    business_name: row.business_name ?? "",
    neighborhood_id: row.client_neighborhood_id ?? null,
  }));
  res.json({ orders });
});

workdaysRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { rows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [req.params.id]);
  const row = rows[0];
  if (!row || row.status !== "closed") return res.status(404).json({ error: "Registro histórico no encontrado." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM order_item_selections
       WHERE order_item_id IN (
         SELECT oi.id FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.work_day_id = $1
       )`,
      [req.params.id]
    );
    await client.query("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE work_day_id = $1)", [req.params.id]);
    await client.query("DELETE FROM orders WHERE work_day_id = $1", [req.params.id]);
    await client.query("DELETE FROM work_days WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  const reportRoot = path.resolve(__dirname, "../../reports");
  const reportDir = path.resolve(reportRoot, path.basename(String(row.id)));
  if (reportDir.startsWith(`${reportRoot}${path.sep}`)) {
    try {
      await fs.promises.rm(reportDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`No se pudieron borrar los reportes de la jornada ${row.id}:`, error);
    }
  }
  res.json({ ok: true });
});

workdaysRouter.post("/:id/close", async (req: AuthedRequest, res) => {
  const parsed = z.object({ confirmation: z.literal("CONFIRMAR") }).strict().safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Debes escribir exactamente "CONFIRMAR" para cerrar la jornada.' });
  const { rows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Jornada no encontrada." });
  if (row.status === "closed") return res.status(409).json({ error: "La jornada ya está cerrada." });

  const totals = await recalc(req.params.id), ts = nowIso();
  const { rows: updated } = await pool.query(
    "UPDATE work_days SET status = 'closed', order_count = $2, total_cents = $3, closed_at = $4, updated_at = $4 WHERE id = $1 RETURNING *",
    [req.params.id, totals.orderCount, totals.totalCents, ts]
  );
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  // Asegurar que cualquier otra jornada huérfana de hoy quede cerrada
  const workDate = row.work_date;
  if (workDate) {
    await pool.query(
      "UPDATE work_days SET status = 'closed', closed_at = $3, updated_at = $3 WHERE work_date = $1 AND status = 'open' AND id != $2",
      [workDate, req.params.id, ts]
    );
  }

  res.json({ workDay: serial(updated[0]) });
});

workdaysRouter.post("/:id/reopen", async (req: AuthedRequest, res) => {
  const { rows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Jornada no encontrada." });

  const totals = await recalc(req.params.id);
  const ts = nowIso();
  const { rows: updated } = await pool.query(
    "UPDATE work_days SET status = 'open', order_count = $2, total_cents = $3, closed_at = NULL, updated_at = $4 WHERE id = $1 RETURNING *",
    [req.params.id, totals.orderCount, totals.totalCents, ts]
  );
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  const workDate = row.work_date;
  if (workDate) {
    await pool.query(
      "UPDATE work_days SET status = 'open', closed_at = NULL, updated_at = $3 WHERE work_date = $1 AND id != $2",
      [workDate, req.params.id, ts]
    );
  }

  res.json({ workDay: serial(updated[0]) });
});

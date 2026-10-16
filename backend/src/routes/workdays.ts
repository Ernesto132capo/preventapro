import { Router } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { PoolClient } from "pg";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";
import { z } from "zod";

export const workdaysRouter = Router();
workdaysRouter.use(requireAuth);

function today() { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const v = (t: string) => p.find(x => x.type === t)?.value; return `${v("year")}-${v("month")}-${v("day")}`; }
function serial(row: any) { return { id: row.id, server_id: row.id, user_id: row.user_id, work_date: row.work_date, status: row.status, order_count: row.order_count ?? 0, total_cents: row.total_cents ?? 0, created_at: row.created_at, closed_at: row.closed_at ?? null, auto_closed: row.auto_closed === true }; }

async function recalc(id: string, db: PoolClient) {
  const { rows } = await db.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders WHERE work_day_id = $1 AND status = 'active'", [id]);
  const { count, total } = rows[0];
  await db.query("UPDATE work_days SET order_count = $2, total_cents = $3, updated_at = $4 WHERE id = $1", [id, count, total, nowIso()]);
  return { orderCount: count, totalCents: total };
}

// Si un preventista olvida cerrar la jornada y cambia el día calendario (00:00
// hora Bolivia), esa jornada vieja quedaría en el limbo: ya no es "hoy" (no
// aparece en ventas del día) pero tampoco está "closed" (no aparece en
// Historial, que solo lista jornadas cerradas) — invisible para siempre con
// todos sus pedidos adentro. Esta función la cierra automáticamente, con sus
// totales reales, justo antes de abrir la jornada del nuevo día.
export async function closeStaleOpenWorkDays(currentDate: string, userId: string, db: PoolClient): Promise<boolean> {
  const ts = nowIso();
  // Tomar primero los locks de jornada evita calcular totales con un snapshot
  // anterior a un pedido que estuviera terminando de insertarse.
  const { rows: staleRows } = await db.query(
    "SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND work_date < $2 FOR UPDATE",
    [userId, currentDate]
  );
  if (staleRows.length === 0) return false;

  const staleIds = staleRows.map((row) => row.id);
  const { rows } = await db.query(
    `WITH stale AS (
       SELECT wd.id,
              COUNT(o.id) FILTER (WHERE o.status = 'active')::int AS order_count,
              COALESCE(SUM(o.total_cents) FILTER (WHERE o.status = 'active'), 0)::int AS total_cents
       FROM work_days wd
       LEFT JOIN orders o ON o.work_day_id = wd.id
       WHERE wd.id = ANY($1)
       GROUP BY wd.id
     )
     UPDATE work_days wd
     SET status = 'closed', order_count = stale.order_count, total_cents = stale.total_cents,
         closed_at = $2, updated_at = $2, auto_closed = true
     FROM stale
     WHERE wd.id = stale.id
     RETURNING wd.id`,
    [staleIds, ts]
  );
  return rows.length > 0;
}

async function lockUserWorkDays(client: PoolClient, userId: string) {
  await client.query("SELECT pg_advisory_xact_lock(1003, hashtext($1))", [`workdays:${userId}`]);
}

// ─── Caché en memoria para /workdays/current ─────────────────────────────────
// Evita releer Postgres en cada poll de 60s cuando la jornada no cambió.
// Se invalida en cada mutación de jornada o pedido; por eso no expira por
// tiempo y los polls sin cambios no leen la base.
interface WorkdayCache {
  userId: string;
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
  if (!fresh && workdayCacheEntry && workdayCacheEntry.userId === req.userId && workdayCacheEntry.date === date) {
    return res.json(workdayCacheEntry.data);
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    // GET /current también crea datos. El lock por usuario evita dos jornadas
    // abiertas concurrentes, incluso si los dispositivos consultan fechas distintas.
    await lockUserWorkDays(client, req.userId!);
    const closedStale = await closeStaleOpenWorkDays(date, req.userId!, client);

    const { rows: futureOpenRows } = await client.query(
      "SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND work_date > $2 LIMIT 1 FOR UPDATE",
      [req.userId, date]
    );
    if (futureOpenRows.length > 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({ error: "Ya existe una jornada abierta para este preventista. Ciérrala antes de abrir otra." });
    }

    const { rows: todayOpenRows } = await client.query(
      "SELECT * FROM work_days WHERE user_id = $1 AND work_date = $2 AND status = 'open' ORDER BY COALESCE(updated_at, created_at) DESC FOR UPDATE",
      [req.userId, date]
    );
    if (todayOpenRows.length > 0) {
      const currentOpen = todayOpenRows[0];
      // Reparar duplicados antiguos: conservar una abierta y cerrar las demás con sus totales.
      for (const duplicate of todayOpenRows.slice(1)) {
        const duplicateTotals = await recalc(duplicate.id, client);
        const ts = nowIso();
        await client.query(
          "UPDATE work_days SET status = 'closed', order_count = $2, total_cents = $3, closed_at = $4, updated_at = $4 WHERE id = $1",
          [duplicate.id, duplicateTotals.orderCount, duplicateTotals.totalCents, ts]
        );
      }
      const payload = { workDay: serial(currentOpen) };
      await client.query("COMMIT");
      inTransaction = false;
      if (closedStale || todayOpenRows.length > 1) invalidatePullCache("workdays");
      workdayCacheEntry = { userId: req.userId!, date, data: payload };
      return res.json(payload);
    }

    const { rows: todayClosedRows } = await client.query(
      "SELECT * FROM work_days WHERE user_id = $1 AND work_date = $2 AND status = 'closed' ORDER BY COALESCE(updated_at, created_at) DESC FOR UPDATE",
      [req.userId, date]
    );
    if (todayClosedRows.length > 0) {
      const payload = { workDay: serial(todayClosedRows[0]) };
      await client.query("COMMIT");
      inTransaction = false;
      if (closedStale) invalidatePullCache("workdays");
      workdayCacheEntry = { userId: req.userId!, date, data: payload };
      return res.json(payload);
    }

    // Las jornadas anteriores de este usuario ya se cerraron arriba; crear solo
    // cuando no existe otra jornada abierta ni una jornada cerrada para hoy.
    const id = uuid();
    const ts = nowIso();
    const { rows } = await client.query(
      `INSERT INTO work_days (id, user_id, work_date, status, order_count, total_cents, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', 0, 0, $4, $4)
       RETURNING *`,
      [id, req.userId, date, ts]
    );
    const payload = { workDay: serial(rows[0]) };
    await client.query("COMMIT");
    inTransaction = false;
    if (closedStale) invalidateWorkdayCache();
    invalidatePullCache("workdays");
    workdayCacheEntry = { userId: req.userId!, date, data: payload };
    return res.json(payload);
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al resolver la jornada actual:", error);
    return res.status(500).json({ error: "No se pudo resolver la jornada actual." });
  } finally {
    client.release();
  }
});

workdaysRouter.get("/history", async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM work_days WHERE user_id = $1 AND status = 'closed' ORDER BY work_date DESC", [req.userId]);
    res.json({ workDays: rows.map(serial) });
  } catch (err) {
    next(err);
  }
});

workdaysRouter.get("/:id/orders", async (req: AuthedRequest, res, next) => {
  try {
    const workDay = await pool.query("SELECT id FROM work_days WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    if (workDay.rows.length === 0) return res.status(404).json({ error: "Jornada no encontrada." });
    const { rows } = await pool.query(
      `SELECT o.*, c.business_name, c.neighborhood_id AS client_neighborhood_id
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       WHERE o.work_day_id = $1 AND o.status = 'active'`,
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
  } catch (err) {
    next(err);
  }
});

workdaysRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const client = await pool.connect();
  let inTransaction = false;
  let row: any;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    row = rows[0];
    if (!row || row.user_id !== req.userId || row.status !== "closed") {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ error: "Registro histórico no encontrado." });
    }
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
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al eliminar jornada:", err);
    return res.status(500).json({ error: "No se pudo eliminar el registro histórico." });
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
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await lockUserWorkDays(client, req.userId!);
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    const row = rows[0];
    if (!row || row.user_id !== req.userId) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ error: "Jornada no encontrada." });
    }
    if (row.status === "closed") {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({ error: "La jornada ya está cerrada." });
    }

    const totals = await recalc(req.params.id, client), ts = nowIso();
    const { rows: updated } = await client.query(
      "UPDATE work_days SET status = 'closed', order_count = $2, total_cents = $3, closed_at = $4, updated_at = $4 WHERE id = $1 RETURNING *",
      [req.params.id, totals.orderCount, totals.totalCents, ts]
    );
    await client.query("COMMIT");
    inTransaction = false;
    invalidateWorkdayCache();
    invalidatePullCache("workdays");
    res.json({ workDay: serial(updated[0]) });
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al cerrar jornada:", error);
    res.status(500).json({ error: "No se pudo cerrar la jornada." });
  } finally {
    client.release();
  }
});

workdaysRouter.post("/:id/reopen", async (req: AuthedRequest, res) => {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await lockUserWorkDays(client, req.userId!);
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    const row = rows[0];
    if (!row || row.user_id !== req.userId) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ error: "Jornada no encontrada." });
    }

    const otherOpen = await client.query(
      "SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND id != $2 LIMIT 1 FOR UPDATE",
      [req.userId, row.id]
    );
    if (otherOpen.rows.length > 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({ error: "Ya existe otra jornada abierta. Ciérrala antes de reabrir esta jornada." });
    }

    const totals = await recalc(req.params.id, client);
    const ts = nowIso();
    const { rows: updated } = await client.query(
      "UPDATE work_days SET status = 'open', order_count = $2, total_cents = $3, closed_at = NULL, updated_at = $4 WHERE id = $1 RETURNING *",
      [req.params.id, totals.orderCount, totals.totalCents, ts]
    );
    await client.query("COMMIT");
    inTransaction = false;
    invalidateWorkdayCache();
    invalidatePullCache("workdays");
    res.json({ workDay: serial(updated[0]) });
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al reabrir jornada:", error);
    res.status(500).json({ error: "No se pudo reabrir la jornada." });
  } finally {
    client.release();
  }
});

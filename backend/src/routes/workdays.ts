import { Router } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { PoolClient } from "pg";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";
import { z } from "zod";
import { getBoliviaToday } from "../services/dates";
import { isDatabaseUnavailable } from "../services/http-errors";
import { withReportDirectoryLock } from "../services/report-storage";

export const workdaysRouter = Router();
workdaysRouter.use(requireAuth);

function serial(row: any) { return { id: row.id, server_id: row.id, user_id: row.user_id, work_date: row.work_date, status: row.status, order_count: row.order_count ?? 0, total_cents: row.total_cents ?? 0, created_at: row.created_at, closed_at: row.closed_at ?? null, auto_closed: row.auto_closed === true }; }

async function recalc(id: string, db: PoolClient) {
  const { rows } = await db.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders WHERE work_day_id = $1 AND status = 'active'", [id]);
  const { count, total } = rows[0];
  await db.query("UPDATE work_days SET order_count = $2, total_cents = $3, updated_at = $4 WHERE id = $1", [id, count, total, nowIso()]);
  return { orderCount: count, totalCents: total };
}

// El borrado físico necesita una señal persistente para los otros teléfonos.
// Si falta la migración, falla la transacción completa y conserva la jornada.
async function recordDeletedWorkday(db: PoolClient, id: string) {
  await db.query(
    `INSERT INTO sync_tombstones (entity_type, entity_id, deleted_at)
     VALUES ('workday', $1, now())
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
    [id]
  );
}

function workdayErrorStatus(error: unknown, client: PoolClient | undefined) {
  const missingMigration = Boolean(error && typeof error === "object" && "code" in error && error.code === "42P01");
  return !client || isDatabaseUnavailable(error) || missingMigration ? 503 : 500;
}

// Si un preventista olvida cerrar la jornada y cambia el día calendario (00:00
// hora Bolivia), esa jornada vieja quedaría en el limbo: ya no es "hoy" (no
// aparece en ventas del día) pero tampoco está "closed" (no aparece en
// Historial, que solo lista jornadas cerradas) — invisible para siempre con
// todos sus pedidos adentro. Esta función la cierra automáticamente, con sus
// totales reales, justo antes de abrir la jornada del nuevo día.
export async function closeStaleOpenWorkDays(currentDate: string, _userId: string, db: PoolClient): Promise<boolean> {
  const ts = nowIso();
  // Tomar primero los locks de jornada evita calcular totales con un snapshot
  // anterior a un pedido que estuviera terminando de insertarse.
  const { rows: staleRows } = await db.query(
    "SELECT id FROM work_days WHERE status = 'open' AND work_date < $1 FOR UPDATE",
    [currentDate]
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

export async function lockWorkDays(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(1003, hashtext('workdays:shared'))");
}

// ─── Caché en memoria para /workdays/current (compartida para el negocio) ────
// Evita releer Postgres en cada poll de 60s cuando la jornada no cambió.
interface WorkdayCache {
  date: string;
  data: object;
  cachedAt: number;
}
let currentWorkdayCache: WorkdayCache | null = null;
const WORKDAY_CACHE_TTL_MS = 60_000;

export function invalidateWorkdayCache(_userId?: string) {
  currentWorkdayCache = null;
}

workdaysRouter.get("/current", async (req: AuthedRequest, res) => {
  const date = getBoliviaToday();
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  const now = Date.now();
  if (!fresh && currentWorkdayCache && currentWorkdayCache.date === date && now - currentWorkdayCache.cachedAt < WORKDAY_CACHE_TTL_MS) {
    return res.json(currentWorkdayCache.data);
  }

  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    // Lock compartido para todo el negocio
    await lockWorkDays(client);
    const closedStale = await closeStaleOpenWorkDays(date, req.userId!, client);

    const { rows: futureOpenRows } = await client.query(
      "SELECT id FROM work_days WHERE status = 'open' AND work_date > $1 LIMIT 1 FOR UPDATE",
      [date]
    );
    if (futureOpenRows.length > 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({ error: "Ya existe una jornada abierta. Ciérrala antes de abrir otra." });
    }

    const { rows: todayOpenRows } = await client.query(
      "SELECT * FROM work_days WHERE work_date = $1 AND status = 'open' ORDER BY COALESCE(updated_at, created_at) DESC FOR UPDATE",
      [date]
    );
    if (todayOpenRows.length > 0) {
      const currentOpen = todayOpenRows[0];
      // Reparar duplicados antiguos: unificar órdenes y eliminar filas duplicadas
      for (const duplicate of todayOpenRows.slice(1)) {
        await client.query("UPDATE orders SET work_day_id = $1, updated_at = $3 WHERE work_day_id = $2", [currentOpen.id, duplicate.id, nowIso()]);
        await recordDeletedWorkday(client, duplicate.id);
        await client.query("DELETE FROM work_days WHERE id = $1", [duplicate.id]);
      }
      await recalc(currentOpen.id, client);
      const { rows: reloaded } = await client.query("SELECT * FROM work_days WHERE id = $1", [currentOpen.id]);
      const payload = { workDay: serial(reloaded[0]) };
      await client.query("COMMIT");
      inTransaction = false;
      if (closedStale || todayOpenRows.length > 1) invalidatePullCache("workdays");
      if (todayOpenRows.length > 1) invalidatePullCache("orders");
      currentWorkdayCache = { date, data: payload, cachedAt: Date.now() };
      return res.json(payload);
    }

    const { rows: todayClosedRows } = await client.query(
      "SELECT * FROM work_days WHERE work_date = $1 AND status = 'closed' ORDER BY COALESCE(updated_at, created_at) DESC FOR UPDATE",
      [date]
    );
    if (todayClosedRows.length > 0) {
      const currentClosed = todayClosedRows[0];
      for (const duplicate of todayClosedRows.slice(1)) {
        await client.query("UPDATE orders SET work_day_id = $1, updated_at = $3 WHERE work_day_id = $2", [currentClosed.id, duplicate.id, nowIso()]);
        await recordDeletedWorkday(client, duplicate.id);
        await client.query("DELETE FROM work_days WHERE id = $1", [duplicate.id]);
      }
      await recalc(currentClosed.id, client);
      const { rows: reloaded } = await client.query("SELECT * FROM work_days WHERE id = $1", [currentClosed.id]);
      const payload = { workDay: serial(reloaded[0]) };
      await client.query("COMMIT");
      inTransaction = false;
      if (closedStale || todayClosedRows.length > 1) invalidatePullCache("workdays");
      if (todayClosedRows.length > 1) invalidatePullCache("orders");
      currentWorkdayCache = { date, data: payload, cachedAt: Date.now() };
      return res.json(payload);
    }

    // Crear la jornada compartida única de hoy
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
    invalidateWorkdayCache();
    invalidatePullCache("workdays");
    currentWorkdayCache = { date, data: payload, cachedAt: Date.now() };
    return res.json(payload);
  } catch (error) {
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al resolver la jornada actual:", error);
    return res.status(workdayErrorStatus(error, client)).json({ error: "No se pudo resolver la jornada actual. Intenta de nuevo más tarde." });
  } finally {
    client?.release();
  }
});

workdaysRouter.get("/history", async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM work_days WHERE status = 'closed' ORDER BY work_date DESC");
    res.json({ workDays: rows.map(serial) });
  } catch (err) {
    next(err);
  }
});

workdaysRouter.get("/:id/orders", async (req: AuthedRequest, res, next) => {
  try {
    const workDay = await pool.query("SELECT id FROM work_days WHERE id = $1", [req.params.id]);
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
  let client: PoolClient | undefined;
  let inTransaction = false;
  let row: any;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    row = rows[0];
    if (!row || row.status !== "closed") {
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
    await recordDeletedWorkday(client, req.params.id);
    await client.query("DELETE FROM work_days WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al eliminar jornada:", err);
    return res.status(workdayErrorStatus(err, client)).json({ error: "No se pudo eliminar el registro histórico. Intenta de nuevo más tarde." });
  } finally {
    client?.release();
  }
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  const reportRoot = path.resolve(__dirname, "../../reports");
  const reportDir = path.resolve(reportRoot, path.basename(String(row.id)));
  if (reportDir.startsWith(`${reportRoot}${path.sep}`)) {
    try {
      await withReportDirectoryLock(reportDir, () => fs.promises.rm(reportDir, { recursive: true, force: true }));
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
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    await lockWorkDays(client);
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    const row = rows[0];
    if (!row) {
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
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al cerrar jornada:", error);
    res.status(workdayErrorStatus(error, client)).json({ error: "No se pudo cerrar la jornada. Intenta de nuevo más tarde." });
  } finally {
    client?.release();
  }
});

workdaysRouter.post("/:id/reopen", async (req: AuthedRequest, res) => {
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    await lockWorkDays(client);
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [req.params.id]);
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ error: "Jornada no encontrada." });
    }

    const otherOpen = await client.query(
      "SELECT id FROM work_days WHERE status = 'open' AND id != $1 LIMIT 1 FOR UPDATE",
      [row.id]
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
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* la conexión puede haberse perdido */ }
    }
    console.error("Error al reabrir jornada:", error);
    res.status(workdayErrorStatus(error, client)).json({ error: "No se pudo reabrir la jornada. Intenta de nuevo más tarde." });
  } finally {
    client?.release();
  }
});

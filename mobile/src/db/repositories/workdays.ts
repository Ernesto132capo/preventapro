import { v4 as uuid } from "uuid";
import { getDb, nowIso, withTx } from "../client";
import { WorkDay } from "../../domain/types";
import { todayBolivia } from "../../utils/dates";

const userWorkDayLocks = new Map<string, Promise<void>>();

/** Serializa cambios locales de jornada por preventista para evitar aperturas duplicadas. */
export async function withUserWorkDayLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  // SQLite usa una única conexión local: serializarla completa evita que dos
  // transacciones de preventistas distintos se intercalen en el mismo handle.
  const lockKey = "local-workday-database";
  const previous = userWorkDayLocks.get(lockKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  userWorkDayLocks.set(lockKey, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (userWorkDayLocks.get(lockKey) === current) userWorkDayLocks.delete(lockKey);
  }
}

/** Devuelve la jornada de hoy. Si fue concluida, retorna 'closed' y no la sobreescribe a 'open'. */
export async function getTodayWorkDay(userId: string): Promise<WorkDay> {
  const db = await getDb();
  const today = todayBolivia();
  return withUserWorkDayLock("shared", async () => {
    let row: any = null;
    await withTx(async () => {
      // Al cambiar de fecha, concluir localmente jornadas olvidadas con sus totales reales.
      await db.runAsync(
        `UPDATE work_days
         SET status = 'closed',
             order_count = (SELECT COUNT(*) FROM orders WHERE work_day_id = work_days.id AND status = 'active'),
             total_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE work_day_id = work_days.id AND status = 'active')
         WHERE status = 'open' AND work_date < ?`,
        [today]
      );

      // Si ya existe una jornada abierta con fecha posterior (debido a clock skew del teléfono o cambio de huso),
      // no crasheamos: la reutilizamos como la jornada activa actual para que el usuario pueda trabajar o cerrarla limpiamente.
      const futureOpen = await db.getFirstAsync<any>(
        `SELECT * FROM work_days WHERE status = 'open' AND work_date > ?
         ORDER BY work_date DESC, created_at DESC LIMIT 1`,
        [today]
      );
      if (futureOpen) {
        row = futureOpen;
        return;
      }

      const rows = await db.getAllAsync<any>(
        `SELECT * FROM work_days WHERE work_date = ?
         ORDER BY CASE WHEN status = 'closed' THEN 0 ELSE 1 END,
                  CASE WHEN server_id IS NOT NULL THEN 0 ELSE 1 END,
                  created_at DESC`,
        [today]
      );

      if (rows.length > 0) {
        row = rows[0];
        const hasClosed = rows.some((candidate) => candidate.status === 'closed');
        for (const duplicate of rows.slice(1)) {
          await db.runAsync(`UPDATE orders SET work_day_id = ? WHERE work_day_id = ?`, [row.id, duplicate.id]);
          await db.runAsync(`DELETE FROM work_days WHERE id = ?`, [duplicate.id]);
        }
        if (rows.length > 1) {
          const status = hasClosed ? 'closed' : 'open';
          await db.runAsync(
            `UPDATE work_days SET status = ?,
               order_count = (SELECT COUNT(*) FROM orders WHERE work_day_id = ? AND status = 'active'),
               total_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE work_day_id = ? AND status = 'active')
             WHERE id = ?`,
            [status, row.id, row.id, row.id]
          );
          row = await db.getFirstAsync<any>(`SELECT * FROM work_days WHERE id = ?`, [row.id]);
        }
      } else {
        const id = uuid();
        await db.runAsync(
          `INSERT INTO work_days (id, user_id, work_date, status, order_count, total_cents, sync_status, created_at)
           VALUES (?, ?, ?, 'open', 0, 0, 'pending', ?)`,
          [id, userId, today, nowIso()]
        );
        row = await db.getFirstAsync<any>(`SELECT * FROM work_days WHERE id = ?`, [id]);
      }
    });
    return { ...row, local_id: row.id };
  });
}

export const getOrCreateOpenWorkDay = getTodayWorkDay;

export async function getWorkDay(id: string): Promise<WorkDay | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM work_days WHERE id = ?`, [id]);
  return row ? { ...row, local_id: row.id } : null;
}

export async function upsertServerWorkDay(localId: string, serverWorkDay: any) {
  const db = await getDb();
  const newStatus = serverWorkDay.status === "closed" ? "closed" : "open";
  const serverId = serverWorkDay.id || serverWorkDay.server_id;
  const workDate = serverWorkDay.work_date;
  const userId = typeof serverWorkDay.user_id === "string" ? serverWorkDay.user_id : "shared";

  await withUserWorkDayLock("shared", async () => {
    await withTx(async () => {
      const matchingRows = await db.getAllAsync<any>(
        `SELECT * FROM work_days WHERE id = ? OR server_id = ? OR (work_date = ? AND ? IS NOT NULL)`,
        [localId, serverId, workDate, workDate]
      );

      let canonicalId = localId;
      if (matchingRows.length > 0) {
        const canonicalRow = matchingRows.find((r) => r.id === localId || r.server_id === serverId) || matchingRows[0];
        canonicalId = canonicalRow.id;
        for (const duplicate of matchingRows) {
          if (duplicate.id !== canonicalId) {
            await db.runAsync(`UPDATE orders SET work_day_id = ? WHERE work_day_id = ?`, [canonicalId, duplicate.id]);
            await db.runAsync(`DELETE FROM work_days WHERE id = ?`, [duplicate.id]);
          }
        }
      }

      const existingCanonical = await db.getFirstAsync<any>(`SELECT id FROM work_days WHERE id = ?`, [canonicalId]);
      if (existingCanonical) {
        await db.runAsync(
          `UPDATE work_days SET server_id = ?, status = ?, order_count = ?, total_cents = ?, sync_status = 'synced'
           WHERE id = ?`,
          [serverId, newStatus, serverWorkDay.order_count ?? 0, serverWorkDay.total_cents ?? 0, canonicalId]
        );
      } else {
        await db.runAsync(
          `INSERT INTO work_days (id, server_id, user_id, work_date, status, order_count, total_cents, sync_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
          [canonicalId, serverId, userId, workDate, newStatus, serverWorkDay.order_count ?? 0, serverWorkDay.total_cents ?? 0, nowIso()]
        );
      }
    });
  });
}

export async function resolveServerWorkDayId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ server_id: string | null; user_id: string; work_date: string }>(
    `SELECT server_id, user_id, work_date FROM work_days WHERE id = ? OR server_id = ? LIMIT 1`,
    [localId, localId]
  );
  if (!row) return null;
  if (row.server_id) return row.server_id;

  // Fallback a cualquier jornada con server_id de la misma fecha
  const openWd = await db.getFirstAsync<{ server_id: string | null }>(
    `SELECT server_id FROM work_days WHERE server_id IS NOT NULL AND work_date = ? ORDER BY created_at DESC LIMIT 1`,
    [row.work_date]
  );
  if (openWd?.server_id) {
    await db.runAsync(`UPDATE work_days SET server_id = ? WHERE id = ?`, [openWd.server_id, localId]);
    return openWd.server_id;
  }

  return null;
}

export async function markWorkDayClosed(localId: string, orderCount?: number, totalCents?: number) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ user_id: string; server_id: string | null }>(
    `SELECT user_id, server_id FROM work_days WHERE id = ?`,
    [localId]
  );
  if (!row) return;
  await withUserWorkDayLock("shared", async () => {
    await withTx(async () => {
      let oc = orderCount;
      let tc = totalCents;
      if (oc === undefined || tc === undefined) {
        const aggregate = await db.getFirstAsync<{ order_count: number; total_cents: number }>(
          `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_cents), 0) AS total_cents
           FROM orders WHERE status = 'active' AND
             (work_day_id = ? OR (? IS NOT NULL AND (work_day_id = ? OR work_day_id IN (
               SELECT id FROM work_days WHERE server_id = ?
             ))))`,
          [localId, row.server_id, row.server_id, row.server_id]
        );
        oc = aggregate?.order_count ?? 0;
        tc = aggregate?.total_cents ?? 0;
      }
      if (row.server_id) {
        await db.runAsync(
          `UPDATE work_days SET status = 'closed', order_count = ?, total_cents = ? WHERE id = ? OR server_id = ?`,
          [oc, tc, localId, row.server_id]
        );
      } else {
        await db.runAsync(`UPDATE work_days SET status = 'closed', order_count = ?, total_cents = ? WHERE id = ?`, [oc, tc, localId]);
      }
    });
  });
}

export async function reopenWorkDayLocal(localId: string) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ user_id: string; server_id: string | null }>(
    `SELECT user_id, server_id FROM work_days WHERE id = ?`,
    [localId]
  );
  if (!row) throw new Error('No se encontró la jornada que se desea reabrir.');
  await withUserWorkDayLock("shared", async () => {
    const otherOpen = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM work_days WHERE status = 'open' AND id != ?
       AND (? IS NULL OR server_id IS NULL OR server_id != ?) LIMIT 1`,
      [localId, row.server_id, row.server_id]
    );
    if (otherOpen) {
      throw new Error('Ya existe otra jornada abierta. Ciérrala antes de reabrir esta jornada.');
    }
    if (row.server_id) {
      await db.runAsync(`UPDATE work_days SET status = 'open' WHERE id = ? OR server_id = ?`, [localId, row.server_id]);
    } else {
      await db.runAsync(`UPDATE work_days SET status = 'open' WHERE id = ?`, [localId]);
    }
  });
}

export async function listClosedWorkDays(_userId?: string): Promise<WorkDay[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM work_days WHERE status = 'closed' ORDER BY work_date DESC`
  );
  return rows.map((r) => ({ ...r, local_id: r.id }));
}

/** Elimina la copia local después de que el backend confirmó borrar el histórico. */
export async function deleteClosedWorkDayLocal(localId: string): Promise<void> {
  const db = await getDb();
  await withTx(async () => {
    await db.runAsync(
      `DELETE FROM order_item_selections
       WHERE order_item_id IN (
         SELECT id FROM order_items
         WHERE order_id IN (SELECT id FROM orders WHERE work_day_id = ?)
       )`,
      [localId]
    );
    await db.runAsync(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE work_day_id = ?)`, [localId]);
    await db.runAsync(`DELETE FROM orders WHERE work_day_id = ?`, [localId]);
    await db.runAsync(`DELETE FROM work_days WHERE id = ? AND status = 'closed'`, [localId]);
  });
}

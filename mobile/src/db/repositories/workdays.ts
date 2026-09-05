import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "../client";
import { WorkDay } from "../../domain/types";

function todayStr(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Devuelve la jornada de hoy, priorizando la abierta o retornando la cerrada si ya concluyó. */
export async function getTodayWorkDay(userId: string): Promise<WorkDay> {
  const db = await getDb();
  const today = todayStr();
  let row = await db.getFirstAsync<any>(
    `SELECT * FROM work_days WHERE work_date = ? ORDER BY CASE WHEN status = 'open' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`,
    [today]
  );
  if (!row) {
    const id = uuid();
    await db.runAsync(
      `INSERT INTO work_days (id, user_id, work_date, status, order_count, total_cents, sync_status, created_at)
       VALUES (?, ?, ?, 'open', 0, 0, 'pending', ?)`,
      [id, userId, today, nowIso()]
    );
    row = await db.getFirstAsync<any>(`SELECT * FROM work_days WHERE id = ?`, [id]);
  }
  return { ...row, local_id: row.id };
}

export const getOrCreateOpenWorkDay = getTodayWorkDay;

export async function getWorkDay(id: string): Promise<WorkDay | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM work_days WHERE id = ?`, [id]);
  return row ? { ...row, local_id: row.id } : null;
}

export async function upsertServerWorkDay(localId: string, serverWorkDay: any) {
  const db = await getDb();
  if (serverWorkDay.status === "closed") {
    // Si el servidor cerró la jornada, marcarla como cerrada para todos los preventistas
    await db.runAsync(
      `UPDATE work_days SET server_id = ?, status = 'closed', order_count = ?, total_cents = ?, sync_status = 'synced' WHERE id = ?`,
      [serverWorkDay.id, serverWorkDay.order_count ?? 0, serverWorkDay.total_cents ?? 0, localId]
    );
    await db.runAsync(
      `UPDATE work_days SET status = 'closed', order_count = ?, total_cents = ?, sync_status = 'synced' WHERE server_id = ? OR work_date = ?`,
      [serverWorkDay.order_count ?? 0, serverWorkDay.total_cents ?? 0, serverWorkDay.id, serverWorkDay.work_date]
    );
  } else {
    await db.runAsync(
      `UPDATE work_days SET server_id = ?, sync_status = 'synced' WHERE id = ?`,
      [serverWorkDay.id, localId]
    );
  }
}

export async function resolveServerWorkDayId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ server_id: string | null }>(
    `SELECT server_id FROM work_days WHERE id = ? OR server_id = ?`,
    [localId, localId]
  );
  if (row?.server_id) return row.server_id;

  // Fallback: buscar cualquier jornada abierta que ya tenga server_id resuelto
  const openWd = await db.getFirstAsync<{ server_id: string | null }>(
    `SELECT server_id FROM work_days WHERE server_id IS NOT NULL AND status = 'open' ORDER BY created_at DESC LIMIT 1`
  );
  if (openWd?.server_id) {
    await db.runAsync(`UPDATE work_days SET server_id = ? WHERE id = ?`, [openWd.server_id, localId]);
    return openWd.server_id;
  }

  return null;
}

export async function markWorkDayClosed(localId: string, orderCount: number, totalCents: number) {
  const db = await getDb();
  await db.runAsync(`UPDATE work_days SET status = 'closed', order_count = ?, total_cents = ? WHERE id = ?`, [
    orderCount,
    totalCents,
    localId,
  ]);
}

export async function listClosedWorkDays(userId?: string): Promise<WorkDay[]> {
  const db = await getDb();
  const rows = userId
    ? await db.getAllAsync<any>(
        `SELECT * FROM work_days WHERE user_id = ? AND status = 'closed' ORDER BY work_date DESC`,
        [userId]
      )
    : await db.getAllAsync<any>(
        `SELECT * FROM work_days WHERE status = 'closed' ORDER BY work_date DESC`
      );
  return rows.map((r) => ({ ...r, local_id: r.id }));
}

/** Elimina la copia local después de que el backend confirmó borrar el histórico. */
export async function deleteClosedWorkDayLocal(localId: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE work_day_id = ?)`, [localId]);
    await db.runAsync(`DELETE FROM orders WHERE work_day_id = ?`, [localId]);
    await db.runAsync(`DELETE FROM work_days WHERE id = ? AND status = 'closed'`, [localId]);
  });
}

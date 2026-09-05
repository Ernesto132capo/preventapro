import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "./client";

export type OutboxEntity = "client" | "product" | "order";
export type OrderOperation = "create" | "update" | "cancel";

export async function enqueue(entityType: OutboxEntity, localEntityId: string, priority = 2, operation: OrderOperation = "create") {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO outbox (id, entity_type, local_entity_id, operation, priority, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [uuid(), entityType, localEntityId, operation, priority, nowIso()]
  );
}

export interface OutboxRow {
  id: string;
  entity_type: OutboxEntity;
  local_entity_id: string;
  operation: OrderOperation;
  priority: number;
  status: "pending" | "syncing" | "failed" | "done";
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export async function listPending(): Promise<OutboxRow[]> {
  const db = await getDb();
  return db.getAllAsync<OutboxRow>(
    // Si la app se cerró durante un envío, la fila puede quedar en "syncing".
    // Se debe reintentar: todas las escrituras de preventa son idempotentes.
    `SELECT * FROM outbox WHERE status IN ('pending','syncing','failed') ORDER BY priority ASC, created_at ASC`
  );
}

export async function markDone(id: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE outbox SET status = 'done' WHERE id = ?`, [id]);
}

export async function markFailed(id: string, error: string) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
    [error, id]
  );
}

export async function markSyncing(id: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE outbox SET status = 'syncing' WHERE id = ?`, [id]);
}

// Deja la fila como 'pending' de nuevo sin contar como fallo — se usa cuando una
// dependencia (ej. el cliente de una preventa) todavía no se sincronizó en esta pasada.
export async function deferForDependency(id: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE outbox SET status = 'pending' WHERE id = ?`, [id]);
}

export async function countPending(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) as n FROM outbox WHERE status IN ('pending','syncing','failed')`
  );
  return row?.n ?? 0;
}

// Trae los mensajes de error reales guardados en filas que quedaron en 'failed',
// para poder mostrárselos al usuario en vez de que la sincronización parezca "exitosa".
export async function getFailedErrors(): Promise<{ entity_type: OutboxEntity; last_error: string | null }[]> {
  const db = await getDb();
  return db.getAllAsync<{ entity_type: OutboxEntity; last_error: string | null }>(
    `SELECT entity_type, last_error FROM outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5`
  );
}
// Descarta (marca como 'done', sin subir) los ítems que quedaron trabados con error de
// validación — ej. datos mal cargados que el servidor rechaza siempre. No hay UI de edición
// todavía, así que esta es la forma de "destrabar" la cola sin tener que reinstalar la app.
export async function discardFailed(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(`UPDATE outbox SET status = 'done' WHERE status = 'failed'`);
  return result.changes ?? 0;
}

import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "./client";

export type OutboxEntity = "client" | "product" | "order" | "category";
export type OrderOperation = "create" | "update" | "cancel" | "delete";

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
  status: "pending" | "syncing" | "failed" | "error" | "done";
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
  // El handler envía el estado local actual, así que una operación exitosa también
  // resuelve errores antiguos de la misma entidad que ya quedaron obsoletos.
  await db.runAsync(
    `UPDATE outbox SET status = 'done', last_error = NULL
     WHERE id = ? OR (
       status IN ('failed', 'error')
       AND entity_type = (SELECT entity_type FROM outbox WHERE id = ?)
       AND local_entity_id = (SELECT local_entity_id FROM outbox WHERE id = ?)
     )`,
    [id, id, id]
  );
}

export async function markFailed(id: string, error: string) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
    [error, id]
  );
}

/** Marca un error permanente (por ejemplo, una validación 4xx) para que no se reintente en cada sync. */
export async function markPermanentError(id: string, error: string) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET status = 'error', attempts = attempts + 1, last_error = ? WHERE id = ?`,
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

/** Conserva la fila pendiente para reintentarla más tarde y registra el último error temporal. */
export async function deferForRetry(id: string, error: string) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?`,
    [error, id]
  );
}

export async function countPending(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) as n FROM outbox WHERE status IN ('pending','syncing','failed')`
  );
  return row?.n ?? 0;
}

/** Cuenta todas las operaciones aún no resueltas, incluidas las que requieren corrección. */
export async function countUnresolvedOutboxItems(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) as n FROM outbox WHERE status <> 'done'`
  );
  return row?.n ?? 0;
}

// Trae los mensajes de error guardados en filas fallidas o con error permanente,
// para poder mostrárselos al usuario en vez de que la sincronización parezca "exitosa".
export async function getFailedErrors(): Promise<{ entity_type: OutboxEntity; last_error: string | null }[]> {
  const db = await getDb();
  return db.getAllAsync<{ entity_type: OutboxEntity; last_error: string | null }>(
    `SELECT entity_type, last_error FROM outbox WHERE status IN ('failed', 'error') ORDER BY created_at DESC LIMIT 5`
  );
}
// Descarta (marca como 'done', sin subir) los ítems que quedaron trabados con error de
// validación — ej. datos mal cargados que el servidor rechaza siempre. No hay UI de edición
// todavía, así que esta es la forma de "destrabar" la cola sin tener que reinstalar la app.
export async function discardFailed(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(`UPDATE outbox SET status = 'done', last_error = NULL WHERE status IN ('failed', 'error')`);
  return result.changes ?? 0;
}

import { v4 as uuid } from "uuid";
import type { SQLiteDatabase } from "expo-sqlite";
import { getDb, nowIso } from "./client";

export type OutboxEntity = "client" | "product" | "order" | "category";
export type OrderOperation = "create" | "update" | "cancel" | "delete";

export async function enqueue(entityType: OutboxEntity, localEntityId: string, priority = 2, operation: OrderOperation = "create") {
  const db = await getDb();
  return enqueueInTx(db, entityType, localEntityId, priority, operation);
}

/** Usa la misma conexión/transacción que la escritura del registro local. */
export async function enqueueInTx(db: SQLiteDatabase, entityType: OutboxEntity, localEntityId: string, priority = 2, operation: OrderOperation = "create") {
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
  next_retry_at?: string | null;
  completed_at?: string | null;
}

export async function listPending(): Promise<OutboxRow[]> {
  const db = await getDb();
  return db.getAllAsync<OutboxRow>(
    // Si la app se cerró durante un envío, la fila puede quedar en "syncing".
    // Se debe reintentar: todas las escrituras de preventa son idempotentes.
    `SELECT * FROM outbox WHERE status IN ('pending','syncing','failed')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY priority ASC, created_at ASC`,
    [nowIso()]
  );
}

export async function markDone(id: string) {
  const db = await getDb();
  // El handler envía el estado local actual, así que una operación exitosa también
  // resuelve errores antiguos de la misma entidad que ya quedaron obsoletos.
  await db.runAsync(
    `UPDATE outbox SET status = 'done', last_error = NULL,
       next_retry_at = NULL, completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
    `UPDATE outbox SET status = 'error', attempts = attempts + 1, last_error = ?, next_retry_at = NULL WHERE id = ?`,
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
  await db.runAsync(`UPDATE outbox SET status = 'pending', next_retry_at = NULL WHERE id = ?`, [id]);
}

/** Conserva la fila pendiente para reintentarla más tarde y registra el último error temporal. */
export async function deferForRetry(id: string, error: string) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ attempts: number }>(`SELECT attempts FROM outbox WHERE id = ?`, [id]);
  const delayMs = retryDelayMs(row?.attempts ?? 0);
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  await db.runAsync(
    `UPDATE outbox SET status = 'pending', attempts = attempts + 1, last_error = ?, next_retry_at = ? WHERE id = ?`,
    [error, retryAt, id]
  );
}

/** Los errores de red se reintentan indefinidamente, con espera de 30 s a 15 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(Math.max(0, attempts), 5));
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
// Descarta (marca como 'done', sin subir) únicamente los ítems que quedaron trabados con error
// permanente de validación (status = 'error'). NO descarta filas reintentables ('failed').
// Actualiza coherentemente el sync_status del pedido asociado para no dejarlo en un estado inconsistente.
export async function discardFailed(): Promise<number> {
  const db = await getDb();
  const errorOrders = await db.getAllAsync<{ local_entity_id: string }>(
    `SELECT local_entity_id FROM outbox WHERE status = 'error' AND entity_type = 'order'`
  );
  for (const o of errorOrders) {
    await db.runAsync(`UPDATE orders SET sync_status = 'failed', sync_error = 'Descartado por validación' WHERE id = ?`, [o.local_entity_id]);
  }
  const result = await db.runAsync(`UPDATE outbox SET status = 'done', last_error = NULL WHERE status = 'error'`);
  return result.changes ?? 0;
}

/** Reintenta todos los ítems fallidos o en error devolviéndolos a estado 'pending'. */
export async function retryFailed(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(`UPDATE outbox SET status = 'pending', attempts = 0, next_retry_at = NULL WHERE status IN ('failed', 'error')`);
  return result.changes ?? 0;
}

/**
 * Normaliza filas que hayan quedado en estado 'error' a 'failed'
 * para que sean recuperadas y reintentadas en la sincronización.
 */
export async function normalizeOutboxErrors(): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(`UPDATE outbox SET status = 'failed' WHERE status = 'error'`);
  return res.changes ?? 0;
}

/**
 * Purga o marca como 'done' todos los eventos de outbox asociados a una entidad local específica
 * (por ejemplo al eliminar un cliente, para que eventos previos 'create' o 'update' no sigan fallando).
 */
export async function purgeOutboxForEntity(entityType: OutboxEntity, localEntityId: string): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE outbox SET status = 'done', last_error = NULL
     WHERE entity_type = ? AND local_entity_id = ? AND status <> 'done'`,
    [entityType, localEntityId]
  );
  return result.changes ?? 0;
}

/** Solo elimina eventos completados; nunca pendientes, errores ni sus entidades. */
export async function purgeCompletedOutbox(retentionDays = 30): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("La retención debe ser al menos de un día.");
  const db = await getDb();
  // Los eventos legacy completados empiezan a contar su retención desde hoy.
  await db.runAsync(`UPDATE outbox SET completed_at = ? WHERE status = 'done' AND completed_at IS NULL`, [nowIso()]);
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = await db.runAsync(`DELETE FROM outbox WHERE status = 'done' AND completed_at < ?`, [cutoff]);
  return result.changes ?? 0;
}


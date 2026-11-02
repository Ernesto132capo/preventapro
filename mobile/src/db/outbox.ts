import { v4 as uuid } from "uuid";
import type { SQLiteDatabase } from "expo-sqlite";
import { getDb, nowIso } from "./client";

export type OutboxEntity = "client" | "product" | "order" | "category";
export type OrderOperation = "create" | "update" | "cancel" | "delete" | "restore";

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
  status: "pending" | "syncing" | "failed" | "error" | "conflict" | "done";
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_retry_at?: string | null;
  completed_at?: string | null;
}

/** Counts operations, including permanent errors that need a local correction. */
export interface OutboxSummary {
  total: number;
  pending: number;
  syncing: number;
  failed: number;
  error: number;
  conflict: number;
}

export interface OutboxDetail extends OutboxRow {
  entity_name: string;
  entity_subtitle: string | null;
  entity_exists: number;
  entity_active: number;
}

export async function getOutboxSummary(): Promise<OutboxSummary> {
  const db = await getDb();
  const row = await db.getFirstAsync<OutboxSummary>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'syncing' THEN 1 ELSE 0 END), 0) AS syncing,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
       COALESCE(SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END), 0) AS conflict
     FROM outbox WHERE status <> 'done'`
  );
  return row ?? { total: 0, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 0 };
}

/** Read-only pages: left joins keep operations whose local record disappeared visible. */
export async function listOutboxDetails(options: { offset?: number; limit?: number; errorsOnly?: boolean } = {}): Promise<OutboxDetail[]> {
  const db = await getDb();
  const offset = Number.isFinite(options.offset)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(options.offset!))) : 0;
  const limit = Number.isFinite(options.limit)
    ? Math.min(100, Math.max(1, Math.trunc(options.limit!))) : 30;
  return db.getAllAsync<OutboxDetail>(
    `SELECT q.*,
       CASE q.entity_type
         WHEN 'order' THEN CASE WHEN ord.id IS NULL THEN 'Preventa no disponible'
           ELSE 'Preventa · ' || COALESCE(NULLIF(TRIM(ord.client_name), ''), 'Cliente') END
         WHEN 'client' THEN CASE WHEN cl.id IS NULL THEN 'Cliente no disponible'
           ELSE COALESCE(NULLIF(TRIM(cl.business_name), ''), NULLIF(TRIM(cl.name), ''),
             NULLIF(TRIM(cl.contact_name), ''), NULLIF(TRIM(cl.owner_name), ''), 'Cliente sin nombre') END
         WHEN 'product' THEN COALESCE(NULLIF(TRIM(pr.name), ''), 'Producto no disponible')
         WHEN 'category' THEN COALESCE(NULLIF(TRIM(cat.name), ''), 'Categoría no disponible')
         ELSE 'Registro no disponible'
       END AS entity_name,
       CASE q.entity_type
         WHEN 'order' THEN 'Ref. ' || SUBSTR(q.local_entity_id, 1, 8) ||
           COALESCE(' · ' || STRFTIME('%d/%m/%Y %H:%M', ord.created_at, '-4 hours'), '')
         WHEN 'client' THEN CASE
           WHEN COALESCE(NULLIF(TRIM(cl.business_name), ''), NULLIF(TRIM(cl.name), '')) IS NOT NULL
             THEN COALESCE(NULLIF(TRIM(cl.contact_name), ''), NULLIF(TRIM(cl.owner_name), ''), NULLIF(TRIM(cl.phone), ''))
           ELSE NULLIF(TRIM(cl.phone), '') END
         WHEN 'product' THEN NULLIF(TRIM(pr.sku), '')
         ELSE NULL
       END AS entity_subtitle,
       CASE q.entity_type
         WHEN 'order' THEN CASE WHEN ord.id IS NULL THEN 0 ELSE 1 END
         WHEN 'client' THEN CASE WHEN cl.id IS NULL THEN 0 ELSE 1 END
         WHEN 'product' THEN CASE WHEN pr.id IS NULL THEN 0 ELSE 1 END
         WHEN 'category' THEN CASE WHEN cat.id IS NULL THEN 0 ELSE 1 END
         ELSE 0
       END AS entity_exists,
       CASE q.entity_type
         WHEN 'order' THEN CASE WHEN ord.status = 'active' THEN 1 ELSE 0 END
         WHEN 'client' THEN CASE WHEN cl.active = 1 THEN 1 ELSE 0 END
         WHEN 'product' THEN CASE WHEN pr.active = 1 THEN 1 ELSE 0 END
         WHEN 'category' THEN CASE WHEN cat.active = 1 THEN 1 ELSE 0 END
         ELSE 0
       END AS entity_active
     FROM outbox q
     LEFT JOIN orders ord ON q.entity_type = 'order' AND ord.id = q.local_entity_id
     LEFT JOIN clients cl ON q.entity_type = 'client' AND cl.id = q.local_entity_id
     LEFT JOIN products pr ON q.entity_type = 'product' AND pr.id = q.local_entity_id
     LEFT JOIN categories cat ON q.entity_type = 'category' AND cat.id = q.local_entity_id
     WHERE q.status IN (${options.errorsOnly ? "'failed','error','conflict'" : "'pending','syncing','failed','error','conflict'"})
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
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

/** Capturar dentro de la misma transacción que los datos que se enviarán. */
export async function captureOutboxSnapshot(db: SQLiteDatabase, row: OutboxRow): Promise<string[]> {
  const events = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM outbox WHERE entity_type = ? AND local_entity_id = ? AND status <> 'done'`,
    [row.entity_type, row.local_entity_id]
  );
  return events.map(event => event.id);
}

/** Un ACK solo confirma su foto local; una edición durante HTTP conserva su evento. */
export async function completeOutboxSnapshot(db: SQLiteDatabase, row: OutboxRow, eventIds: string[], serverId?: string | null) {
  for (const id of eventIds) {
    await db.runAsync(
      `UPDATE outbox SET status = 'done', last_error = NULL, next_retry_at = NULL, completed_at = ? WHERE id = ?`,
      [nowIso(), id]
    );
  }
  const pending = await hasUnresolvedOutbox(db, row.entity_type, row.local_entity_id);
  const table = { category: 'categories', client: 'clients', product: 'products', order: 'orders' }[row.entity_type];
  await db.runAsync(
    `UPDATE ${table} SET sync_status = ?${serverId ? ', server_id = ?' : ''}${row.entity_type === 'order' ? ', sync_error = NULL' : ''} WHERE id = ?`,
    [pending ? 'pending' : 'synced', ...(serverId ? [serverId] : []), row.local_entity_id]
  );
}

export async function hasUnresolvedOutbox(db: SQLiteDatabase, entityType: OutboxEntity, localId: string): Promise<boolean> {
  return !!(await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM outbox WHERE entity_type = ? AND local_entity_id = ? AND status <> 'done' LIMIT 1`,
    [entityType, localId]
  ));
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

/** Marca un conflicto de registro eliminado: no se reintenta ni se descarta automáticamente. */
export async function markConflict(id: string, error: string) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET status = 'conflict', last_error = ?, next_retry_at = NULL WHERE id = ?`,
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


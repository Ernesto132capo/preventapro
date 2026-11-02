import { v4 as uuid } from "uuid";
import { getDb, nowIso, withTx } from "./client";
import type { OutboxEntity } from "./outbox";

export interface SyncConflict {
  id: string;
  entity_type: OutboxEntity;
  local_entity_id: string;
  server_id: string | null;
  outbox_id: string | null;
  entity_name: string | null;
  server_updated_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

const TABLE: Record<"client" | "product" | "category", string> = {
  client: "clients",
  product: "products",
  category: "categories",
};

const LABEL: Record<"client" | "product" | "category", string> = {
  client: "cliente",
  product: "producto",
  category: "categoría",
};

function nameColumn(entityType: "client" | "product" | "category"): string {
  return entityType === "client" ? "COALESCE(NULLIF(TRIM(business_name), ''), NULLIF(TRIM(name), ''), 'Cliente')" : "name";
}

/** Registra de forma persistente el conflicto y deja el outbox en estado 'conflict'. */
export async function recordEntityDeletedConflict(input: {
  entityType: "client" | "product" | "category";
  localEntityId: string;
  serverId?: string | null;
  outboxId?: string | null;
  serverUpdatedAt?: string | null;
}): Promise<void> {
  const db = await getDb();
  const table = TABLE[input.entityType];
  const row = await db.getFirstAsync<{ name: string | null }>(
    `SELECT ${nameColumn(input.entityType)} AS name FROM ${table} WHERE id = ?`,
    [input.localEntityId]
  );
  const message = `Este ${LABEL[input.entityType]} fue eliminado desde otro dispositivo. Conservamos los cambios que hiciste.`;
  await withTx(async (txDb) => {
    await txDb.runAsync(
      `INSERT INTO sync_conflicts (id, entity_type, local_entity_id, server_id, outbox_id, entity_name, server_updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), input.entityType, input.localEntityId, input.serverId ?? null, input.outboxId ?? null, row?.name ?? null, input.serverUpdatedAt ?? null, nowIso()]
    );
    if (input.outboxId) {
      await txDb.runAsync(`UPDATE outbox SET status = 'conflict', last_error = ?, next_retry_at = NULL WHERE id = ?`, [message, input.outboxId]);
    }
    await txDb.runAsync(`UPDATE ${table} SET sync_status = 'failed' WHERE id = ?`, [input.localEntityId]);
  });
}

export async function listOpenConflicts(): Promise<SyncConflict[]> {
  const db = await getDb();
  return db.getAllAsync<SyncConflict>(`SELECT * FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC`);
}

export async function getConflict(conflictId: string): Promise<SyncConflict | null> {
  const db = await getDb();
  return db.getFirstAsync<SyncConflict>(`SELECT * FROM sync_conflicts WHERE id = ?`, [conflictId]);
}

/** Cierra cualquier conflicto abierto asociado a un evento de outbox (tras una restauración exitosa). */
export async function markConflictResolvedByOutbox(outboxId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE sync_conflicts SET resolved_at = ? WHERE outbox_id = ? AND resolved_at IS NULL`, [nowIso(), outboxId]);
}

export async function getConflictByOutboxId(outboxId: string): Promise<SyncConflict | null> {
  const db = await getDb();
  return db.getFirstAsync<SyncConflict>(`SELECT * FROM sync_conflicts WHERE outbox_id = ? AND resolved_at IS NULL LIMIT 1`, [outboxId]);
}

/** Resuelve "Mantener eliminado": refleja la baja local y cierra el conflicto y su outbox. */
export async function resolveKeepDeleted(conflictId: string): Promise<void> {
  const conflict = await getConflict(conflictId);
  if (!conflict) return;
  const table = TABLE[conflict.entity_type as "client" | "product" | "category"];
  await withTx(async (txDb) => {
    await txDb.runAsync(`UPDATE ${table} SET active = 0, sync_status = 'synced' WHERE id = ?`, [conflict.local_entity_id]);
    if (conflict.outbox_id) {
      await txDb.runAsync(`UPDATE outbox SET status = 'done', last_error = NULL, completed_at = ? WHERE id = ?`, [nowIso(), conflict.outbox_id]);
    }
    await txDb.runAsync(`UPDATE sync_conflicts SET resolved_at = ? WHERE id = ?`, [nowIso(), conflictId]);
  });
}

/** Prepara la restauración: devuelve el outbox a 'pending' con operación 'restore'. */
export async function prepareConflictRestore(conflictId: string): Promise<SyncConflict | null> {
  const conflict = await getConflict(conflictId);
  if (!conflict || !conflict.outbox_id) return conflict;
  await withTx(async (txDb) => {
    await txDb.runAsync(`UPDATE outbox SET status = 'pending', operation = 'restore', next_retry_at = NULL WHERE id = ?`, [conflict.outbox_id]);
  });
  return conflict;
}

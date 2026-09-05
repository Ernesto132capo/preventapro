import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "../client";
import { enqueue } from "../outbox";
import { Client } from "../../domain/types";

export async function listActiveClients(search?: string): Promise<Client[]> {
  const db = await getDb();
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    return db.getAllAsync<Client>(
      `SELECT * FROM clients WHERE active = 1 AND (business_name LIKE ? OR contact_name LIKE ? OR phone LIKE ?)
       ORDER BY business_name COLLATE NOCASE ASC`,
      [q, q, q]
    );
  }
  return db.getAllAsync<Client>(`SELECT * FROM clients WHERE active = 1 ORDER BY business_name COLLATE NOCASE ASC`);
}

export async function getClient(id: string): Promise<Client | null> {
  const db = await getDb();
  return db.getFirstAsync<Client>(`SELECT * FROM clients WHERE id = ?`, [id]);
}

export interface QuickClientInput {
  businessName: string;
  contactName?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lng?: number;
}

/** Alta rápida de cliente (Fase 8) — funciona 100% offline. Se encola para sincronizar. */
export async function createClientLocal(input: QuickClientInput): Promise<Client> {
  if (!input.businessName?.trim()) {
    throw new Error("El nombre del negocio es obligatorio.");
  }
  const db = await getDb();
  const id = uuid();
  const ts = nowIso();
  await db.runAsync(
    `INSERT INTO clients
      (id, business_name, contact_name, phone, address, lat, lng, visit_status, active, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 'pending', ?, ?)`,
    [id, input.businessName.trim(), input.contactName || null, input.phone || null, input.address || null, input.lat ?? null, input.lng ?? null, ts, ts]
  );
  await enqueue("client", id, 1);
  const client = await getClient(id);
  return client!;
}

/** Edita un cliente ya existente (creado offline o ya sincronizado). Se re-encola para reflejar el cambio en el servidor. */
export async function updateClientLocal(id: string, input: QuickClientInput): Promise<Client> {
  if (!input.businessName?.trim()) {
    throw new Error("El nombre del negocio es obligatorio.");
  }
  const db = await getDb();
  const existing = await getClient(id);
  if (!existing) throw new Error("Cliente no encontrado.");

  await db.runAsync(
    `UPDATE clients SET
       business_name = ?, contact_name = ?, phone = ?, address = ?, lat = ?, lng = ?,
       sync_status = 'pending', updated_at = ?
     WHERE id = ?`,
    [
      input.businessName.trim(),
      input.contactName || null,
      input.phone || null,
      input.address || null,
      input.lat ?? null,
      input.lng ?? null,
      nowIso(),
      id,
    ]
  );
  await enqueue("client", id, 1);
  return (await getClient(id))!;
}

/** Borrado (soft delete) de un cliente. Nunca se elimina físicamente para no perder historial de preventas. */
export async function deleteClientLocal(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE clients SET active = 0, sync_status = 'pending', updated_at = ? WHERE id = ?`,
    [nowIso(), id]
  );
  await enqueue("client", id, 1);
}

export async function setVisitStatus(id: string, status: "pending" | "visited") {
  const db = await getDb();
  await db.runAsync(`UPDATE clients SET visit_status = ?, updated_at = ? WHERE id = ?`, [status, nowIso(), id]);
}

/** Usado por el motor de sync al hacer pull: inserta o actualiza clientes que vinieron del servidor. */
export async function upsertFromServer(serverClient: any) {
  const db = await getDb();
  const localMatch = serverClient.client_local_id
    ? await db.getFirstAsync<{ id: string }>(`SELECT id FROM clients WHERE id = ?`, [serverClient.client_local_id])
    : null;

  const targetId = localMatch ? localMatch.id : serverClient.id;

  await db.runAsync(
    `INSERT INTO clients
      (id, server_id, business_name, contact_name, phone, neighborhood_id, neighborhood_name, address, lat, lng,
       visit_status, active, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       server_id = excluded.server_id, business_name = excluded.business_name, contact_name = excluded.contact_name,
       phone = excluded.phone, neighborhood_id = excluded.neighborhood_id, neighborhood_name = excluded.neighborhood_name,
       address = excluded.address, lat = excluded.lat, lng = excluded.lng, visit_status = excluded.visit_status,
       active = excluded.active, sync_status = 'synced', updated_at = excluded.updated_at`,
    [
      targetId,
      serverClient.id,
      serverClient.business_name || "",
      serverClient.contact_name ?? null,
      serverClient.phone ?? null,
      serverClient.neighborhood_id ?? null,
      serverClient.neighborhood_name ?? null,
      serverClient.address ?? null,
      serverClient.lat ?? null,
      serverClient.lng ?? null,
      serverClient.visit_status || "pending",
      serverClient.active ?? 1,
      serverClient.created_at || nowIso(),
      serverClient.updated_at || nowIso(),
    ]
  );
}

export async function markClientSynced(localId: string, serverId: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE clients SET server_id = ?, sync_status = 'synced' WHERE id = ?`, [serverId, localId]);
}

export async function resolveServerClientId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ server_id: string | null; id: string; sync_status: string }>(
    `SELECT id, server_id, sync_status FROM clients WHERE id = ?`,
    [localId]
  );
  if (!row) return null;
  if (row.server_id) return row.server_id;
  return row.sync_status === "synced" ? row.id : null;
}

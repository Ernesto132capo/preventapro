import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "../client";
import { enqueue } from "../outbox";
import { Category } from "../../domain/types";

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  return db.getAllAsync<Category>(`SELECT * FROM categories WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`);
}

export async function getCategory(id: string): Promise<Category | null> {
  const db = await getDb();
  return db.getFirstAsync<Category>(`SELECT * FROM categories WHERE id = ? OR server_id = ?`, [id, id]);
}

export async function createCategoryLocal(name: string): Promise<Category> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre de la categoría es obligatorio.");

  const db = await getDb();
  const existing = await db.getFirstAsync<Category>(
    `SELECT * FROM categories WHERE lower(name) = lower(?)`,
    [trimmed]
  );

  const ts = nowIso();
  if (existing) {
    if (existing.active === 0) {
      await db.runAsync(
        `UPDATE categories SET active = 1, sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [ts, existing.id]
      );
      await enqueue("category", existing.id, 1);
      return (await getCategory(existing.id))!;
    }
    return existing;
  }

  const id = uuid();
  await db.runAsync(
    `INSERT INTO categories (id, name, active, sync_status, updated_at) VALUES (?, ?, 1, 'pending', ?)`,
    [id, trimmed, ts]
  );

  await enqueue("category", id, 1);
  return (await getCategory(id))!;
}

export async function updateCategoryLocal(id: string, name: string): Promise<Category> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre de la categoría es obligatorio.");

  const db = await getDb();
  const ts = nowIso();
  await db.runAsync(
    `UPDATE categories SET name = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
    [trimmed, ts, id]
  );

  await enqueue("category", id, 1, "update");
  return (await getCategory(id))!;
}

export async function deleteCategoryLocal(id: string): Promise<void> {
  const db = await getDb();
  const ts = nowIso();
  await db.runAsync(
    `UPDATE categories SET active = 0, sync_status = 'pending', updated_at = ? WHERE id = ?`,
    [ts, id]
  );
  await enqueue("category", id, 1, "delete");
}

export async function upsertCategoryFromServer(serverCat: any): Promise<void> {
  const db = await getDb();
  const existing = await db.getFirstAsync<Category>(
    `SELECT * FROM categories WHERE server_id = ? OR id = ? OR lower(name) = lower(?)`,
    [serverCat.id, serverCat.id, (serverCat.name || "").trim()]
  );

  const targetId = existing ? existing.id : serverCat.id;

  await db.runAsync(
    `INSERT INTO categories (id, server_id, name, active, sync_status, updated_at)
     VALUES (?, ?, ?, ?, 'synced', ?)
     ON CONFLICT(id) DO UPDATE SET
       server_id = excluded.server_id,
       name = excluded.name,
       active = excluded.active,
       sync_status = 'synced',
       updated_at = excluded.updated_at`,
    [
      targetId,
      serverCat.id,
      serverCat.name || "",
      serverCat.active ?? 1,
      serverCat.updated_at || nowIso(),
    ]
  );
}

export async function resolveServerCategoryId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; server_id: string | null; sync_status: string }>(
    `SELECT id, server_id, sync_status FROM categories WHERE id = ? OR server_id = ?`,
    [localId, localId]
  );
  if (row) {
    if (row.server_id) return row.server_id;
    if (row.sync_status === "synced") return row.id;
  }
  return null;
}

import { v4 as uuid } from "uuid";
import { getDb, nowIso, withTx } from "../client";
import { enqueue, hasUnresolvedOutbox } from "../outbox";
import { Category } from "../../domain/types";

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  return db.getAllAsync<Category>(`SELECT * FROM categories WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`);
}

export async function getCategory(id: string): Promise<Category | null> {
  const db = await getDb();
  return db.getFirstAsync<Category>(
    `SELECT * FROM categories WHERE id = ? OR server_id = ? OR lower(name) = lower(?)`,
    [id, id, id]
  );
}

export async function createCategoryLocal(name: string): Promise<Category> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre de la categoría es obligatorio.");

  const db = await getDb();
  let targetId = "";

  await withTx(async () => {
    const existing = await db.getFirstAsync<Category>(
      `SELECT * FROM categories WHERE lower(name) = lower(?)`,
      [trimmed]
    );

    const ts = nowIso();
    if (existing) {
      targetId = existing.id;
      if (existing.active === 0) {
        await db.runAsync(
          `UPDATE categories SET active = 1, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [ts, existing.id]
        );
        await enqueue("category", existing.id, 1, "update");
      }
      return;
    }

    const id = uuid();
    await db.runAsync(
      `INSERT INTO categories (id, name, active, sync_status, updated_at) VALUES (?, ?, 1, 'pending', ?)`,
      [id, trimmed, ts]
    );

    await enqueue("category", id, 1, "create");
    targetId = id;
  });

  return (await getCategory(targetId))!;
}

export async function updateCategoryLocal(id: string, name: string): Promise<Category> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre de la categoría es obligatorio.");

  const db = await getDb();
  const existing = await db.getFirstAsync<Category>(
    `SELECT id, server_id FROM categories WHERE id = ? OR server_id = ?`,
    [id, id]
  );
  if (!existing) throw new Error("Categoría no encontrada.");
  const localId = existing.id;

  const ts = nowIso();
  await withTx(async () => {
    await db.runAsync(
      `UPDATE categories SET name = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
      [trimmed, ts, localId]
    );

    await enqueue("category", localId, 1, "update");
  });

  return (await getCategory(localId))!;
}

export async function deleteCategoryLocal(id: string): Promise<void> {
  const db = await getDb();
  const ts = nowIso();

  await withTx(async () => {
    const existing = await db.getFirstAsync<Category>(
      `SELECT id, server_id FROM categories WHERE id = ? OR server_id = ?`,
      [id, id]
    );
    if (!existing) return;

    await db.runAsync(
      `UPDATE categories SET active = 0, sync_status = 'pending', updated_at = ? WHERE id = ?`,
      [ts, existing.id]
    );

    // Desasociar productos que apunten a esta categoría (tanto por id local como por server_id)
    if (existing.server_id) {
      await db.runAsync(
        `UPDATE products SET category_id = NULL WHERE category_id = ? OR category_id = ?`,
        [existing.id, existing.server_id]
      );
    } else {
      await db.runAsync(
        `UPDATE products SET category_id = NULL WHERE category_id = ?`,
        [existing.id]
      );
    }

    await enqueue("category", existing.id, 1, "delete");
  });
}

export async function upsertCategoryFromServer(serverCat: any): Promise<void> {
  const db = await getDb();
  const existing = await db.getFirstAsync<Category>(
    `SELECT * FROM categories WHERE server_id = ? OR id = ? OR lower(name) = lower(?)`,
    [serverCat.id, serverCat.id, (serverCat.name || "").trim()]
  );

  const targetId = existing ? existing.id : serverCat.id;

  if (existing && (existing.sync_status !== "synced" || await hasUnresolvedOutbox(db, "category", existing.id))) {
    await db.runAsync(`UPDATE categories SET server_id = ? WHERE id = ?`, [serverCat.id, existing.id]);
    return;
  }

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
  if (serverCat.active === false || serverCat.active === 0) {
    await db.runAsync(`UPDATE products SET category_id = NULL WHERE category_id = ? OR category_id = ?`, [targetId, serverCat.id]);
  }
}

export async function resolveServerCategoryId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; server_id: string | null; name: string }>(
    `SELECT id, server_id, name FROM categories WHERE id = ? OR server_id = ? OR lower(name) = lower(?)`,
    [localId, localId, localId]
  );
  if (row?.server_id) return row.server_id;
  if (row?.name) {
    const match = await db.getFirstAsync<{ server_id: string | null }>(
      `SELECT server_id FROM categories WHERE lower(name) = lower(?) AND server_id IS NOT NULL LIMIT 1`,
      [row.name.trim()]
    );
    if (match?.server_id) return match.server_id;
    return row.name.trim();
  }
  return row?.id || localId;
}

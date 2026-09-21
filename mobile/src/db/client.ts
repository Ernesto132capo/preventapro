import * as SQLite from "expo-sqlite";
import { LOCAL_SCHEMA } from "./schema";

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  const db = await SQLite.openDatabaseAsync("preventapro.db");
  await db.execAsync(LOCAL_SCHEMA);
  // Migración para instalaciones que ya tenían creada la tabla outbox.
  try {
    await db.execAsync("ALTER TABLE outbox ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'");
  } catch {
    // La columna ya existe.
  }
  try {
    await db.execAsync("ALTER TABLE products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'standard'");
  } catch {
    // La columna ya existe.
  }
  try {
    await db.execAsync("ALTER TABLE categories ADD COLUMN server_id TEXT");
  } catch {}
  try {
    await db.execAsync("ALTER TABLE categories ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  } catch {}
  try {
    await db.execAsync("ALTER TABLE categories ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'");
  } catch {}
  try {
    await db.execAsync("ALTER TABLE categories ADD COLUMN updated_at TEXT");
  } catch {}
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS combo_definitions (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        product_id TEXT NOT NULL,
        selection_min INTEGER NOT NULL,
        selection_max INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        sync_status TEXT NOT NULL DEFAULT 'synced'
      );
      CREATE TABLE IF NOT EXISTS combo_options (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        combo_id TEXT NOT NULL,
        presentation_id TEXT NOT NULL,
        max_quantity INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        sync_status TEXT NOT NULL DEFAULT 'synced'
      );
      CREATE TABLE IF NOT EXISTS order_item_selections (
        id TEXT PRIMARY KEY,
        order_item_id TEXT NOT NULL,
        selected_product_id TEXT NOT NULL,
        selected_presentation_id TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        presentation_name_snapshot TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS product_favorites (
        product_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_name ON products (name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
      CREATE INDEX IF NOT EXISTS idx_presentations_product ON product_presentations (product_id);
      CREATE INDEX IF NOT EXISTS idx_clients_name ON clients (business_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);
      CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_work_day ON orders (work_day_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
      CREATE INDEX IF NOT EXISTS idx_order_selections_item ON order_item_selections (order_item_id);
    `);
  } catch {}
  dbInstance = db;
  return db;
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    key,
    value,
  ]);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Borra solo la copia local para recuperar una cola offline corrupta. */
export async function resetLocalDatabase(): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // Ordenado de dependientes a principales; no toca el servidor ni la sesión.
    await db.runAsync(`DELETE FROM order_item_selections`);
    await db.runAsync(`DELETE FROM order_items`);
    await db.runAsync(`DELETE FROM orders`);
    await db.runAsync(`DELETE FROM outbox`);
    await db.runAsync(`DELETE FROM combo_options`);
    await db.runAsync(`DELETE FROM combo_definitions`);
    await db.runAsync(`DELETE FROM product_presentations`);
    await db.runAsync(`DELETE FROM products`);
    await db.runAsync(`DELETE FROM clients`);
    await db.runAsync(`DELETE FROM work_days`);
    await db.runAsync(`DELETE FROM categories`);
    await db.runAsync(`DELETE FROM meta`);
  });
}


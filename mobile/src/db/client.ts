import * as SQLite from "expo-sqlite";
import { LOCAL_INDEXES, LOCAL_SCHEMA } from "./schema";
import { migrateClientsTableIfNeeded } from "./client-migration";

export { migrateClientsTableIfNeeded };

let dbInstance: SQLite.SQLiteDatabase | null = null;
let dbInitialization: Promise<SQLite.SQLiteDatabase> | null = null;

// v1: sync; v2: combos; v3: retiro de stock; v4: nombres flexibles; v5: reintentos y retención del outbox.
const DATABASE_SCHEMA_VERSION = 5;

type ColumnMigration = { name: string; definition: string };

// Columnas que se incorporaron después de las primeras bases locales.
// Se verifican por PRAGMA antes de ALTER TABLE para que la migración sea repetible.
const REQUIRED_ADDITIVE_COLUMNS: Record<string, ColumnMigration[]> = {
  categories: [
    { name: "server_id", definition: "TEXT" },
    { name: "active", definition: "INTEGER NOT NULL DEFAULT 1" },
    { name: "sync_status", definition: "TEXT NOT NULL DEFAULT 'synced'" },
    { name: "updated_at", definition: "TEXT" },
  ],
  products: [{ name: "product_type", definition: "TEXT NOT NULL DEFAULT 'standard'" }],
  outbox: [
    { name: "operation", definition: "TEXT NOT NULL DEFAULT 'create'" },
    { name: "next_retry_at", definition: "TEXT" },
    { name: "completed_at", definition: "TEXT" },
  ],
};

const REQUIRED_COLUMNS: Record<string, string[]> = {
  meta: ["key", "value"],
  categories: ["id", "server_id", "name", "active", "sync_status", "updated_at"],
  clients: [
    "id",
    "server_id",
    "business_name",
    "name",
    "contact_name",
    "owner_name",
    "phone",
    "neighborhood_id",
    "neighborhood_name",
    "address",
    "lat",
    "lng",
    "visit_status",
    "active",
    "sync_status",
    "created_at",
    "updated_at",
  ],
  products: ["id", "server_id", "sku", "name", "category_id", "base_cost_cents", "base_unit_name", "active", "promo_active", "product_type", "sync_status"],
  combo_definitions: ["id", "server_id", "product_id", "selection_min", "selection_max", "active", "sync_status"],
  combo_options: ["id", "server_id", "combo_id", "presentation_id", "max_quantity", "sort_order", "active", "sync_status"],
  product_presentations: ["id", "server_id", "product_id", "name", "sort_order", "unit_equivalence", "price_cents", "cost_cents", "active"],
  work_days: ["id", "server_id", "user_id", "work_date", "status", "order_count", "total_cents", "sync_status", "created_at"],
  orders: ["id", "server_id", "work_day_id", "client_id", "client_name", "payment_condition", "subtotal_cents", "tax_cents", "total_cents", "item_count", "status", "sync_status", "sync_error", "created_at", "updated_at"],
  order_items: ["id", "order_id", "product_id", "presentation_id", "product_name_snapshot", "sku_snapshot", "presentation_name_snapshot", "unit_equivalence_snapshot", "unit_price_cents_snapshot", "quantity", "subtotal_cents"],
  order_item_selections: ["id", "order_item_id", "selected_product_id", "selected_presentation_id", "product_name_snapshot", "presentation_name_snapshot", "quantity", "sort_order"],
  product_favorites: ["product_id", "created_at"],
  outbox: ["id", "entity_type", "operation", "local_entity_id", "priority", "status", "attempts", "last_error", "next_retry_at", "completed_at", "created_at"],
};

async function tableColumnNames(db: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(columns.map((column) => column.name));
}

async function ensureRequiredColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const [table, additions] of Object.entries(REQUIRED_ADDITIVE_COLUMNS)) {
    const names = await tableColumnNames(db, table);
    for (const column of additions) {
      if (names.has(column.name)) continue;
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
      names.add(column.name);
    }
  }
}

async function verifyRequiredColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const names = await tableColumnNames(db, table);
    const missing = required.filter((column) => !names.has(column));
    if (missing.length > 0) {
      throw new Error(`Esquema SQLite incompleto en ${table}; faltan columnas: ${missing.join(", ")}.`);
    }
  }
}

async function removeLegacyStockColumn(db: SQLite.SQLiteDatabase): Promise<boolean> {
  const names = await tableColumnNames(db, "product_presentations");
  if (!names.has("quantity_available")) return true;
  try {
    await db.execAsync("ALTER TABLE product_presentations DROP COLUMN quantity_available");
    return true;
  } catch (error) {
    // La columna ya no se usa. En SQLite antiguos se conserva, pero no se recrea
    // ni se pierde ninguna presentación o preventa por una incompatibilidad DDL.
    console.warn("No se pudo quitar la columna local quantity_available; se conservará sin uso.", error);
    return false;
  }
}

let txQueue: Promise<void> = Promise.resolve();

export async function withTx<T>(
  task: (db: SQLite.SQLiteDatabase) => Promise<T>,
  existingDb?: SQLite.SQLiteDatabase
): Promise<T> {
  const db = existingDb || (await getDb());
  const prev = txQueue;
  let release!: () => void;
  txQueue = new Promise<void>((resolve) => (release = resolve));

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    timer = setTimeout(() => {
      console.warn("withTx: Espera por la cola de transacciones superó 10 segundos. Posible anidamiento o transacción bloqueada.");
    }, 10000);
  }

  await prev;
  if (timer) clearTimeout(timer);

  try {
    await db.execAsync("BEGIN IMMEDIATE");
    try {
      const result = await task(db);
      await db.execAsync("COMMIT");
      return result;
    } catch (err) {
      try { await db.execAsync("ROLLBACK"); } catch {}
      throw err;
    }
  } finally {
    release();
  }
}

async function initializeDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("preventapro.db");
  await db.execAsync(LOCAL_SCHEMA);

  await migrateClientsTableIfNeeded(db);

  const versionRows = await db.getAllAsync<{ user_version: number }>("PRAGMA user_version");
  const currentVersion = Number(versionRows[0]?.user_version ?? 0);
  await withTx(async () => {
    // Se comprueba cada columna para reparar también instalaciones en las que
    // una versión anterior dejó la migración a medio aplicar.
    await ensureRequiredColumns(db);
    // La verificación de columnas hace segura la operación incluso cuando el
    // campo ya fue retirado o una versión anterior no pudo hacerlo.
    const stockMigrationComplete = await removeLegacyStockColumn(db);
    await verifyRequiredColumns(db);
    const nextVersion = stockMigrationComplete
      ? Math.max(currentVersion, DATABASE_SCHEMA_VERSION)
      : currentVersion;
    await db.execAsync(`PRAGMA user_version = ${nextVersion}`);
  }, db);

  await db.execAsync(LOCAL_INDEXES);
  dbInstance = db;
  return db;
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (!dbInitialization) {
    dbInitialization = initializeDb().catch((error) => {
      dbInitialization = null;
      throw error;
    });
  }
  return dbInitialization;
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
export async function resetLocalDatabase(existingDb?: SQLite.SQLiteDatabase): Promise<void> {
  const db = existingDb || await getDb();
  const clear = async () => {
    // Ordenado de dependientes a principales; no toca el servidor ni la sesión.
    await db.runAsync(`DELETE FROM order_item_selections`);
    await db.runAsync(`DELETE FROM order_items`);
    await db.runAsync(`DELETE FROM orders`);
    await db.runAsync(`DELETE FROM outbox`);
    await db.runAsync(`DELETE FROM combo_options`);
    await db.runAsync(`DELETE FROM combo_definitions`);
    await db.runAsync(`DELETE FROM product_favorites`);
    await db.runAsync(`DELETE FROM product_presentations`);
    await db.runAsync(`DELETE FROM products`);
    await db.runAsync(`DELETE FROM clients`);
    await db.runAsync(`DELETE FROM work_days`);
    await db.runAsync(`DELETE FROM categories`);
    await db.runAsync(`DELETE FROM meta`);
  };
  if (existingDb) await clear();
  else await withTx(clear, db);
}



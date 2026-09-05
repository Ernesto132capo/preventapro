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
    await db.runAsync(`DELETE FROM order_items`);
    await db.runAsync(`DELETE FROM orders`);
    await db.runAsync(`DELETE FROM outbox`);
    await db.runAsync(`DELETE FROM product_presentations`);
    await db.runAsync(`DELETE FROM products`);
    await db.runAsync(`DELETE FROM clients`);
    await db.runAsync(`DELETE FROM work_days`);
    await db.runAsync(`DELETE FROM categories`);
    await db.runAsync(`DELETE FROM meta`);
  });
}

export interface SqliteDbLike {
  getAllAsync<T = any>(query: string, ...params: any[]): Promise<T[]>;
  execAsync(sql: string): Promise<void>;
}

/**
 * Migración real y segura de la tabla `clients` en SQLite.
 *
 * En bases locales previas, `clients` fue creada con `business_name TEXT NOT NULL` o `name TEXT NOT NULL`.
 * SQLite no soporta ALTER COLUMN DROP NOT NULL. Esta función:
 * 1. Inspecciona con `PRAGMA table_info(clients)` la estructura actual.
 * 2. Si `business_name` o `name` tienen restricción NOT NULL (notnull === 1), o faltan `name` u `owner_name`:
 *    - Desactiva FKs (`PRAGMA foreign_keys = OFF;`)
 *    - Crea tabla temporal `clients_new` con columnas nullable y duales (`business_name`, `name`, `contact_name`, `owner_name`)
 *    - Copia atómicamente todos los registros mapeando con COALESCE las columnas existentes
 *    - Elimina `clients` anterior y renombra `clients_new` a `clients`
 *    - Reactiva FKs (`PRAGMA foreign_keys = ON;`)
 * 3. Normaliza las parejas de nombres (`business_name` <-> `name` y `contact_name` <-> `owner_name`) para que
 *    todas las consultas futuras funcionen transparentemente sin importar el alias utilizado.
 */
export async function migrateClientsTableIfNeeded(db: SqliteDbLike): Promise<void> {
  const columns = await db.getAllAsync<{ name: string; notnull: number }>(`PRAGMA table_info(clients)`);
  if (!columns || columns.length === 0) return;

  const colMap = new Map(columns.map((c) => [c.name, c]));
  const businessNameCol = colMap.get("business_name");
  const nameCol = colMap.get("name");
  const hasOwnerName = colMap.has("owner_name");
  const hasName = colMap.has("name");

  const businessNameNotNull = businessNameCol?.notnull === 1;
  const nameNotNull = nameCol?.notnull === 1;

  if (businessNameNotNull || nameNotNull || !hasOwnerName || !hasName) {
    await db.execAsync("PRAGMA foreign_keys = OFF;");
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS clients_new (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        business_name TEXT,
        name TEXT,
        contact_name TEXT,
        owner_name TEXT,
        phone TEXT,
        neighborhood_id TEXT,
        neighborhood_name TEXT,
        address TEXT,
        lat REAL,
        lng REAL,
        visit_status TEXT NOT NULL DEFAULT 'pending',
        active INTEGER NOT NULL DEFAULT 1,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const bNameExpr = colMap.has("business_name")
      ? (colMap.has("name") ? "COALESCE(business_name, name)" : "business_name")
      : (colMap.has("name") ? "name" : "NULL");

    const nameExpr = colMap.has("name")
      ? (colMap.has("business_name") ? "COALESCE(name, business_name)" : "name")
      : (colMap.has("business_name") ? "business_name" : "NULL");

    const cNameExpr = colMap.has("contact_name")
      ? (colMap.has("owner_name") ? "COALESCE(contact_name, owner_name)" : "contact_name")
      : (colMap.has("owner_name") ? "owner_name" : "NULL");

    const oNameExpr = colMap.has("owner_name")
      ? (colMap.has("contact_name") ? "COALESCE(owner_name, contact_name)" : "owner_name")
      : (colMap.has("contact_name") ? "contact_name" : "NULL");

    const phoneExpr = colMap.has("phone") ? "phone" : "NULL";
    const nIdExpr = colMap.has("neighborhood_id") ? "neighborhood_id" : "NULL";
    const nNameExpr = colMap.has("neighborhood_name") ? "neighborhood_name" : "NULL";
    const addrExpr = colMap.has("address") ? "address" : "NULL";
    const latExpr = colMap.has("lat") ? "lat" : "NULL";
    const lngExpr = colMap.has("lng") ? "lng" : "NULL";
    const visitExpr = colMap.has("visit_status") ? "visit_status" : "'pending'";
    const activeExpr = colMap.has("active") ? "active" : "1";
    const syncExpr = colMap.has("sync_status") ? "sync_status" : "'synced'";
    const createdExpr = colMap.has("created_at") ? "created_at" : "datetime('now')";
    const updatedExpr = colMap.has("updated_at") ? "updated_at" : "datetime('now')";
    const serverIdExpr = colMap.has("server_id") ? "server_id" : "NULL";

    await db.execAsync(`
      INSERT INTO clients_new (
        id, server_id, business_name, name, contact_name, owner_name,
        phone, neighborhood_id, neighborhood_name, address, lat, lng,
        visit_status, active, sync_status, created_at, updated_at
      )
      SELECT
        id, ${serverIdExpr}, ${bNameExpr}, ${nameExpr}, ${cNameExpr}, ${oNameExpr},
        ${phoneExpr}, ${nIdExpr}, ${nNameExpr}, ${addrExpr}, ${latExpr}, ${lngExpr},
        ${visitExpr}, ${activeExpr}, ${syncExpr}, ${createdExpr}, ${updatedExpr}
      FROM clients;
      DROP TABLE clients;
      ALTER TABLE clients_new RENAME TO clients;
      PRAGMA foreign_keys = ON;
    `);
  }

  await db.execAsync(`
    UPDATE clients SET
      business_name = COALESCE(NULLIF(business_name, ''), name),
      name = COALESCE(NULLIF(name, ''), business_name),
      contact_name = COALESCE(NULLIF(contact_name, ''), owner_name),
      owner_name = COALESCE(NULLIF(owner_name, ''), contact_name);
  `);
}

import "dotenv/config";
import { Pool, types } from "pg";

// ─── IMPORTANTE: columnas de fecha son TIMESTAMPTZ, no TEXT ────────────────
// El esquema real de Neon guarda created_at/updated_at/closed_at como
// `timestamp with time zone`. Por defecto, node-postgres parsea esas columnas
// como objetos `Date` de JS, lo cual rompería el contrato JSON con el móvil
// (que espera un string ISO 8601 como el contrato que usaba la app con
// `toISOString()`) y las comparaciones de string en `routes/sync.ts`
// (`localeCompare`, `updated_at > since`, etc.).
//
// Para no tener que tocar cada ruta, forzamos acá — una sola vez, a nivel de
// driver — que timestamp (OID 1114) y timestamptz (OID 1184) se devuelvan
// como el mismo string ISO que ya usa el resto del código (nowIso()).
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;

function safeDateIso(value: string | null, isUtcSuffix = false): string | null {
  if (value === null || value === undefined) return null;
  try {
    const dateStr = isUtcSuffix ? value + "Z" : value;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? value : date.toISOString();
  } catch {
    return value;
  }
}

types.setTypeParser(TIMESTAMP_OID, (value: string | null) => safeDateIso(value, true));
types.setTypeParser(TIMESTAMPTZ_OID, (value: string | null) => safeDateIso(value, false));

// Connection string pooleado de Neon. Ejemplo:
// postgres://user:password@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "test" || Boolean(process.env.VITEST)) {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test_db";
  } else {
    throw new Error(
      "Falta la variable de entorno DATABASE_URL (connection string de Neon)."
    );
  }
}

const rejectUnauthorizedEnv = process.env.PGSSLREJECTUNAUTHORIZED || process.env.DB_SSL_REJECT_UNAUTHORIZED;
const sslRejectUnauthorized = rejectUnauthorizedEnv !== undefined
  ? rejectUnauthorizedEnv === "true" || rejectUnauthorizedEnv === "1"
  : process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: sslRejectUnauthorized },
  max: 10,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  // Errores en clientes inactivos del pool no deben tumbar el proceso.
  console.error("Error inesperado en el pool de Postgres:", err);
});

/** Timestamp ISO consistente para created_at/updated_at. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Asegura idempotentemente que las columnas name y owner_name existan y business_name sea nullable. */
export async function ensureClientsSchema(clientOrPool: Pool | import("pg").PoolClient = pool): Promise<void> {
  try {
    const { rows } = await clientOrPool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'clients'
    `);
    if (rows.length === 0) return;

    const colMap = new Map(rows.map((r: any) => [r.column_name, r]));

    const bCol = colMap.get("business_name");
    if (bCol && bCol.is_nullable === "NO") {
      await clientOrPool.query(`ALTER TABLE clients ALTER COLUMN business_name DROP NOT NULL`);
    }

    if (!colMap.has("name")) {
      await clientOrPool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS name TEXT`);
    }
    if (!colMap.has("owner_name")) {
      await clientOrPool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT`);
    }

    await clientOrPool.query(`
      UPDATE clients SET
        name = COALESCE(NULLIF(name, ''), business_name),
        business_name = COALESCE(NULLIF(business_name, ''), name),
        owner_name = COALESCE(NULLIF(owner_name, ''), contact_name),
        contact_name = COALESCE(NULLIF(contact_name, ''), owner_name)
      WHERE (name IS NULL OR name = '' OR business_name IS NULL OR business_name = '' OR owner_name IS NULL OR owner_name = '' OR contact_name IS NULL OR contact_name = '');
    `);
  } catch (err) {
    // Non-fatal: table might not exist yet or connection issue
    console.warn("Aviso en ensureClientsSchema (no crítico):", err);
  }
}

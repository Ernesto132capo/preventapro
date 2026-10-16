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
  throw new Error(
    "Falta la variable de entorno DATABASE_URL (connection string de Neon)."
  );
}

const rejectUnauthorizedEnv = process.env.PGSSLREJECTUNAUTHORIZED || process.env.DB_SSL_REJECT_UNAUTHORIZED;
const sslRejectUnauthorized = rejectUnauthorizedEnv !== undefined
  ? rejectUnauthorizedEnv === "true" || rejectUnauthorizedEnv === "1"
  : process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: sslRejectUnauthorized },
});

pool.on("error", (err) => {
  // Errores en clientes inactivos del pool no deben tumbar el proceso.
  console.error("Error inesperado en el pool de Postgres:", err);
});

/** Timestamp ISO consistente para created_at/updated_at. */
export function nowIso(): string {
  return new Date().toISOString();
}

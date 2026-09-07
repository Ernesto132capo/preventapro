import { Pool, types } from "pg";

// ─── IMPORTANTE: columnas de fecha son TIMESTAMPTZ, no TEXT ────────────────
// El esquema real de Neon guarda created_at/updated_at/closed_at como
// `timestamp with time zone`. Por defecto, node-postgres parsea esas columnas
// como objetos `Date` de JS, lo cual rompería el contrato JSON con el móvil
// (que espera un string ISO 8601 tal como lo devolvía Firestore con
// `toISOString()`) y las comparaciones de string en `routes/sync.ts`
// (`localeCompare`, `updated_at > since`, etc.).
//
// Para no tener que tocar cada ruta, forzamos acá — una sola vez, a nivel de
// driver — que timestamp (OID 1114) y timestamptz (OID 1184) se devuelvan
// como el mismo string ISO que ya usa el resto del código (nowIso()).
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
types.setTypeParser(TIMESTAMP_OID, (value: string | null) => (value === null ? null : new Date(value + "Z").toISOString()));
types.setTypeParser(TIMESTAMPTZ_OID, (value: string | null) => (value === null ? null : new Date(value).toISOString()));

// Connection string pooleado de Neon. Ejemplo:
// postgres://user:password@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Falta la variable de entorno DATABASE_URL (connection string de Neon)."
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  // Errores en clientes inactivos del pool no deben tumbar el proceso.
  console.error("Error inesperado en el pool de Postgres:", err);
});

/** Timestamp ISO consistente para created_at/updated_at (mismo formato que se usaba con Firestore). */
export function nowIso(): string {
  return new Date().toISOString();
}

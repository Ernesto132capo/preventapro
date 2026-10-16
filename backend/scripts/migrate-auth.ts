import "dotenv/config";
import { pool } from "../src/db/pg";

async function main() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT");
  console.log("Columna password_hash lista. Asigna una contraseña a cada preventista con npm run user:set-password -- CODIGO.");
}

main()
  .catch((error) => {
    console.error("No se pudo preparar la autenticación en Neon:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

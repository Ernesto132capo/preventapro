import "dotenv/config";
import { pool } from "../src/db/pg";
import { runSpecificMigration } from "./migrate";

/**
 * Script legado para migración de autenticación.
 * Delega en el runner unificado para registrar la migración en _migrations.
 */
async function main() {
  await runSpecificMigration("002_auth");
  console.log("Columna password_hash lista. Asigna una contraseña a cada preventista con npm run user:set-password -- CODIGO.");
}

main()
  .catch((error) => {
    console.error("No se pudo preparar la autenticación en Neon:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

import "dotenv/config";
import { pool } from "../src/db/pg";
import { runSpecificMigration } from "./migrate";

/**
 * Script legado para migración de combos y selecciones.
 * Delega en el runner unificado para registrar la migración en _migrations.
 */
async function main() {
  await runSpecificMigration("003_combos");
  console.log("✅ Migración de combos y selecciones aplicada.");
}

main()
  .catch((error) => {
    console.error("No se pudo aplicar la migración de combos:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

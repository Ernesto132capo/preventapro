import "dotenv/config";
import { pool } from "../src/db/pg";
import { runSpecificMigration } from "./migrate";

/**
 * Script legado para retiro de columna de stock.
 * Delega en el runner unificado para registrar la migración en _migrations.
 */
async function main() {
  await runSpecificMigration("004_remove_stock");
  console.log("Columna de inventario eliminada de product_presentations.");
}

main()
  .catch((error) => {
    console.error("No se pudo retirar la columna de inventario de Neon:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

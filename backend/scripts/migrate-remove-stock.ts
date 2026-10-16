import "dotenv/config";
import { pool } from "../src/db/pg";

async function main() {
  await pool.query("ALTER TABLE product_presentations DROP COLUMN IF EXISTS quantity_available");
  console.log("Columna de inventario eliminada de product_presentations.");
}

main()
  .catch((error) => {
    console.error("No se pudo retirar la columna de inventario de Neon:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

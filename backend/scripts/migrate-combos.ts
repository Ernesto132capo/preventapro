import "dotenv/config";
import { pool } from "../src/db/pg";

/** Migración aditiva para catálogo de combos configurables. Es segura al re-ejecutarse. */
async function main() {
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
    ALTER TABLE products ADD CONSTRAINT products_product_type_check CHECK (product_type IN ('standard', 'combo'));

    CREATE TABLE IF NOT EXISTS combo_definitions (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
      selection_min INTEGER NOT NULL CHECK (selection_min > 0),
      selection_max INTEGER NOT NULL CHECK (selection_max >= selection_min),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS combo_options (
      id TEXT PRIMARY KEY,
      combo_id TEXT NOT NULL REFERENCES combo_definitions(id) ON DELETE CASCADE,
      presentation_id TEXT NOT NULL REFERENCES product_presentations(id),
      max_quantity INTEGER CHECK (max_quantity IS NULL OR max_quantity > 0),
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(combo_id, presentation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_combo_options_combo ON combo_options(combo_id, active, sort_order);
    CREATE INDEX IF NOT EXISTS idx_combo_options_presentation ON combo_options(presentation_id);

    CREATE TABLE IF NOT EXISTS order_item_selections (
      id TEXT PRIMARY KEY,
      order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      selected_product_id TEXT NOT NULL REFERENCES products(id),
      selected_presentation_id TEXT NOT NULL REFERENCES product_presentations(id),
      product_name_snapshot TEXT NOT NULL,
      presentation_name_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_item_selections_item ON order_item_selections(order_item_id);
  `);
  console.log("✅ Migración de combos y selecciones aplicada.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());



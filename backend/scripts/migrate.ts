import "dotenv/config";
import path from "path";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pg";

export interface Migration {
  id: string;
  description: string;
  run: (client: PoolClient) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    id: "001_base_schema",
    description: "Crear esquema base (secuencia de boletas, usuarios, barrios, categorías, clientes, productos, presentaciones, jornadas, pedidos e ítems)",
    run: async (client: PoolClient) => {
      await client.query(`
        -- Secuencia correlativa ininterrumpida para boletas
        CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START 1;

        -- Preventistas y usuarios del sistema
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          code TEXT UNIQUE NOT NULL,
          real_email TEXT,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'preventista',
          full_name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'preventista';
        CREATE INDEX IF NOT EXISTS idx_users_code ON users(code);

        -- Barrios para ruteo de clientes
        CREATE TABLE IF NOT EXISTS neighborhoods (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true
        );

        -- Categorías de catálogo
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);

        -- Clientes y puntos de venta
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          client_local_id TEXT,
          client_code TEXT,
          business_name TEXT,
          contact_name TEXT,
          phone TEXT,
          neighborhood_id TEXT REFERENCES neighborhoods(id),
          address TEXT,
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          visit_status TEXT NOT NULL DEFAULT 'pending',
          active BOOLEAN NOT NULL DEFAULT true,
          created_by TEXT REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_clients_neighborhood ON clients(neighborhood_id);
        CREATE INDEX IF NOT EXISTS idx_clients_active ON clients(active);
        CREATE INDEX IF NOT EXISTS idx_clients_local ON clients(client_local_id);
        CREATE INDEX IF NOT EXISTS idx_clients_updated_at ON clients(updated_at);

        -- Productos
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          sku TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          category_id TEXT REFERENCES categories(id),
          photo_url TEXT,
          base_cost_cents INTEGER NOT NULL DEFAULT 0,
          base_unit_name TEXT NOT NULL DEFAULT 'Unidad',
          product_type TEXT NOT NULL DEFAULT 'standard',
          active BOOLEAN NOT NULL DEFAULT true,
          created_by TEXT REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
        CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
        CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
        CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at);

        -- Presentaciones por producto
        CREATE TABLE IF NOT EXISTS product_presentations (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          unit_equivalence INTEGER NOT NULL DEFAULT 1,
          price_cents INTEGER NOT NULL DEFAULT 0,
          cost_cents INTEGER NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(product_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_presentations_product ON product_presentations(product_id);
        CREATE INDEX IF NOT EXISTS idx_presentations_active ON product_presentations(active);
        CREATE INDEX IF NOT EXISTS idx_presentations_updated_at ON product_presentations(updated_at);

        -- Jornadas de preventa
        CREATE TABLE IF NOT EXISTS work_days (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          work_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          order_count INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL DEFAULT 0,
          auto_closed BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          closed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_workdays_user_date ON work_days(user_id, work_date);
        CREATE INDEX IF NOT EXISTS idx_workdays_user_status ON work_days(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_workdays_updated_at ON work_days(updated_at);

        -- Pedidos / Preventas
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE NOT NULL,
          work_day_id TEXT NOT NULL REFERENCES work_days(id),
          user_id TEXT NOT NULL REFERENCES users(id),
          client_id TEXT NOT NULL REFERENCES clients(id),
          payment_condition TEXT NOT NULL DEFAULT 'Contado 48h',
          tax_rate_permille INTEGER NOT NULL DEFAULT 0,
          subtotal_cents INTEGER NOT NULL DEFAULT 0,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL DEFAULT 0,
          item_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
          receipt_number INTEGER NOT NULL DEFAULT nextval('receipt_number_seq'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_orders_workday ON orders(work_day_id);
        CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
        CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders(updated_at);

        -- Ítems inmutables por pedido
        CREATE TABLE IF NOT EXISTS order_items (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES products(id),
          presentation_id TEXT NOT NULL REFERENCES product_presentations(id),
          product_name_snapshot TEXT NOT NULL,
          sku_snapshot TEXT NOT NULL,
          presentation_name_snapshot TEXT NOT NULL,
          unit_equivalence_snapshot INTEGER NOT NULL,
          unit_price_cents_snapshot INTEGER NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          subtotal_cents INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_orderitems_order ON order_items(order_id);
      `);
    },
  },
  {
    id: "002_auth",
    description: "Agregar columna password_hash en tabla users para autenticación con contraseña",
    run: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
      `);
    },
  },
  {
    id: "003_combos",
    description: "Catálogo y pedidos de combos (combo_definitions, combo_options, order_item_selections)",
    run: async (client: PoolClient) => {
      await client.query(`
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
    },
  },
  {
    id: "004_remove_stock",
    description: "Retirar columna obsoleta de inventario quantity_available de product_presentations",
    run: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE product_presentations DROP COLUMN IF EXISTS quantity_available;
      `);
    },
  },
  {
    id: "005_flexible_client_names",
    description: "Permitir nombre de negocio o de propietario opcionales individualmente en tabla clients",
    run: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE clients ALTER COLUMN business_name DROP NOT NULL;
      `);
    },
  },
  {
    id: "006_clients_owner_name_and_nullable_name",
    description: "Agregar columnas name y owner_name en tabla clients y asegurar que business_name sea nullable",
    run: async (client: PoolClient) => {
      const { rows } = await client.query(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'clients'
      `);
      if (rows.length === 0) return;
      const colMap = new Map(rows.map((r: any) => [r.column_name, r]));

      const bCol = colMap.get("business_name");
      if (bCol && bCol.is_nullable === "NO") {
        await client.query(`ALTER TABLE clients ALTER COLUMN business_name DROP NOT NULL`);
      }
      if (!colMap.has("name")) {
        await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS name TEXT`);
      }
      if (!colMap.has("owner_name")) {
        await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT`);
      }
      await client.query(`
        UPDATE clients SET
          name = COALESCE(NULLIF(name, ''), business_name),
          business_name = COALESCE(NULLIF(business_name, ''), name),
          owner_name = COALESCE(NULLIF(owner_name, ''), contact_name),
          contact_name = COALESCE(NULLIF(contact_name, ''), owner_name);
      `);
    },
  },
  {
    id: "007_rename_users_david_yuma",
    description: "Renombrar preventistas PV001 a david y PV002 a yuma con nombres amigables",
    run: async (client: PoolClient) => {
      await client.query(`
        UPDATE users
        SET code = 'david', full_name = 'David', updated_at = now()
        WHERE lower(code) = 'pv001' OR lower(code) = 'david';

        UPDATE users
        SET code = 'yuma', full_name = 'Yuma', updated_at = now()
        WHERE lower(code) = 'pv002' OR lower(code) = 'yuma';
      `);
    },
  },
  {
    id: "008_user_sessions",
    description: "Crear tabla user_sessions para sesiones activas y revocables por dispositivo",
    run: async (client: PoolClient) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          device_name TEXT NOT NULL DEFAULT 'Dispositivo Móvil',
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, active);
      `);
    },
  },
];

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

let migrationInFlight: Promise<void> | null = null;

export async function runMigrations(): Promise<void> {
  if (migrationInFlight) {
    return migrationInFlight;
  }
  migrationInFlight = (async () => {
    console.log("🚀 Iniciando runner de migraciones de PreventaPro...");

    const lockClient = await pool.connect();
    try {
      // Advisory lock para que ejecuciones paralelas esperen ordenadamente
      await lockClient.query("SELECT pg_advisory_lock(987654)");

      const setupClient = await pool.connect();
      let appliedMigrationNames: Set<string>;
      try {
        await ensureMigrationsTable(setupClient);
        const { rows } = await setupClient.query<{ name: string }>("SELECT name FROM _migrations");
        appliedMigrationNames = new Set(rows.map((r) => r.name));
      } finally {
        setupClient.release();
      }

      let newlyApplied = 0;

      for (const migration of migrations) {
        if (appliedMigrationNames.has(migration.id)) {
          console.log(`  ⏩ [omitida] ${migration.id}: ${migration.description} (ya registrada en _migrations)`);
          continue;
        }

        console.log(`  ⏳ [ejecutando] ${migration.id}: ${migration.description}...`);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await migration.run(client);
          await client.query("INSERT INTO _migrations (name, executed_at) VALUES ($1, now())", [migration.id]);
          await client.query("COMMIT");
          console.log(`  ✅ [completada] ${migration.id} aplicada exitosamente.`);
          newlyApplied++;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // La conexión puede haber caído
          }
          console.error(`  ❌ [error] Falló la migración ${migration.id}:`, error);
          throw error;
        } finally {
          client.release();
        }
      }

      if (newlyApplied === 0) {
        console.log("✨ Todas las migraciones están al día. No hubo cambios pendientes.");
      } else {
        console.log(`🎉 Migraciones finalizadas: ${newlyApplied} migración(es) aplicada(s) correctamente.`);
      }
    } finally {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(987654)");
      } catch {}
      lockClient.release();
    }
  })().finally(() => {
    migrationInFlight = null;
  });

  return migrationInFlight;
}

/** Ejecuta una migración individual registrándola de manera transaccional e idempotente en _migrations. */
export async function runSpecificMigration(migrationId: string): Promise<void> {
  const target = migrations.find((m) => m.id === migrationId);
  if (!target) throw new Error(`Migración no encontrada: ${migrationId}`);

  const setupClient = await pool.connect();
  let alreadyApplied = false;
  try {
    await ensureMigrationsTable(setupClient);
    const { rows } = await setupClient.query("SELECT name FROM _migrations WHERE name = $1", [target.id]);
    alreadyApplied = rows.length > 0;
  } finally {
    setupClient.release();
  }

  if (alreadyApplied) {
    console.log(`⏩ [omitida] ${target.id}: ${target.description} (ya registrada en _migrations)`);
    return;
  }

  console.log(`⏳ [ejecutando] ${target.id}: ${target.description}...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await target.run(client);
    await client.query("INSERT INTO _migrations (name, executed_at) VALUES ($1, now())", [target.id]);
    await client.query("COMMIT");
    console.log(`✅ [completada] ${target.id}: ${target.description}`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(`❌ [error] Falló la migración ${target.id}:`, error);
    throw error;
  } finally {
    client.release();
  }
}

const isDirectRun =
  require.main === module ||
  (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename));

if (isDirectRun) {
  runMigrations()
    .catch((error) => {
      console.error("💥 Error fatal al ejecutar migraciones:", error.message || error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

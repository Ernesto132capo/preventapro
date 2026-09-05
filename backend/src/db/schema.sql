-- PreventaPro — esquema normalizado
-- Convenciones:
--  * id: UUID generado en cliente (localId) o servidor (serverId) -> aquí server es la fuente de verdad tras sync.
--  * Toda tabla sincronizable tiene: sync_status, client_local_id, created_at, updated_at.
--  * Dinero: se guarda en CENTAVOS (INTEGER) para evitar errores de punto flotante. 1 Bs = 100 centavos.
--  * Soft delete vía columna active/is_active donde aplica (nunca borrar historial referenciado).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,           -- Código de Preventista
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS neighborhoods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  client_code TEXT UNIQUE,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  neighborhood_id TEXT REFERENCES neighborhoods(id),
  address TEXT,
  lat REAL,
  lng REAL,
  visit_status TEXT NOT NULL DEFAULT 'pending' CHECK (visit_status IN ('pending','visited')),
  active INTEGER NOT NULL DEFAULT 1,
  assigned_user_id TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- sync metadata
  client_local_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','pending','syncing','failed')),
  last_synced_at TEXT,
  sync_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_assigned ON clients(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_clients_local ON clients(client_local_id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  photo_url TEXT,
  base_cost_cents INTEGER NOT NULL DEFAULT 0,
  base_unit_name TEXT NOT NULL DEFAULT 'Unidad',   -- unidad base para equivalencias
  active INTEGER NOT NULL DEFAULT 1,
  promo_active INTEGER NOT NULL DEFAULT 0,
  promo_price_cents INTEGER,
  promo_starts_at TEXT,
  promo_ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_local_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','pending','syncing','failed')),
  last_synced_at TEXT,
  sync_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

-- Presentaciones: Unidad / Medio Paquete / Paquete / Media Caja / Caja (configurable por producto)
CREATE TABLE IF NOT EXISTS product_presentations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,                  -- ej "Caja"
  sort_order INTEGER NOT NULL DEFAULT 0,
  unit_equivalence INTEGER NOT NULL,   -- cuántas unidades base equivalen a 1 de esta presentación
  price_cents INTEGER NOT NULL,        -- precio de venta de ESTA presentación
  cost_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, name)
);
CREATE INDEX IF NOT EXISTS idx_presentations_product ON product_presentations(product_id);

-- Stock por presentación (no genérico) — la unidad base se deriva sumando equivalencias si se requiere total.
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL UNIQUE REFERENCES product_presentations(id),
  quantity_available INTEGER NOT NULL DEFAULT 0,  -- en unidades de ESA presentación (ej: 7 cajas)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_days (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,             -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  order_count INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  client_local_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','pending','syncing','failed')),
  last_synced_at TEXT,
  sync_error TEXT,
  UNIQUE(user_id, work_date, id)
);
-- Regla de negocio (aplicada en servicio, no solo en SQL): un usuario solo puede tener UNA jornada 'open' a la vez.
CREATE INDEX IF NOT EXISTS idx_workdays_user_status ON work_days(user_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,  -- evita duplicados por reintentos de sync
  work_day_id TEXT NOT NULL REFERENCES work_days(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  payment_condition TEXT NOT NULL DEFAULT 'Contado 48h',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_local_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','pending','syncing','failed')),
  last_synced_at TEXT,
  sync_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_workday ON orders(work_day_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);

-- order_items = SNAPSHOT inmutable en el momento de la venta. Nunca se recalcula desde products/presentations.
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  presentation_id TEXT NOT NULL REFERENCES product_presentations(id),
  -- snapshot (copiado al momento de agregar al carrito):
  product_name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  presentation_name_snapshot TEXT NOT NULL,
  unit_equivalence_snapshot INTEGER NOT NULL,
  unit_price_cents_snapshot INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orderitems_order ON order_items(order_id);

-- Cola de sincronización del lado servidor (auditoría de qué se recibió y cuándo)
CREATE TABLE IF NOT EXISTS sync_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('push','pull')),
  result TEXT NOT NULL CHECK (result IN ('ok','conflict','error')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

// Esquema SQLite local — espejo simplificado del backend, con columnas server_id
// para resolver referencias al sincronizar (patrón outbox / local-first).

export const LOCAL_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  neighborhood_id TEXT,
  neighborhood_name TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  visit_status TEXT NOT NULL DEFAULT 'pending',
  active INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id TEXT,
  base_cost_cents INTEGER NOT NULL DEFAULT 0,
  base_unit_name TEXT NOT NULL DEFAULT 'Unidad',
  active INTEGER NOT NULL DEFAULT 1,
  promo_active INTEGER NOT NULL DEFAULT 0,
  product_type TEXT NOT NULL DEFAULT 'standard',
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS combo_definitions (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  product_id TEXT NOT NULL,
  selection_min INTEGER NOT NULL,
  selection_max INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS combo_options (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  combo_id TEXT NOT NULL,
  presentation_id TEXT NOT NULL,
  max_quantity INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS product_presentations (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  unit_equivalence INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  quantity_available INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS work_days (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  user_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  order_count INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  work_day_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  payment_condition TEXT NOT NULL DEFAULT 'Contado 48h',
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  presentation_id TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  presentation_name_snapshot TEXT NOT NULL,
  unit_equivalence_snapshot INTEGER NOT NULL,
  unit_price_cents_snapshot INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_item_selections (
  id TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL,
  selected_product_id TEXT NOT NULL,
  selected_presentation_id TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  presentation_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_favorites (
  product_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Outbox: cola genérica de sincronización (Fase 31). Cada fila representa UNA operación
-- local pendiente de reflejar en el servidor. El handler concreto según entity_type
-- reconstruye el payload leyendo el estado ACTUAL de la fila local (nunca guarda el
-- body serializado, para no arrastrar ids locales obsoletos).
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,      -- 'client' | 'product' | 'order' | 'category'
  operation TEXT NOT NULL DEFAULT 'create', -- 'create' | 'update' | 'cancel'
  local_entity_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,  -- 1 = clientes/productos/categorías primero, 2 = preventas después
  status TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | failed | done
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

-- Índices de alto rendimiento para búsquedas y joins rápidos
CREATE INDEX IF NOT EXISTS idx_products_name ON products (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_presentations_product ON product_presentations (product_id);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients (business_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_work_day ON orders (work_day_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_order_selections_item ON order_item_selections (order_item_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, priority);
`;


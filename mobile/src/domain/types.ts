// Tipos del dominio. Dinero SIEMPRE en centavos (integer). Espejo de backend/src/types.ts
// para que la app funcione con la MISMA lógica estando online u offline.

export type SyncStatus = "synced" | "pending" | "syncing" | "failed";

export interface Client {
  id: string;
  client_local_id: string | null;
  client_code: string | null;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  neighborhood_id: string | null;
  neighborhood_name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  visit_status: "pending" | "visited";
  active: number;
  sync_status: SyncStatus;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  base_cost_cents: number;
  base_unit_name: string;
  active: number;
  promo_active: number;
  sync_status: SyncStatus;
}

export interface Presentation {
  id: string;
  product_id: string;
  name: string;
  sort_order: number;
  unit_equivalence: number;
  price_cents: number;
  cost_cents: number;
  quantity_available: number;
  active: number;
}

export interface CartLine {
  productId: string;
  presentationId: string;
  productName: string;
  sku: string;
  presentationName: string;
  unitEquivalence: number;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
}

export interface WorkDay {
  id: string;
  local_id: string;
  server_id: string | null;
  user_id: string;
  work_date: string;
  status: "open" | "closed";
  order_count: number;
  total_cents: number;
  sync_status: SyncStatus;
  created_at: string;
}

export interface LocalOrder {
  id: string; // local uuid, se usa como idempotencyKey al sincronizar
  work_day_local_id: string;
  client_id: string;
  client_name: string;
  payment_condition: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  item_count: number;
  status: "active" | "cancelled";
  sync_status: SyncStatus;
  created_at: string;
  updated_at: string;
}

// Tipos centrales del dominio. Dinero SIEMPRE en centavos (integer) — nunca float.

export type SyncStatus = "synced" | "pending" | "syncing" | "failed";

export interface User {
  id: string;
  code: string;
  email: string | null;
  full_name: string;
  active: 0 | 1;
}

export interface Client {
  id: string;
  client_code: string | null;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  neighborhood_id: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  visit_status: "pending" | "visited";
  active: 0 | 1;
  assigned_user_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  client_local_id: string | null;
  sync_status: SyncStatus;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  photo_url: string | null;
  base_cost_cents: number;
  base_unit_name: string;
  active: 0 | 1;
  promo_active: 0 | 1;
  promo_price_cents: number | null;
}

export interface ProductPresentation {
  id: string;
  product_id: string;
  name: string;
  sort_order: number;
  unit_equivalence: number;
  price_cents: number;
  cost_cents: number;
  active: 0 | 1;
}

export interface OrderItemInput {
  product_id: string;
  presentation_id: string;
  quantity: number;
}

export interface OrderItemSnapshot {
  product_id: string;
  presentation_id: string;
  product_name_snapshot: string;
  sku_snapshot: string;
  presentation_name_snapshot: string;
  unit_equivalence_snapshot: number;
  unit_price_cents_snapshot: number;
  quantity: number;
  subtotal_cents: number;
}

export interface PricedOrder {
  items: OrderItemSnapshot[];
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  item_count: number;
}

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

export type ProductType = "standard" | "combo";

export interface Product {
  id: string;
  server_id?: string | null;
  sku: string;
  name: string;
  category_id: string | null;
  base_cost_cents: number;
  base_unit_name: string;
  active: number;
  promo_active: number;
  product_type?: ProductType;
  combo_definition?: ComboDefinition | null;
  sync_status: SyncStatus;
}

export interface Category {
  id: string;
  server_id?: string | null;
  name: string;
  active: number;
  sync_status?: SyncStatus;
  updated_at?: string;
}

export interface ComboOption {
  id: string;
  server_id?: string | null;
  combo_id: string;
  presentation_id: string;
  product_id?: string;
  product_name?: string;
  presentation_name?: string;
  max_quantity: number | null;
  sort_order: number;
  active?: number;
}

export interface ComboDefinition {
  id: string;
  server_id?: string | null;
  product_id: string;
  selection_min: number;
  selection_max: number;
  active?: number;
  options: ComboOption[];
}

export interface Presentation {
  id: string;
  server_id?: string | null;
  product_id: string;
  name: string;
  sort_order: number;
  unit_equivalence: number;
  price_cents: number;
  cost_cents: number;
  quantity_available?: number;
  active: number;
}

export interface CartLineSelection {
  selectedProductId: string;
  selectedPresentationId: string;
  productNameSnapshot: string;
  presentationNameSnapshot: string;
  quantity: number;
  sortOrder: number;
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
  isCombo?: boolean;
  selections?: CartLineSelection[];
}

export interface OrderItemSelection {
  id: string;
  order_item_id: string;
  selected_product_id: string;
  selected_presentation_id: string;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  sort_order: number;
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
  server_id?: string | null;
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


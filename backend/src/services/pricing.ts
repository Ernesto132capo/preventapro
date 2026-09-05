import { OrderItemInput, OrderItemSnapshot, PricedOrder, Product, ProductPresentation } from "../types";

/**
 * Lógica de precios CENTRALIZADA (Fase 20 del spec).
 * Regla de negocio crítica: el precio que se usa es el de la presentación EN EL MOMENTO
 * de agregar al carrito. Este snapshot nunca se recalcula después, ni siquiera si el
 * producto cambia de precio más tarde (Fase 11 / 36 — historial inmutable).
 *
 * Impuesto: configurable, no hardcodeado. taxRate = 0 respeta el "Exento DSD" actual
 * del diseño, pero el campo existe para cuando el negocio active un porcentaje real.
 */

export interface PresentationLookup {
  product: Product;
  presentation: ProductPresentation;
}

export type LookupFn = (productId: string, presentationId: string) => PresentationLookup | null;

export function buildOrderItemSnapshot(
  input: OrderItemInput,
  lookup: LookupFn
): OrderItemSnapshot {
  if (input.quantity <= 0) {
    throw new PricingError("La cantidad debe ser mayor a 0.");
  }
  const found = lookup(input.product_id, input.presentation_id);
  if (!found) {
    throw new PricingError("Producto o presentación no encontrados o inactivos.");
  }
  const { product, presentation } = found;
  if (presentation.product_id !== product.id) {
    throw new PricingError("La presentación no pertenece a este producto.");
  }

  // Precio efectivo: si hay promoción activa vigente, se podría aplicar aquí en el futuro
  // a nivel de presentación; por ahora usamos el precio de la presentación (Fase 14: la
  // arquitectura soporta promo_active/promo_price_cents pero no inventamos reglas de
  // descuento complejas sin necesidad).
  const unitPriceCents = presentation.price_cents;
  const subtotalCents = unitPriceCents * input.quantity;

  return {
    product_id: product.id,
    presentation_id: presentation.id,
    product_name_snapshot: product.name,
    sku_snapshot: product.sku,
    presentation_name_snapshot: presentation.name,
    unit_equivalence_snapshot: presentation.unit_equivalence,
    unit_price_cents_snapshot: unitPriceCents,
    quantity: input.quantity,
    subtotal_cents: subtotalCents,
  };
}

export function priceOrder(
  inputs: OrderItemInput[],
  lookup: LookupFn,
  taxRatePermille = 0 // tasa en milésimas (ej: 130 = 13.0%). 0 = exento, configurable a futuro.
): PricedOrder {
  if (inputs.length === 0) {
    throw new PricingError("La preventa debe tener al menos un producto.");
  }
  const items = inputs.map((i) => buildOrderItemSnapshot(i, lookup));
  const subtotal_cents = items.reduce((acc, i) => acc + i.subtotal_cents, 0);
  const tax_cents = Math.round((subtotal_cents * taxRatePermille) / 1000);
  const total_cents = subtotal_cents + tax_cents;
  const item_count = items.reduce((acc, i) => acc + i.quantity, 0);
  return { items, subtotal_cents, tax_cents, total_cents, item_count };
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

export function centsToDisplay(cents: number): string {
  return "Bs. " + (cents / 100).toFixed(2);
}

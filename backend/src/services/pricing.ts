// El mismo núcleo monetario se utiliza desde la app móvil.
import { OrderItemInput, OrderItemSnapshot, PricedOrder, Product, ProductPresentation } from "../types";
import { PricingError, calculateLineSubtotalCents, calculatePricedTotals, centsToDisplay } from "../shared/pricing-core";

export { PricingError, allocateProportionalCents, calculateLineSubtotalCents, calculateTaxCents, centsToDisplay } from "../shared/pricing-core";

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
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new PricingError("La cantidad debe ser un entero mayor a 0.");
  }
  const found = lookup(input.product_id, input.presentation_id);
  if (!found) {
    throw new PricingError("Producto o presentación no encontrados o inactivos.");
  }
  const { product, presentation } = found;
  const matches =
    presentation.product_id === product.id ||
    (product.server_id != null && presentation.product_id === product.server_id);
  if (!matches) {
    throw new PricingError("La presentación no pertenece a este producto.");
  }

  // Si se provee unit_price_cents (p. ej. al mantener precios históricos de preventa),
  // se respeta dicho valor; de lo contrario se usa el precio vigente de la presentación.
  if (input.unit_price_cents !== undefined && (!Number.isSafeInteger(input.unit_price_cents) || input.unit_price_cents < 0)) {
    throw new PricingError("El precio debe expresarse en centavos enteros.");
  }
  const unitPriceCents = input.unit_price_cents !== undefined ? input.unit_price_cents : presentation.price_cents;
  const subtotalCents = calculateLineSubtotalCents(unitPriceCents, input.quantity);

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
  const totals = calculatePricedTotals(items.map((item) => ({
    subtotalCents: item.subtotal_cents,
    quantity: item.quantity,
  })), taxRatePermille);
  return {
    items,
    subtotal_cents: totals.subtotalCents,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
    item_count: totals.itemCount,
  };
}

export const centsToBs = centsToDisplay;

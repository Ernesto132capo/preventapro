// REGLA COMPARTIDA: mantener las fórmulas y redondeos idénticos a mobile/src/domain/pricing.ts.
// Cualquier cambio en precios, descuentos, combos o impuestos debe replicarse en su contraparte.
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

const TAX_RATE_DENOMINATOR = 1_000;

/**
 * Reparte centavos por peso sin importes negativos ni pérdida de centavos.
 * Los residuos se asignan de mayor a menor; los empates conservan el orden original.
 * BigInt evita redondeos incluso cuando el producto total * peso excede el entero seguro.
 */
export function allocateProportionalCents(totalCents: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new PricingError("El total debe expresarse en centavos enteros no negativos.");
  }
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new PricingError("Los pesos deben ser enteros no negativos.");
  }
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) {
    if (totalCents === 0) return weights.map(() => 0);
    throw new PricingError("Se necesita al menos un peso mayor a cero.");
  }

  const total = BigInt(totalCents);
  const shares = weights.map((weight, index) => {
    const weightedTotal = total * BigInt(weight);
    return {
      index,
      cents: Number(weightedTotal / weightSum),
      remainder: weightedTotal % weightSum,
    };
  });
  const allocations = shares.map((share) => share.cents);
  let remaining = totalCents - allocations.reduce((sum, cents) => sum + cents, 0);
  shares.sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; remaining > 0; index++, remaining--) {
    allocations[shares[index].index]++;
  }
  return allocations;
}

export function calculateLineSubtotalCents(unitPriceCents: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new PricingError("El precio debe expresarse en centavos enteros.");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new PricingError("La cantidad debe ser un entero mayor a 0.");
  }
  const subtotalCents = unitPriceCents * quantity;
  if (!Number.isSafeInteger(subtotalCents)) {
    throw new PricingError("El subtotal excede el monto seguro en centavos.");
  }
  return subtotalCents;
}

export function calculateTaxCents(subtotalCents: number, taxRatePermille: number): number {
  return Math.round((subtotalCents * taxRatePermille) / TAX_RATE_DENOMINATOR);
}

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
  const subtotal_cents = items.reduce((acc, i) => acc + i.subtotal_cents, 0);
  const tax_cents = calculateTaxCents(subtotal_cents, taxRatePermille);
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

export const centsToBs = centsToDisplay;

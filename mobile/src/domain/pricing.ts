// REGLA COMPARTIDA: mantener las fórmulas y redondeos idénticos a backend/src/services/pricing.ts.
// Cualquier cambio en precios, descuentos, combos o impuestos debe replicarse en su contraparte.
import { CartLine, Presentation, Product } from "./types";

/**
 * Lógica de precios CENTRALIZADA del lado móvil (Fase 20 / 44 — nunca duplicar cálculo
 * de precios en varias pantallas). Debe producir EXACTAMENTE los mismos resultados que
 * backend/src/services/pricing.ts, porque ambos representan la misma regla de negocio:
 * el precio usado es el de la presentación en el momento de agregar al carrito.
 */

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

const TAX_RATE_DENOMINATOR = 1_000;

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

export function buildCartLine(
  product: Product,
  presentation: Presentation,
  quantity: number,
  customUnitPriceCents?: number
): CartLine {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new PricingError("La cantidad debe ser un entero mayor a 0.");
  }
  if (!product || !presentation) {
    throw new PricingError("Producto o presentación no encontrados o inactivos.");
  }
  const matches = presentation.product_id === product.id ||
    (product.server_id != null && presentation.product_id === product.server_id);
  if (!matches) {
    throw new PricingError("La presentación no pertenece a este producto.");
  }
  if (customUnitPriceCents !== undefined && (!Number.isSafeInteger(customUnitPriceCents) || customUnitPriceCents < 0)) {
    throw new PricingError("El precio debe expresarse en centavos enteros.");
  }
  const unitPriceCents = customUnitPriceCents !== undefined ? customUnitPriceCents : presentation.price_cents;
  return {
    productId: product.id,
    presentationId: presentation.id,
    productName: product.name,
    sku: product.sku,
    presentationName: presentation.name,
    unitEquivalence: presentation.unit_equivalence,
    unitPriceCents,
    quantity,
    subtotalCents: calculateLineSubtotalCents(unitPriceCents, quantity),
  };
}

export function recalcLineQuantity(line: CartLine, quantity: number): CartLine {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new PricingError("La cantidad debe ser un entero mayor a 0.");
  }
  return { ...line, quantity, subtotalCents: calculateLineSubtotalCents(line.unitPriceCents, quantity) };
}

export function updateLineUnitPrice(line: CartLine, newUnitPriceCents: number): CartLine {
  if (!Number.isSafeInteger(newUnitPriceCents) || newUnitPriceCents < 0) {
    throw new PricingError("El precio debe expresarse en centavos enteros.");
  }
  return {
    ...line,
    unitPriceCents: newUnitPriceCents,
    subtotalCents: calculateLineSubtotalCents(newUnitPriceCents, line.quantity),
  };
}

export function calcPriceDifference(newTotalCents: number, originalTotalCents: number): number {
  return newTotalCents - originalTotalCents;
}

export interface OrderTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  itemCount: number;
}

/** taxRatePermille: milésimas (130 = 13.0%). 0 = exento (valor actual del diseño). */
export function calcOrderTotals(lines: CartLine[], taxRatePermille = 0): OrderTotals {
  if (lines.length === 0) throw new PricingError("La preventa debe tener al menos un producto.");
  const subtotalCents = lines.reduce(
    (acc, line) => acc + calculateLineSubtotalCents(line.unitPriceCents, line.quantity),
    0
  );
  const taxCents = calculateTaxCents(subtotalCents, taxRatePermille);
  const totalCents = subtotalCents + taxCents;
  const itemCount = lines.reduce((acc, l) => acc + l.quantity, 0);
  return { subtotalCents, taxCents, totalCents, itemCount };
}

export function centsToBs(cents: number): string {
  return "Bs. " + (cents / 100).toFixed(2);
}

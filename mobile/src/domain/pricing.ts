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

export function buildCartLine(product: Product, presentation: Presentation, quantity: number): CartLine {
  if (quantity <= 0) throw new PricingError("La cantidad debe ser mayor a 0.");
  if (presentation.product_id !== product.id) {
    throw new PricingError("La presentación no pertenece a este producto.");
  }
  const unitPriceCents = presentation.price_cents;
  return {
    productId: product.id,
    presentationId: presentation.id,
    productName: product.name,
    sku: product.sku,
    presentationName: presentation.name,
    unitEquivalence: presentation.unit_equivalence,
    unitPriceCents,
    quantity,
    subtotalCents: unitPriceCents * quantity,
  };
}

export function recalcLineQuantity(line: CartLine, quantity: number): CartLine {
  if (quantity <= 0) throw new PricingError("La cantidad debe ser mayor a 0.");
  return { ...line, quantity, subtotalCents: line.unitPriceCents * quantity };
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
  const subtotalCents = lines.reduce((acc, l) => acc + l.subtotalCents, 0);
  const taxCents = Math.round((subtotalCents * taxRatePermille) / 1000);
  const totalCents = subtotalCents + taxCents;
  const itemCount = lines.reduce((acc, l) => acc + l.quantity, 0);
  return { subtotalCents, taxCents, totalCents, itemCount };
}

export function centsToBs(cents: number): string {
  return "Bs. " + (cents / 100).toFixed(2);
}

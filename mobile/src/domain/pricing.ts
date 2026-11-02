// El núcleo monetario es único; aquí se adapta al carrito y a los snapshots del móvil.
import { CartLine, Presentation, Product } from "./types";
import {
  PricingError, calculateLineSubtotalCents, calculatePricedTotals,
  centsToDisplay, PriceTotals,
} from "../../../backend/src/shared/pricing-core";

export { PricingError, allocateProportionalCents, calculateLineSubtotalCents, calculateTaxCents } from "../../../backend/src/shared/pricing-core";

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

export interface OrderTotals extends PriceTotals {}

/** taxRatePermille: milésimas (130 = 13.0%). 0 = exento (valor actual del diseño). */
export function calcOrderTotals(lines: CartLine[], taxRatePermille = 0): OrderTotals {
  return calculatePricedTotals(lines.map((line) => ({
    subtotalCents: calculateLineSubtotalCents(line.unitPriceCents, line.quantity),
    quantity: line.quantity,
  })), taxRatePermille);
}

export const centsToBs = centsToDisplay;

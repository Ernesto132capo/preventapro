/** Reglas monetarias puras compartidas por el servidor y la app offline. */
export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

const TAX_RATE_DENOMINATOR = 1_000;

/**
 * Reparte centavos por peso sin importes negativos ni pérdida de centavos.
 * Los residuos se asignan de mayor a menor; los empates conservan el orden original.
 * BigInt evita redondeos incluso cuando total * peso excede el entero seguro.
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
    return { index, cents: Number(weightedTotal / weightSum), remainder: weightedTotal % weightSum };
  });
  const allocations = shares.map((share) => share.cents);
  let remaining = totalCents - allocations.reduce((sum, cents) => sum + cents, 0);
  shares.sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; remaining > 0; index++, remaining--) allocations[shares[index].index]++;
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

/** Milésimas: 130 = 13 %. Conserva el redondeo histórico de medio centavo hacia arriba. */
export function calculateTaxCents(subtotalCents: number, taxRatePermille: number): number {
  return Math.round((subtotalCents * taxRatePermille) / TAX_RATE_DENOMINATOR);
}

export interface PriceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  itemCount: number;
}

/** Agrega líneas ya validadas; los adaptadores deciden cómo construir su snapshot. */
export function calculatePricedTotals(
  lines: ReadonlyArray<{ subtotalCents: number; quantity: number }>,
  taxRatePermille = 0
): PriceTotals {
  if (lines.length === 0) throw new PricingError("La preventa debe tener al menos un producto.");
  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const taxCents = calculateTaxCents(subtotalCents, taxRatePermille);
  const totalCents = subtotalCents + taxCents;
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  return { subtotalCents, taxCents, totalCents, itemCount };
}

export function centsToDisplay(cents: number): string {
  return "Bs. " + (cents / 100).toFixed(2);
}

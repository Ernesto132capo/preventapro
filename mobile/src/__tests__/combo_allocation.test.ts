import { allocateProportionalCents, PricingError } from "../domain/pricing";

describe("Reparto exacto de importes de combos", () => {
  const scenarios = [
    { total: 2, weights: [1, 1, 1, 1], expected: [1, 1, 0, 0] },
    { total: 101, weights: [1, 1, 1], expected: [34, 34, 33] },
    { total: 999, weights: [2, 1, 3], expected: [333, 167, 499] },
    { total: 7, weights: [0, 1, 0], expected: [0, 7, 0] },
    { total: 10, weights: [3, 7], expected: [3, 7] },
    { total: 0, weights: [], expected: [] },
    { total: 0, weights: [0, 0], expected: [0, 0] },
    {
      total: Number.MAX_SAFE_INTEGER,
      weights: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      expected: [4503599627370496, 4503599627370495],
    },
  ];

  for (const { total, weights, expected } of scenarios) {
    it(`reparte ${total} centavos con pesos ${weights.join(",")}`, () => {
      const allocations = allocateProportionalCents(total, weights);
      expect(allocations).toEqual(expected);
      expect(allocations.reduce((sum, cents) => sum + cents, 0)).toBe(total);
      expect(allocations.every((cents) => Number.isSafeInteger(cents) && cents >= 0)).toBe(true);
    });
  }

  it("conserva todos los centavos para muchos componentes y totales pequeños", () => {
    for (let total = 0; total <= 25; total++) {
      for (let count = 1; count <= 12; count++) {
        const weights = Array.from({ length: count }, (_, index) => (index % 5) + 1);
        const allocated = allocateProportionalCents(total, weights);
        expect(allocated.reduce((sum, cents) => sum + cents, 0)).toBe(total);
        expect(allocated.every((cents) => Number.isSafeInteger(cents) && cents >= 0)).toBe(true);
      }
    }
  });

  it("suma productos normales y múltiples combos sin perder importes", () => {
    const normalSubtotal = 250 * 2;
    const firstCombo = allocateProportionalCents(2, [1, 1, 1, 1]);
    const secondCombo = allocateProportionalCents(101 * 3, [2, 1]);
    const consolidated = normalSubtotal + [...firstCombo, ...secondCombo].reduce((sum, cents) => sum + cents, 0);
    expect(consolidated).toBe(805);
    expect(secondCombo).toEqual([202, 101]);
  });

  it("rechaza fracciones, negativos y pesos no válidos en lugar de inventar centavos", () => {
    expect(() => allocateProportionalCents(0.1 + 0.2, [1])).toThrow(PricingError);
    expect(() => allocateProportionalCents(-1, [1])).toThrow(PricingError);
    expect(() => allocateProportionalCents(1, [0])).toThrow(PricingError);
    expect(() => allocateProportionalCents(1, [])).toThrow(PricingError);
    expect(() => allocateProportionalCents(1, [1.5])).toThrow(PricingError);
    expect(() => allocateProportionalCents(1, [-1])).toThrow(PricingError);
    expect(() => allocateProportionalCents(1, [Infinity])).toThrow(PricingError);
    expect(() => allocateProportionalCents(Number.MAX_SAFE_INTEGER + 1, [1])).toThrow(PricingError);
  });
});

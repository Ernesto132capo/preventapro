import { buildCartLine, calcOrderTotals, recalcLineQuantity, PricingError, centsToBs } from "../domain/pricing";
import { Product, Presentation } from "../domain/types";

const product: Product = {
  id: "p1", sku: "LEC-001", name: "Leche Entera 1L", category_id: null,
  base_cost_cents: 500, base_unit_name: "Unidad", active: 1, promo_active: 0,
  sync_status: "synced",
};

const presentations: Record<string, Presentation> = {
  unidad: { id: "pr1", product_id: "p1", name: "Unidad", sort_order: 0, unit_equivalence: 1, price_cents: 750, cost_cents: 500, active: 1 },
  caja: { id: "pr2", product_id: "p1", name: "Caja", sort_order: 4, unit_equivalence: 24, price_cents: 15600, cost_cents: 11200, active: 1 },
  cent10: { id: "pr10", product_id: "p1", name: "10 centavos", sort_order: 5, unit_equivalence: 1, price_cents: 10, cost_cents: 0, active: 1 },
  cent20: { id: "pr20", product_id: "p1", name: "20 centavos", sort_order: 6, unit_equivalence: 1, price_cents: 20, cost_cents: 0, active: 1 },
  cent5: { id: "pr5", product_id: "p1", name: "5 centavos", sort_order: 7, unit_equivalence: 1, price_cents: 5, cost_cents: 0, active: 1 },
  fractionalCent: { id: "pr-fraction", product_id: "p1", name: "Fracción de centavo", sort_order: 8, unit_equivalence: 1, price_cents: 0.1, cost_cents: 0, active: 1 },
};

describe("pricing (mobile, offline-capable)", () => {
  it("calcula el subtotal correcto por línea (cantidad x precio de la presentación)", () => {
    const line = buildCartLine(product, presentations.caja, 2);
    expect(line.unitPriceCents).toBe(15600);
    expect(line.subtotalCents).toBe(31200);
  });

  it("rechaza cantidad cero o negativa", () => {
    expect(() => buildCartLine(product, presentations.caja, 0)).toThrow(PricingError);
    expect(() => buildCartLine(product, presentations.caja, -1)).toThrow(PricingError);
  });

  it("rechaza cantidades con decimales", () => {
    expect(() => buildCartLine(product, presentations.caja, 1.5)).toThrow(PricingError);
    const fractionalLine = { ...buildCartLine(product, presentations.caja, 1), quantity: 1.5 };
    expect(() => calcOrderTotals([fractionalLine])).toThrow(PricingError);
  });

  it("rechaza precios que no estén expresados en centavos enteros", () => {
    expect(() => buildCartLine(product, presentations.fractionalCent, 1)).toThrow(PricingError);
  });

  it("rechaza producto o presentación inexistentes", () => {
    const missingProductId = "no-existe";
    const missingProduct = missingProductId === product.id ? product : undefined;
    const missingPresentationId = "no-existe";
    const missingPresentation = Object.values(presentations).find((candidate) => candidate.id === missingPresentationId);
    expect(() => buildCartLine(missingProduct as unknown as Product, presentations.unidad, 1)).toThrow(PricingError);
    expect(() => buildCartLine(product, missingPresentation as unknown as Presentation, 1)).toThrow(PricingError);
  });

  it("rechaza una presentación que pertenece a otro producto", () => {
    const unrelatedPresentation = { ...presentations.unidad, product_id: "otro-producto" };
    expect(() => buildCartLine(product, unrelatedPresentation, 1)).toThrow(PricingError);
  });

  it("recalcula una línea al cambiar cantidad sin perder el precio unitario snapshot", () => {
    const line = buildCartLine(product, presentations.unidad, 1);
    const updated = recalcLineQuantity(line, 5);
    expect(updated.unitPriceCents).toBe(750);
    expect(updated.subtotalCents).toBe(3750);
  });

  it("mantiene el snapshot aunque después cambie el precio de la presentación", () => {
    const line = buildCartLine(product, presentations.caja, 1);
    presentations.caja.price_cents = 99999;
    expect(line.unitPriceCents).toBe(15600);
    expect(line.subtotalCents).toBe(15600);
    presentations.caja.price_cents = 15600;
  });

  it("calcula totales de una preventa con múltiples líneas y aplica impuesto configurable", () => {
    const totals = calcOrderTotals([
      buildCartLine(product, presentations.unidad, 3),
      buildCartLine(product, presentations.caja, 1),
    ], 130);
    expect(totals.subtotalCents).toBe(17850);
    expect(totals.taxCents).toBe(2321);
    expect(totals.totalCents).toBe(20171);
    expect(totals.itemCount).toBe(4);
  });

  it("con tasa de impuesto 0 el total es igual al subtotal", () => {
    const totals = calcOrderTotals([buildCartLine(product, presentations.caja, 1)], 0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(totals.subtotalCents);
  });

  it("redondea el impuesto de medio centavo al entero superior", () => {
    const totals = calcOrderTotals([buildCartLine(product, presentations.cent5, 1)], 100);
    expect(totals.subtotalCents).toBe(5);
    expect(totals.taxCents).toBe(1);
    expect(totals.totalCents).toBe(6);
  });

  it("suma precios de 10 y 20 centavos en enteros sin error de punto flotante", () => {
    const totals = calcOrderTotals([
      buildCartLine(product, presentations.cent10, 1),
      buildCartLine(product, presentations.cent20, 1),
    ]);
    expect(totals.subtotalCents).toBe(30);
    expect(totals.totalCents).toBe(30);
    expect(centsToBs(totals.totalCents)).toBe("Bs. 0.30");
  });

  it("mantiene el precio de la presentación alrededor del límite de escala 24 sin descuento automático", () => {
    const totals = [23, 24, 25].map((quantity) =>
      calcOrderTotals([buildCartLine(product, presentations.unidad, quantity)]).subtotalCents
    );
    const casePrice = calcOrderTotals([buildCartLine(product, presentations.caja, 1)]).subtotalCents;
    expect(totals).toEqual([17250, 18000, 18750]);
    expect(casePrice).toBe(15600);
  });

  it("rechaza un carrito vacío", () => {
    expect(() => calcOrderTotals([])).toThrow(PricingError);
  });
});

import { buildCartLine, calcOrderTotals, recalcLineQuantity, PricingError } from "../domain/pricing";
import { Product, Presentation } from "../domain/types";

const product: Product = {
  id: "p1", sku: "LEC-001", name: "Leche Entera 1L", category_id: null,
  base_cost_cents: 500, base_unit_name: "Unidad", active: 1, promo_active: 0,
  sync_status: "synced",
};

const unidad: Presentation = {
  id: "pr1", product_id: "p1", name: "Unidad", sort_order: 0, unit_equivalence: 1,
  price_cents: 750, cost_cents: 500, quantity_available: 140, active: 1,
};
const caja: Presentation = {
  id: "pr2", product_id: "p1", name: "Caja", sort_order: 4, unit_equivalence: 24,
  price_cents: 15600, cost_cents: 11200, quantity_available: 7, active: 1,
};

describe("pricing (mobile, offline-capable)", () => {
  it("calcula subtotal de línea correctamente", () => {
    const line = buildCartLine(product, caja, 2);
    expect(line.unitPriceCents).toBe(15600);
    expect(line.subtotalCents).toBe(31200);
  });

  it("rechaza cantidad <= 0", () => {
    expect(() => buildCartLine(product, caja, 0)).toThrow(PricingError);
    expect(() => buildCartLine(product, caja, -3)).toThrow(PricingError);
  });

  it("recalcula una línea al cambiar cantidad sin perder el precio unitario snapshot", () => {
    const line = buildCartLine(product, unidad, 1);
    const updated = recalcLineQuantity(line, 5);
    expect(updated.unitPriceCents).toBe(750);
    expect(updated.subtotalCents).toBe(3750);
  });

  it("calcula totales de preventa con impuesto configurable — coincide con el backend", () => {
    const lines = [buildCartLine(product, unidad, 3), buildCartLine(product, caja, 1)];
    const totals = calcOrderTotals(lines, 130);
    expect(totals.subtotalCents).toBe(17850);
    expect(totals.taxCents).toBe(2321);
    expect(totals.totalCents).toBe(20171);
    expect(totals.itemCount).toBe(4);
  });

  it("con tasa 0 el total iguala al subtotal (Exento DSD, valor actual del diseño)", () => {
    const totals = calcOrderTotals([buildCartLine(product, caja, 1)], 0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(totals.subtotalCents);
  });

  it("rechaza carrito vacío", () => {
    expect(() => calcOrderTotals([])).toThrow(PricingError);
  });
});

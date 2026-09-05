import { describe, it, expect } from "vitest";
import { priceOrder, buildOrderItemSnapshot, PricingError, LookupFn } from "../services/pricing";
import { Product, ProductPresentation } from "../types";

const product: Product = {
  id: "p1",
  sku: "LEC-001",
  name: "Leche Entera 1L",
  category_id: null,
  photo_url: null,
  base_cost_cents: 500,
  base_unit_name: "Unidad",
  active: 1,
  promo_active: 0,
  promo_price_cents: null,
};

const presentations: Record<string, ProductPresentation> = {
  unidad: { id: "pr1", product_id: "p1", name: "Unidad", sort_order: 0, unit_equivalence: 1, price_cents: 750, cost_cents: 500, active: 1 },
  caja: { id: "pr2", product_id: "p1", name: "Caja", sort_order: 4, unit_equivalence: 24, price_cents: 15600, cost_cents: 11200, active: 1 },
};

const lookup: LookupFn = (productId, presentationId) => {
  if (productId !== "p1") return null;
  const pres = Object.values(presentations).find((p) => p.id === presentationId);
  if (!pres) return null;
  return { product, presentation: pres };
};

describe("pricing", () => {
  it("calcula el subtotal correcto por línea (cantidad x precio de la presentación)", () => {
    const snap = buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 2 }, lookup);
    expect(snap.unit_price_cents_snapshot).toBe(15600);
    expect(snap.subtotal_cents).toBe(31200);
  });

  it("rechaza cantidad cero o negativa", () => {
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 0 }, lookup)).toThrow(
      PricingError
    );
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: -1 }, lookup)).toThrow(
      PricingError
    );
  });

  it("rechaza producto o presentación inexistentes", () => {
    expect(() =>
      buildOrderItemSnapshot({ product_id: "p1", presentation_id: "no-existe", quantity: 1 }, lookup)
    ).toThrow(PricingError);
  });

  it("calcula totales de una preventa con múltiples líneas y aplica impuesto configurable", () => {
    const result = priceOrder(
      [
        { product_id: "p1", presentation_id: "pr1", quantity: 3 }, // 3 x 750 = 2250
        { product_id: "p1", presentation_id: "pr2", quantity: 1 }, // 1 x 15600 = 15600
      ],
      lookup,
      130 // 13.0%
    );
    expect(result.subtotal_cents).toBe(17850);
    expect(result.tax_cents).toBe(2321); // round(17850 * 0.13)
    expect(result.total_cents).toBe(20171);
    expect(result.item_count).toBe(4);
  });

  it("con tasa de impuesto 0 (exento) el total es igual al subtotal", () => {
    const result = priceOrder([{ product_id: "p1", presentation_id: "pr2", quantity: 1 }], lookup, 0);
    expect(result.tax_cents).toBe(0);
    expect(result.total_cents).toBe(result.subtotal_cents);
  });

  it("rechaza una preventa sin items", () => {
    expect(() => priceOrder([], lookup)).toThrow(PricingError);
  });

  it("el snapshot es independiente de futuros cambios en el precio de la presentación (inmutabilidad histórica)", () => {
    const snap = buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 1 }, lookup);
    // Simular que el precio de catálogo cambió después de la venta
    presentations.caja.price_cents = 99999;
    // El snapshot ya generado NO debe verse afectado — es un objeto plano, no una referencia viva.
    expect(snap.unit_price_cents_snapshot).toBe(15600);
    // restaurar para no afectar otros tests
    presentations.caja.price_cents = 15600;
  });
});

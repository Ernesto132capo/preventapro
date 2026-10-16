import { describe, it, expect } from "vitest";
import {
  priceOrder,
  buildOrderItemSnapshot,
  PricingError,
  LookupFn,
  centsToDisplay,
} from "../services/pricing";
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
  cent10: { id: "pr10", product_id: "p1", name: "10 centavos", sort_order: 5, unit_equivalence: 1, price_cents: 10, cost_cents: 0, active: 1 },
  cent20: { id: "pr20", product_id: "p1", name: "20 centavos", sort_order: 6, unit_equivalence: 1, price_cents: 20, cost_cents: 0, active: 1 },
  cent5: { id: "pr5", product_id: "p1", name: "5 centavos", sort_order: 7, unit_equivalence: 1, price_cents: 5, cost_cents: 0, active: 1 },
  fractionalCent: { id: "pr-fraction", product_id: "p1", name: "Fracción de centavo", sort_order: 8, unit_equivalence: 1, price_cents: 0.1, cost_cents: 0, active: 1 },
};

const lookup: LookupFn = (productId, presentationId) => {
  if (productId !== "p1") return null;
  const presentation = Object.values(presentations).find((candidate) => candidate.id === presentationId);
  return presentation ? { product, presentation } : null;
};

describe("pricing", () => {
  it("calcula el subtotal correcto por línea (cantidad x precio de la presentación)", () => {
    const snapshot = buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 2 }, lookup);
    expect(snapshot.unit_price_cents_snapshot).toBe(15600);
    expect(snapshot.subtotal_cents).toBe(31200);
  });

  it("rechaza cantidad cero o negativa", () => {
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 0 }, lookup)).toThrow(PricingError);
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: -1 }, lookup)).toThrow(PricingError);
  });

  it("rechaza cantidades con decimales", () => {
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 1.5 }, lookup)).toThrow(PricingError);
    expect(() => priceOrder([{ product_id: "p1", presentation_id: "pr2", quantity: 1.5 }], lookup)).toThrow(PricingError);
  });

  it("rechaza precios que no estén expresados en centavos enteros", () => {
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr-fraction", quantity: 1 }, lookup)).toThrow(PricingError);
  });

  it("rechaza producto o presentación inexistentes", () => {
    expect(() => buildOrderItemSnapshot({ product_id: "no-existe", presentation_id: "pr1", quantity: 1 }, lookup)).toThrow(PricingError);
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "no-existe", quantity: 1 }, lookup)).toThrow(PricingError);
  });

  it("rechaza una presentación que pertenece a otro producto", () => {
    const wrongProductLookup: LookupFn = (productId, presentationId) => {
      if (productId !== "p1" || presentationId !== "pr1") return null;
      return { product, presentation: { ...presentations.unidad, product_id: "otro-producto" } };
    };
    expect(() => buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr1", quantity: 1 }, wrongProductLookup)).toThrow(PricingError);
  });

  it("calcula totales de una preventa con múltiples líneas y aplica impuesto configurable", () => {
    const result = priceOrder(
      [
        { product_id: "p1", presentation_id: "pr1", quantity: 3 },
        { product_id: "p1", presentation_id: "pr2", quantity: 1 },
      ],
      lookup,
      130
    );
    expect(result.subtotal_cents).toBe(17850);
    expect(result.tax_cents).toBe(2321);
    expect(result.total_cents).toBe(20171);
    expect(result.item_count).toBe(4);
  });

  it("con tasa de impuesto 0 el total es igual al subtotal", () => {
    const result = priceOrder([{ product_id: "p1", presentation_id: "pr2", quantity: 1 }], lookup, 0);
    expect(result.tax_cents).toBe(0);
    expect(result.total_cents).toBe(result.subtotal_cents);
  });

  it("redondea el impuesto de medio centavo al entero superior", () => {
    const result = priceOrder([{ product_id: "p1", presentation_id: "pr5", quantity: 1 }], lookup, 100);
    expect(result.subtotal_cents).toBe(5);
    expect(result.tax_cents).toBe(1);
    expect(result.total_cents).toBe(6);
  });

  it("suma precios de 10 y 20 centavos en enteros sin error de punto flotante", () => {
    const result = priceOrder(
      [
        { product_id: "p1", presentation_id: "pr10", quantity: 1 },
        { product_id: "p1", presentation_id: "pr20", quantity: 1 },
      ],
      lookup
    );
    expect(result.subtotal_cents).toBe(30);
    expect(result.total_cents).toBe(30);
    expect(centsToDisplay(result.total_cents)).toBe("Bs. 0.30");
  });

  it("mantiene el precio de la presentación alrededor del límite de escala 24 sin descuento automático", () => {
    const totals = [23, 24, 25].map((quantity) =>
      priceOrder([{ product_id: "p1", presentation_id: "pr1", quantity }], lookup).subtotal_cents
    );
    const casePrice = priceOrder([{ product_id: "p1", presentation_id: "pr2", quantity: 1 }], lookup).subtotal_cents;
    expect(totals).toEqual([17250, 18000, 18750]);
    expect(casePrice).toBe(15600);
  });

  it("rechaza una preventa sin items", () => {
    expect(() => priceOrder([], lookup)).toThrow(PricingError);
  });

  it("el snapshot no cambia si después cambia el precio de la presentación", () => {
    const snapshot = buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr2", quantity: 1 }, lookup);
    presentations.caja.price_cents = 99999;
    expect(snapshot.unit_price_cents_snapshot).toBe(15600);
    presentations.caja.price_cents = 15600;
  });

  it("recalcula cantidad 5 al mismo precio unitario de 750 centavos", () => {
    const result = buildOrderItemSnapshot({ product_id: "p1", presentation_id: "pr1", quantity: 5 }, lookup);
    expect(result.unit_price_cents_snapshot).toBe(750);
    expect(result.subtotal_cents).toBe(3750);
  });

  it("permite asociar presentación cuando presentation.product_id coincide con product.server_id", () => {
    const productWithServerId: Product = {
      ...product,
      id: "local-uuid-123",
      server_id: "server-uuid-456",
    };
    const lookupServerId: LookupFn = (productId, presentationId) => {
      if (productId !== "local-uuid-123" || presentationId !== "pr-srv") return null;
      return {
        product: productWithServerId,
        presentation: {
          id: "pr-srv",
          product_id: "server-uuid-456",
          name: "Unidad Server",
          sort_order: 1,
          unit_equivalence: 1,
          price_cents: 1000,
          cost_cents: 800,
          active: 1,
        },
      };
    };
    const snapshot = buildOrderItemSnapshot(
      { product_id: "local-uuid-123", presentation_id: "pr-srv", quantity: 2 },
      lookupServerId
    );
    expect(snapshot.subtotal_cents).toBe(2000);
  });

  it("exporta centsToBs con el mismo formato que centsToDisplay", async () => {
    const { centsToBs } = await import("../services/pricing");
    expect(centsToBs(15600)).toBe("Bs. 156.00");
    expect(centsToBs(750)).toBe("Bs. 7.50");
  });
});


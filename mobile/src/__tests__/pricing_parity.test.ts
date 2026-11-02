import * as mobile from "../domain/pricing";
import * as server from "../../../backend/src/services/pricing";

const product = {
  id: "local-product", server_id: "server-product", sku: "P1", name: "Producto",
  category_id: null, photo_url: null, base_cost_cents: 0, base_unit_name: "Unidad",
  active: 1 as const, promo_active: 0 as const, promo_price_cents: null, sync_status: "synced" as const,
};
const presentation = (id: string, price: number) => ({
  id, product_id: product.id, name: id, sort_order: 0, unit_equivalence: 1,
  price_cents: price, cost_cents: 0, active: 1 as const,
});

function bothTotals(prices: number[], quantities: number[], rate = 0) {
  const presentations = prices.map((price, index) => presentation(`p-${index}`, price));
  const cart = presentations.map((pres, index) => mobile.buildCartLine(product, pres, quantities[index]));
  const priced = server.priceOrder(presentations.map((pres, index) => ({
    product_id: product.id, presentation_id: pres.id, quantity: quantities[index],
  })), (_productId, id) => {
    const pres = presentations.find(p => p.id === id);
    return pres ? { product, presentation: pres } : null;
  }, rate);
  return { cart, priced, totals: mobile.calcOrderTotals(cart, rate) };
}

describe("Paridad de reglas monetarias entre móvil y servidor", () => {
  it.each([
    { prices: [10, 20], quantities: [1, 1], rate: 0, subtotal: 30, tax: 0, total: 30, items: 2 },
    { prices: [5], quantities: [1], rate: 100, subtotal: 5, tax: 1, total: 6, items: 1 },
    { prices: [750, 15600], quantities: [3, 1], rate: 130, subtotal: 17850, tax: 2321, total: 20171, items: 4 },
    { prices: [0, 999], quantities: [5, 2], rate: 1000, subtotal: 1998, tax: 1998, total: 3996, items: 7 },
  ])("produce los importes esperados con tasa $rate y precios $prices", ({ prices, quantities, rate, subtotal, tax, total, items }) => {
    const result = bothTotals(prices, quantities, rate);
    expect(result.totals).toEqual({ subtotalCents: subtotal, taxCents: tax, totalCents: total, itemCount: items });
    expect(result.priced).toMatchObject({ subtotal_cents: subtotal, tax_cents: tax, total_cents: total, item_count: items });
    expect(result.cart.map(line => line.subtotalCents)).toEqual(result.priced.items.map(item => item.subtotal_cents));
  });

  it("conserva precios históricos y alias remotos aun si cambia el catálogo", () => {
    const pres = { ...presentation("pres", 750), product_id: product.server_id };
    const line = mobile.buildCartLine(product, pres, 3, 500);
    const input = { product_id: product.id, presentation_id: pres.id, quantity: 3, unit_price_cents: 500 };
    const lookup = () => ({ product, presentation: pres });
    const before = server.priceOrder([input], lookup);
    pres.price_cents = 999;
    const after = server.priceOrder([input], lookup);
    expect(mobile.calcOrderTotals([line]).totalCents).toBe(1500);
    expect(before.total_cents).toBe(1500);
    expect(after).toEqual(before);
    expect(after.items[0].unit_price_cents_snapshot).toBe(line.unitPriceCents);
  });

  it("el móvil calcula desde precio y cantidad, sin confiar en un subtotal de carrito obsoleto", () => {
    const { cart, priced } = bothTotals([137], [3], 130);
    cart[0].subtotalCents = 1;
    expect(mobile.calcOrderTotals(cart, 130)).toEqual({
      subtotalCents: priced.subtotal_cents, taxCents: priced.tax_cents,
      totalCents: priced.total_cents, itemCount: priced.item_count,
    });
  });

  it.each([
    [Number.MAX_SAFE_INTEGER, 2],
    [0.5, 1],
    [100, 1.5],
    [-1, 1],
  ])("rechaza la misma línea inválida en ambos adaptadores (%s × %s)", (price, quantity) => {
    const pres = presentation("pres", price);
    const mobilePrice = () => mobile.buildCartLine(product, pres, quantity);
    const serverPrice = () => server.priceOrder([
      { product_id: product.id, presentation_id: pres.id, quantity },
    ], () => ({ product, presentation: pres }));
    expect(mobilePrice).toThrow(mobile.PricingError);
    expect(serverPrice).toThrow(server.PricingError);
    // Un caller puede seguir reconociendo la excepción aunque cruce los adaptadores.
    expect(serverPrice).toThrow(mobile.PricingError);
  });

  it("mantiene la suma exacta de centavos y los desempates al repartir combos en ambos lados", () => {
    for (const pricing of [mobile, server]) {
      expect(pricing.allocateProportionalCents(2, [1, 1, 1, 1])).toEqual([1, 1, 0, 0]);
      expect(pricing.allocateProportionalCents(Number.MAX_SAFE_INTEGER, [1, 0])).toEqual([Number.MAX_SAFE_INTEGER, 0]);
      expect(pricing.allocateProportionalCents(0, [0, 0])).toEqual([0, 0]);
      expect(() => pricing.allocateProportionalCents(1, [0, 0])).toThrow(pricing.PricingError);
    }
  });
});

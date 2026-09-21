import { buildCartLine, calcOrderTotals, PricingError } from "../domain/pricing";
import { Product, Presentation, CartLineSelection } from "../domain/types";

const comboProduct: Product = {
  id: "combo-1",
  sku: "CMB-001",
  name: "Combo Desayuno",
  category_id: "cat-1",
  base_cost_cents: 1500,
  base_unit_name: "Pack",
  active: 1,
  promo_active: 0,
  product_type: "combo",
  sync_status: "synced",
};

const comboPres: Presentation = {
  id: "pres-combo-1",
  product_id: "combo-1",
  name: "Pack x4",
  sort_order: 0,
  unit_equivalence: 1,
  price_cents: 2500,
  cost_cents: 1500,
  quantity_available: 50,
  active: 1,
};

describe("combos (mobile, offline-first)", () => {
  it("construye línea de combo con selections y calcula subtotal", () => {
    const selections: CartLineSelection[] = [
      {
        selectedProductId: "p-cereal",
        selectedPresentationId: "pres-cereal-choc",
        productNameSnapshot: "Cereal Chocolate",
        presentationNameSnapshot: "Unidad",
        quantity: 2,
        sortOrder: 0,
      },
      {
        selectedProductId: "p-jugo",
        selectedPresentationId: "pres-jugo-naranja",
        productNameSnapshot: "Jugo Naranja",
        presentationNameSnapshot: "Botella 500ml",
        quantity: 2,
        sortOrder: 1,
      },
    ];

    const line = {
      ...buildCartLine(comboProduct, comboPres, 2),
      isCombo: true,
      selections,
    };

    expect(line.unitPriceCents).toBe(2500);
    expect(line.subtotalCents).toBe(5000);
    expect(line.isCombo).toBe(true);
    expect(line.selections).toHaveLength(2);
    expect(line.selections![0].quantity).toBe(2);
    expect(line.selections![1].quantity).toBe(2);
  });

  it("calcula totales combinando productos estándar y combos", () => {
    const standardProd: Product = {
      id: "p-leche",
      sku: "LEC-001",
      name: "Leche Entera",
      category_id: null,
      base_cost_cents: 500,
      base_unit_name: "Unidad",
      active: 1,
      promo_active: 0,
      sync_status: "synced",
    };
    const standardPres: Presentation = {
      id: "pres-leche",
      product_id: "p-leche",
      name: "1 Litro",
      sort_order: 0,
      unit_equivalence: 1,
      price_cents: 800,
      cost_cents: 500,
      quantity_available: 100,
      active: 1,
    };

    const cart = [
      buildCartLine(standardProd, standardPres, 3), // 3 * 800 = 2400
      {
        ...buildCartLine(comboProduct, comboPres, 1), // 1 * 2500 = 2500
        isCombo: true,
        selections: [
          {
            selectedProductId: "p-cereal",
            selectedPresentationId: "pres-cereal-choc",
            productNameSnapshot: "Cereal Chocolate",
            presentationNameSnapshot: "Unidad",
            quantity: 4,
            sortOrder: 0,
          },
        ],
      },
    ];

    const totals = calcOrderTotals(cart, 0);
    expect(totals.subtotalCents).toBe(4900);
    expect(totals.totalCents).toBe(4900);
    expect(totals.itemCount).toBe(4);
  });
});

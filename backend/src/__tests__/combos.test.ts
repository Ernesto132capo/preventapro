import { describe, it, expect } from "vitest";
import { priceOrder, LookupFn } from "../services/pricing";
import { ComboDefinition, ComboOption, Product, ProductPresentation } from "../types";

type ComboSelection = { selected_presentation_id: string; quantity: number };

// Replica las reglas de selección del combo para probar el mismo contrato en ambos paquetes.
export function validateComboSelections(
  comboDef: ComboDefinition,
  options: ComboOption[],
  selections: ComboSelection[]
): { valid: boolean; error?: string } {
  if (!selections || selections.length === 0) {
    return { valid: false, error: "El combo requiere al menos una selección." };
  }
  if (selections.some((selection) => !Number.isSafeInteger(selection.quantity) || selection.quantity <= 0)) {
    return { valid: false, error: "La cantidad de cada selección debe ser un entero mayor a 0." };
  }

  const optionByPresentation = new Map<string, ComboOption>(options.map((option) => [option.presentation_id, option]));
  const totalUnits = selections.reduce((sum, selection) => sum + selection.quantity, 0);

  if (totalUnits < comboDef.selection_min) {
    return { valid: false, error: `Se requieren al menos ${comboDef.selection_min} unidades (elegidas: ${totalUnits}).` };
  }
  if (totalUnits > comboDef.selection_max) {
    return { valid: false, error: `No se pueden seleccionar más de ${comboDef.selection_max} unidades (elegidas: ${totalUnits}).` };
  }

  for (const selection of selections) {
    const option = optionByPresentation.get(selection.selected_presentation_id);
    if (!option) {
      return { valid: false, error: "La opción seleccionada no pertenece a este combo." };
    }
    if (option.max_quantity !== null && option.max_quantity !== undefined && selection.quantity > option.max_quantity) {
      return { valid: false, error: `La opción seleccionada excede el límite máximo de ${option.max_quantity}.` };
    }
  }
  return { valid: true };
}

const comboProduct: Product = {
  id: "combo-1",
  sku: "CMB-001",
  name: "Combo Cereales x4",
  category_id: "cat-cereales",
  photo_url: null,
  base_cost_cents: 1500,
  base_unit_name: "Pack",
  active: 1,
  promo_active: 0,
  promo_price_cents: null,
  product_type: "combo",
};

const standardProduct: Product = {
  id: "p-normal",
  sku: "NOR-001",
  name: "Producto normal",
  category_id: "cat-cereales",
  photo_url: null,
  base_cost_cents: 500,
  base_unit_name: "Unidad",
  active: 1,
  promo_active: 0,
  promo_price_cents: null,
};

const comboPresentation: ProductPresentation = {
  id: "pres-combo-1", product_id: "combo-1", name: "Pack x4", sort_order: 0,
  unit_equivalence: 1, price_cents: 2500, cost_cents: 1500, active: 1,
};
const standardPresentation: ProductPresentation = {
  id: "pres-normal", product_id: "p-normal", name: "Unidad", sort_order: 0,
  unit_equivalence: 1, price_cents: 800, cost_cents: 500, active: 1,
};

const comboOptions: ComboOption[] = [
  { id: "opt-1", combo_id: "def-1", presentation_id: "pres-choc", product_id: "p-choc", product_name: "Cereal Chocolate", presentation_name: "Unidad", max_quantity: 2, sort_order: 0, active: 1 },
  { id: "opt-2", combo_id: "def-1", presentation_id: "pres-vain", product_id: "p-vain", product_name: "Cereal Vainilla", presentation_name: "Unidad", max_quantity: null, sort_order: 1, active: 1 },
  { id: "opt-3", combo_id: "def-1", presentation_id: "pres-frut", product_id: "p-frut", product_name: "Cereal Frutilla", presentation_name: "Unidad", max_quantity: null, sort_order: 2, active: 1 },
  { id: "opt-4", combo_id: "def-1", presentation_id: "pres-miel", product_id: "p-miel", product_name: "Cereal Miel", presentation_name: "Unidad", max_quantity: null, sort_order: 3, active: 1 },
];

const comboDef: ComboDefinition = {
  id: "def-1", product_id: comboProduct.id, selection_min: 4, selection_max: 4,
  active: 1, options: comboOptions,
};

const exactSelections: ComboSelection[] = [
  { selected_presentation_id: "pres-choc", quantity: 2 },
  { selected_presentation_id: "pres-vain", quantity: 1 },
  { selected_presentation_id: "pres-miel", quantity: 1 },
];
const orderSelections = [
  { selected_product_id: "p-choc", selected_presentation_id: "pres-choc", quantity: 2, sort_order: 0 },
  { selected_product_id: "p-vain", selected_presentation_id: "pres-vain", quantity: 1, sort_order: 1 },
  { selected_product_id: "p-miel", selected_presentation_id: "pres-miel", quantity: 1, sort_order: 2 },
];

const lookup: LookupFn = (productId, presentationId) => {
  const products: Record<string, Product> = {
    [comboProduct.id]: comboProduct,
    [standardProduct.id]: standardProduct,
  };
  const presentations: Record<string, ProductPresentation> = {
    [comboPresentation.id]: comboPresentation,
    [standardPresentation.id]: standardPresentation,
  };
  const product = products[productId];
  const presentation = presentations[presentationId];
  return product && presentation ? { product, presentation } : null;
};

describe("combo business rules and pricing", () => {
  it("acepta una selección exacta que cumple la regla x4", () => {
    expect(validateComboSelections(comboDef, comboOptions, exactSelections)).toEqual({ valid: true });
  });

  it("rechaza cuando la suma de selecciones es menor al mínimo", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-choc", quantity: 2 },
      { selected_presentation_id: "pres-vain", quantity: 1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("al menos 4");
  });

  it("rechaza cuando la suma de selecciones supera el máximo", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-choc", quantity: 2 },
      { selected_presentation_id: "pres-vain", quantity: 2 },
      { selected_presentation_id: "pres-miel", quantity: 1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("más de 4");
  });

  it("rechaza cuando una opción individual supera su max_quantity configurado", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-choc", quantity: 3 },
      { selected_presentation_id: "pres-vain", quantity: 1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("excede el límite máximo");
  });

  it("rechaza una opción que no pertenece al combo", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-otra", quantity: 4 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no pertenece a este combo");
  });

  it("rechaza una selección vacía", () => {
    const result = validateComboSelections(comboDef, comboOptions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("al menos una selección");
  });

  it("rechaza cantidades cero en las opciones, aunque la suma alcance el total requerido", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-choc", quantity: 0 },
      { selected_presentation_id: "pres-vain", quantity: 2 },
      { selected_presentation_id: "pres-miel", quantity: 2 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("entero mayor a 0");
  });

  it("rechaza cantidades decimales en las opciones", () => {
    const result = validateComboSelections(comboDef, comboOptions, [
      { selected_presentation_id: "pres-choc", quantity: 1.5 },
      { selected_presentation_id: "pres-vain", quantity: 1 },
      { selected_presentation_id: "pres-miel", quantity: 1.5 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("entero mayor a 0");
  });

  it("calcula el precio de un combo por su presentación y cantidad", () => {
    const order = priceOrder([{
      product_id: "combo-1", presentation_id: "pres-combo-1", quantity: 2,
      selections: orderSelections,
    }], lookup);
    expect(order.items[0].unit_price_cents_snapshot).toBe(2500);
    expect(order.items[0].subtotal_cents).toBe(5000);
  });

  it("calcula productos normales y múltiples combos del mismo producto en una preventa", () => {
    const order = priceOrder([
      { product_id: "p-normal", presentation_id: "pres-normal", quantity: 3 },
      { product_id: "combo-1", presentation_id: "pres-combo-1", quantity: 1, selections: orderSelections },
      { product_id: "combo-1", presentation_id: "pres-combo-1", quantity: 2, selections: orderSelections },
    ], lookup);
    expect(order.items.map((item) => item.subtotal_cents)).toEqual([2400, 2500, 5000]);
    expect(order.subtotal_cents).toBe(9900);
    expect(order.tax_cents).toBe(0);
    expect(order.total_cents).toBe(9900);
    expect(order.item_count).toBe(6);
  });
});

import { buildCartLine, calcOrderTotals } from "../domain/pricing";
import { Product, Presentation, CartLineSelection, ComboDefinition, ComboOption } from "../domain/types";

type ComboSelection = { selected_presentation_id: string; quantity: number };

// Replica las reglas de selección del combo para probar el mismo contrato en ambos paquetes.
function validateComboSelections(
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
  id: "combo-1", sku: "CMB-001", name: "Combo Cereales x4", category_id: "cat-cereales",
  base_cost_cents: 1500, base_unit_name: "Pack", active: 1, promo_active: 0,
  product_type: "combo", sync_status: "synced",
};

const standardProduct: Product = {
  id: "p-normal", sku: "NOR-001", name: "Producto normal", category_id: "cat-cereales",
  base_cost_cents: 500, base_unit_name: "Unidad", active: 1, promo_active: 0,
  sync_status: "synced",
};

const comboPresentation: Presentation = {
  id: "pres-combo-1", product_id: "combo-1", name: "Pack x4", sort_order: 0,
  unit_equivalence: 1, price_cents: 2500, cost_cents: 1500, active: 1,
};
const standardPresentation: Presentation = {
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

const cartSelections: CartLineSelection[] = [
  { selectedProductId: "p-choc", selectedPresentationId: "pres-choc", productNameSnapshot: "Cereal Chocolate", presentationNameSnapshot: "Unidad", quantity: 2, sortOrder: 0 },
  { selectedProductId: "p-vain", selectedPresentationId: "pres-vain", productNameSnapshot: "Cereal Vainilla", presentationNameSnapshot: "Unidad", quantity: 1, sortOrder: 1 },
  { selectedProductId: "p-miel", selectedPresentationId: "pres-miel", productNameSnapshot: "Cereal Miel", presentationNameSnapshot: "Unidad", quantity: 1, sortOrder: 2 },
];

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
    const line = { ...buildCartLine(comboProduct, comboPresentation, 2), isCombo: true, selections: cartSelections };
    expect(line.unitPriceCents).toBe(2500);
    expect(line.subtotalCents).toBe(5000);
    expect(line.selections).toHaveLength(3);
    expect(line.selections?.map((selection) => selection.quantity)).toEqual([2, 1, 1]);
  });

  it("calcula productos normales y múltiples combos del mismo producto en una preventa", () => {
    const cart = [
      buildCartLine(standardProduct, standardPresentation, 3),
      { ...buildCartLine(comboProduct, comboPresentation, 1), isCombo: true, selections: cartSelections },
      { ...buildCartLine(comboProduct, comboPresentation, 2), isCombo: true, selections: cartSelections },
    ];
    const totals = calcOrderTotals(cart);
    expect(cart.map((line) => line.subtotalCents)).toEqual([2400, 2500, 5000]);
    expect(totals.subtotalCents).toBe(9900);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(9900);
    expect(totals.itemCount).toBe(6);
  });
});

import { describe, it, expect } from "vitest";
import { ComboDefinition, ComboOption, Product } from "../types";

// Simulación de función de validación de combos para verificar las reglas de negocio
export function validateComboSelections(
  comboDef: ComboDefinition,
  options: ComboOption[],
  selections: { selected_presentation_id: string; quantity: number }[]
): { valid: boolean; error?: string } {
  if (!selections || selections.length === 0) {
    return { valid: false, error: "El combo requiere al menos una selección." };
  }

  const optMap = new Map<string, ComboOption>(options.map((o) => [o.presentation_id, o]));
  const totalUnits = selections.reduce((sum, s) => sum + s.quantity, 0);

  if (totalUnits < comboDef.selection_min) {
    return { valid: false, error: `Se requieren al menos ${comboDef.selection_min} unidades (elegidas: ${totalUnits}).` };
  }
  if (totalUnits > comboDef.selection_max) {
    return { valid: false, error: `No se pueden seleccionar más de ${comboDef.selection_max} unidades (elegidas: ${totalUnits}).` };
  }

  for (const sel of selections) {
    const opt = optMap.get(sel.selected_presentation_id);
    if (!opt) {
      return { valid: false, error: "La opción seleccionada no pertenece a este combo." };
    }
    if (opt.max_quantity !== null && opt.max_quantity !== undefined && sel.quantity > opt.max_quantity) {
      return { valid: false, error: `La opción seleccionada excede el límite máximo de ${opt.max_quantity}.` };
    }
  }

  return { valid: true };
}

describe("Combo business rules and validations", () => {
  const comboProduct: Product = {
    id: "combo-1",
    sku: "CMB-001",
    name: "Combo Cereales x4",
    category_id: "cat-cereales",
    photo_url: null,
    base_cost_cents: 2000,
    base_unit_name: "Pack",
    active: 1,
    promo_active: 0,
    promo_price_cents: null,
    product_type: "combo",
  };

  const comboOptions: ComboOption[] = [
    { id: "opt-1", combo_id: "def-1", presentation_id: "pres-choc", product_name: "Cereal Chocolate", presentation_name: "Unidad", max_quantity: 2, sort_order: 0, active: 1 },
    { id: "opt-2", combo_id: "def-1", presentation_id: "pres-vain", product_name: "Cereal Vainilla", presentation_name: "Unidad", max_quantity: null, sort_order: 1, active: 1 },
    { id: "opt-3", combo_id: "def-1", presentation_id: "pres-frut", product_name: "Cereal Frutilla", presentation_name: "Unidad", max_quantity: null, sort_order: 2, active: 1 },
    { id: "opt-4", combo_id: "def-1", presentation_id: "pres-miel", product_name: "Cereal Miel", presentation_name: "Unidad", max_quantity: null, sort_order: 3, active: 1 },
  ];

  const comboDef: ComboDefinition = {
    id: "def-1",
    product_id: comboProduct.id,
    selection_min: 4,
    selection_max: 4,
    active: 1,
    options: comboOptions,
  };

  it("acepta una selección exacta que cumple la regla x4", () => {
    const selections = [
      { selected_presentation_id: "pres-choc", quantity: 2 },
      { selected_presentation_id: "pres-vain", quantity: 1 },
      { selected_presentation_id: "pres-miel", quantity: 1 },
    ];
    const result = validateComboSelections(comboDef, comboOptions, selections);
    expect(result.valid).toBe(true);
  });

  it("rechaza cuando la suma de selecciones es menor al mínimo", () => {
    const selections = [
      { selected_presentation_id: "pres-choc", quantity: 2 },
      { selected_presentation_id: "pres-vain", quantity: 1 },
    ];
    const result = validateComboSelections(comboDef, comboOptions, selections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("al menos 4");
  });

  it("rechaza cuando la suma de selecciones supera el máximo", () => {
    const selections = [
      { selected_presentation_id: "pres-choc", quantity: 2 },
      { selected_presentation_id: "pres-vain", quantity: 2 },
      { selected_presentation_id: "pres-miel", quantity: 1 },
    ];
    const result = validateComboSelections(comboDef, comboOptions, selections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("más de 4");
  });

  it("rechaza cuando una opción individual supera su max_quantity configurado", () => {
    const selections = [
      { selected_presentation_id: "pres-choc", quantity: 3 }, // max es 2
      { selected_presentation_id: "pres-vain", quantity: 1 },
    ];
    const result = validateComboSelections(comboDef, comboOptions, selections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("excede el límite máximo");
  });

  it("rechaza una opción que no pertenece al combo", () => {
    const selections = [
      { selected_presentation_id: "pres-otra", quantity: 4 },
    ];
    const result = validateComboSelections(comboDef, comboOptions, selections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no pertenece a este combo");
  });
});

import { describe, it, expect } from "vitest";
import { comboDefinitionInput } from "../routes/catalog";

describe("Validación de alcanzabilidad de combos (regresión)", () => {
  it("acepta un combo cuya selección mínima es alcanzable con opciones ilimitadas", () => {
    const result = comboDefinitionInput.safeParse({
      selectionMin: 4,
      selectionMax: 4,
      options: [
        { presentationId: "pres-a", maxQuantity: 2 },
        { presentationId: "pres-b", maxQuantity: null },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rechaza un combo cuya suma de máximos no alcanza la selección mínima", () => {
    const result = comboDefinitionInput.safeParse({
      selectionMin: 4,
      selectionMax: 4,
      options: [{ presentationId: "pres-a", maxQuantity: 2 }],
    });
    expect(result.success).toBe(false);
  });

  it("rechaza selectionMax menor a selectionMin", () => {
    const result = comboDefinitionInput.safeParse({
      selectionMin: 4,
      selectionMax: 2,
      options: [{ presentationId: "pres-a", maxQuantity: null }],
    });
    expect(result.success).toBe(false);
  });
});

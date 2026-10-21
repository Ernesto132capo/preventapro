import { resolveSelectedPresentation } from "../utils/catalogSelection";
import type { Presentation } from "../domain/types";

const presentation = (id: string, price_cents: number): Presentation => ({
  id, product_id: "product", name: id, sort_order: 0,
  unit_equivalence: 1, price_cents, cost_cents: 0, active: 1,
});

describe("Selección de presentaciones después de sincronizar precios", () => {
  it("usa el precio nuevo aunque el producto y la presentación conserven sus IDs", () => {
    const old = presentation("unit", 1000);
    expect(resolveSelectedPresentation([old], old.id)?.price_cents).toBe(1000);
    const current = presentation("unit", 2000);
    expect(resolveSelectedPresentation([current], old.id)).toBe(current);
    expect(resolveSelectedPresentation([current], old.id)?.price_cents).toBe(2000);
  });

  it("conserva la presentación elegida entre varias al actualizar el catálogo", () => {
    const unit = presentation("unit", 1200);
    const box = presentation("box", 9000);
    expect(resolveSelectedPresentation([unit, box], "box")).toBe(box);
  });

  it("descarta una presentación eliminada y usa una vigente", () => {
    const unit = presentation("unit", 1200);
    expect(resolveSelectedPresentation([unit], "deleted")).toBe(unit);
    expect(resolveSelectedPresentation([], "deleted")).toBeNull();
  });
});

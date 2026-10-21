import type { Presentation } from "../domain/types";

/** Conserva la selección por ID, pero obtiene siempre los datos vigentes del catálogo. */
export function resolveSelectedPresentation(presentations: Presentation[], selectedId: string | null): Presentation | null {
  return presentations.find((presentation) => presentation.id === selectedId) ?? presentations[0] ?? null;
}

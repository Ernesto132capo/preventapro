/** Conflicto uniforme cuando una edición/alta apunta a un registro eliminado en el servidor. */
export const CONFLICT_CODE = "ENTITY_DELETED";

export type DeletedEntityType = "client" | "product" | "category";

const LABELS: Record<DeletedEntityType, string> = {
  client: "cliente",
  product: "producto",
  category: "categoría",
};

export function deletedEntityLabel(entityType: DeletedEntityType): string {
  return LABELS[entityType] ?? "registro";
}

export function deletedConflictMessage(entityType: DeletedEntityType): string {
  return `Este ${deletedEntityLabel(entityType)} fue eliminado desde otro dispositivo. Usa "Restaurar" para recuperarlo con tus cambios.`;
}

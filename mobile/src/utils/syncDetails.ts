import type { OutboxDetail, OutboxRow } from "../db/outbox";

export function syncDetailStatus(row: Pick<OutboxRow, "status" | "next_retry_at">): {
  kind: "pending" | "syncing" | "failed";
  label: string;
} {
  if (row.status === "error") return { kind: "failed", label: "Requiere corrección" };
  if (row.status === "conflict") return { kind: "failed", label: "Conflicto: registro eliminado" };
  if (row.status === "failed") return { kind: "pending", label: "Error temporal" };
  if (row.status === "syncing") return { kind: "syncing", label: "En proceso de envío" };
  return { kind: "pending", label: row.next_retry_at ? "Reintento programado" : "Pendiente" };
}

type SyncDetailAction =
  | { label: string; route: "DetallePreventa"; params: { orderId: string } }
  | { label: string; route: "NuevoCliente"; params: { clientId: string } }
  | { label: string; route: "NuevoProducto"; params: { productId: string } }
  | { label: string; categoryId: string };

/** Las preventas pasan por el detalle para conservar las reglas de edición de jornadas. */
export function syncDetailAction(row: OutboxDetail): SyncDetailAction | null {
  if (!row.entity_exists) return null;
  const id = row.local_entity_id;
  if (row.entity_type === "order") {
    return { label: "Ver preventa", route: "DetallePreventa", params: { orderId: id } };
  }
  if (!row.entity_active || row.operation === "delete" || row.operation === "cancel") return null;
  if (row.entity_type === "client") return { label: "Revisar cliente", route: "NuevoCliente", params: { clientId: id } };
  if (row.entity_type === "product") return { label: "Revisar producto", route: "NuevoProducto", params: { productId: id } };
  return { label: "Revisar categoría", categoryId: id };
}

export function syncChangeDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("es-BO", { timeZone: "America/La_Paz" })
    : "Fecha no disponible";
}

import type { CartLine, Client, ComboCatalogSnapshot } from "../domain/types";
import { withTx } from "../db/client";
import { apiFetch, ApiError } from "./api";

export interface SaleDraftIssue {
  entity: "client" | "product" | "presentation" | "combo" | "selection";
  lineIndex?: number;
  code: string;
  message: string;
}

export interface SaleDraftItem {
  lineIndex: number;
  productId: string;
  presentationId: string;
  productName: string | null;
  sku: string | null;
  presentationName: string | null;
  unitEquivalence: number | null;
  priceCents: number | null;
  productType: string | null;
  comboDefinition: {
    selectionMin: number;
    selectionMax: number;
    options: Array<{ presentationId: string; maxQuantity: number | null }>;
  } | null;
  selections: Array<{
    selectedProductId: string;
    selectedPresentationId: string;
    productName: string | null;
    presentationName: string | null;
    quantity: number;
  }>;
  unchecked: boolean;
  /** Baseline local normalizado por el servicio, nunca enviado al servidor. */
  knownComboDefinition?: ComboCatalogSnapshot;
}

export interface SaleDraftResponse {
  valid: boolean;
  checkedAt: string;
  unchecked: boolean;
  client: {
    id: string;
    businessName: string | null;
    contactName: string | null;
    name: string | null;
    active: boolean;
    updatedAt: string | null;
  } | null;
  issues: SaleDraftIssue[];
  items: SaleDraftItem[];
}

export type SaleDraftValidation = ({ status: "verified" } & SaleDraftResponse) | {
  status: "unverified";
  reason: "offline" | "network" | "server" | "unsupported";
  message: string;
};

type EntityRow = { id: string; server_id: string | null; sync_status: string };
type PresentationRow = { id: string; server_id: string | null; product_id: string };

function aliases<T extends { id: string; server_id: string | null }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.id, row);
    if (row.server_id) map.set(row.server_id, row);
  }
  return map;
}

function entityReference(id: string, entity?: EntityRow) {
  return { id: entity?.server_id || entity?.id || id, unpublished: Boolean(entity && !entity.server_id && entity.sync_status !== "synced") };
}

/** Consulta previa sin escrituras ni efectos sobre jornadas. La validación final sigue en el servidor. */
export async function validateSaleDraft(
  client: Client,
  lines: CartLine[],
  options: { online: boolean; editingOrderId?: string }
): Promise<SaleDraftValidation> {
  if (!options.online) {
    return { status: "unverified", reason: "offline", message: "Sin conexión: el cliente y los productos se comprobarán al sincronizar." };
  }

  // Capturar referencias coherentes y liberar SQLite antes de esperar a la red.
  const { body, knownComboDefinitions } = await withTx(async (db) => {
    const localClient = await db.getFirstAsync<EntityRow>(
      "SELECT id, server_id, sync_status FROM clients WHERE id = ? OR server_id = ?", [client.id, client.id]);
    const clientRef = entityReference(client.server_id || client.id, localClient || undefined);
    const presentationIds = Array.from(new Set(lines.flatMap((line) => [
      line.presentationId,
      ...(line.selections || []).map((selection) => selection.selectedPresentationId),
      ...(line.comboCatalogSnapshot?.options || []).map((option) => option.presentationId),
    ])));
    const placeholders = presentationIds.map(() => "?").join(",");
    const presentations = presentationIds.length ? await db.getAllAsync<PresentationRow>(
      `SELECT id, server_id, product_id FROM product_presentations WHERE id IN (${placeholders}) OR server_id IN (${placeholders})`,
      [...presentationIds, ...presentationIds]) : [];
    const productIds = Array.from(new Set([
      ...lines.flatMap((line) => [line.productId, ...(line.selections || []).map((selection) => selection.selectedProductId)]),
      ...presentations.map((presentation) => presentation.product_id),
    ]));
    const productPlaceholders = productIds.map(() => "?").join(",");
    const products = productIds.length ? await db.getAllAsync<EntityRow>(
      `SELECT id, server_id, sync_status FROM products WHERE id IN (${productPlaceholders}) OR server_id IN (${productPlaceholders})`,
      [...productIds, ...productIds]) : [];
    const productMap = aliases(products);
    const presentationMap = aliases(presentations);
    function presentationReference(id: string) {
      const presentation = presentationMap.get(id);
      const parent = presentation && productMap.get(presentation.product_id);
      return {
        id: presentation?.server_id || presentation?.id || id,
        unpublished: Boolean(presentation && !presentation.server_id && parent && parent.sync_status !== "synced"),
      };
    }
    let editingOrderId: string | undefined;
    if (options.editingOrderId) {
      const order = await db.getFirstAsync<EntityRow>(
        "SELECT id, server_id, sync_status FROM orders WHERE id = ? OR server_id = ?", [options.editingOrderId, options.editingOrderId]);
      // Un pedido creado offline aún no tiene una asociación histórica remota que comprobar.
      if (!order) editingOrderId = options.editingOrderId;
      else if (order.server_id || order.sync_status === "synced") editingOrderId = order.server_id || order.id;
    }
    const body = {
      clientId: clientRef.id,
      ...(clientRef.unpublished ? { allowMissingClient: true } : {}),
      ...(editingOrderId ? { editingOrderId } : {}),
      items: lines.map((line) => {
        const product = entityReference(line.productId, productMap.get(line.productId));
        const presentation = presentationReference(line.presentationId);
        return {
          productId: product.id, presentationId: presentation.id,
          quantity: line.quantity, unitPriceCents: line.unitPriceCents,
          ...(product.unpublished ? { allowMissingProduct: true } : {}),
          ...(presentation.unpublished ? { allowMissingPresentation: true } : {}),
          ...(line.selections?.length ? { selections: line.selections.map((selection) => {
            const selectedProduct = entityReference(selection.selectedProductId, productMap.get(selection.selectedProductId));
            const selectedPresentation = presentationReference(selection.selectedPresentationId);
            return {
              selectedProductId: selectedProduct.id, selectedPresentationId: selectedPresentation.id,
              quantity: selection.quantity, sortOrder: selection.sortOrder,
              ...(selectedProduct.unpublished || selectedPresentation.unpublished ? { allowMissing: true } : {}),
            };
          }) } : {}),
        };
      }),
    };
    const knownComboDefinitions = lines.map((line) => line.comboCatalogSnapshot ? {
      selectionMin: line.comboCatalogSnapshot.selectionMin,
      selectionMax: line.comboCatalogSnapshot.selectionMax,
      options: line.comboCatalogSnapshot.options.map((option) => ({
        presentationId: presentationReference(option.presentationId).id,
        maxQuantity: option.maxQuantity,
      })),
    } : undefined);
    return { body, knownComboDefinitions };
  });

  try {
    const response = await apiFetch<SaleDraftResponse>("/orders/validate", { method: "POST", body, timeoutMs: 8000 });
    if (!response || typeof response.valid !== "boolean" || typeof response.checkedAt !== "string" ||
        typeof response.unchecked !== "boolean" || !Array.isArray(response.issues) || !Array.isArray(response.items) ||
        response.items.length !== lines.length) {
      return { status: "unverified", reason: "unsupported", message: "El servidor aún no ofrece una comprobación compatible del catálogo." };
    }
    return { ...response, status: "verified", items: response.items.map((item) => ({
      ...item,
      knownComboDefinition: knownComboDefinitions[item.lineIndex],
    })) };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 0) return { status: "unverified", reason: "network", message: "No se pudo verificar el catálogo por la conexión. Puedes conservar la preventa offline y comprobarla al sincronizar." };
    if (error.status >= 500 || [408, 425, 429].includes(error.status)) return { status: "unverified", reason: "server", message: "El servidor no pudo verificar el catálogo. Puedes conservar la preventa offline y comprobarla al sincronizar." };
    if (error.status === 404) return { status: "unverified", reason: "unsupported", message: "El servidor todavía no tiene disponible la comprobación previa del catálogo." };
    // Sesión expirada, permisos y validaciones permanentes nunca se ocultan como modo offline.
    throw error;
  }
}

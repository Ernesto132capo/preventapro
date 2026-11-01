import { PoolClient } from "pg";
import { z } from "zod";
import { loadOrderCatalog } from "./order-storage";

const selection = z.object({
  selectedProductId: z.string().min(1),
  selectedPresentationId: z.string().min(1),
  quantity: z.number().int().positive().max(1_000_000),
  sortOrder: z.number().int().nonnegative().optional(),
  allowMissing: z.boolean().optional().default(false),
}).strict();

export const orderDraftValidationSchema = z.object({
  clientId: z.string().min(1),
  allowMissingClient: z.boolean().optional().default(false),
  editingOrderId: z.string().min(1).optional(),
  items: z.array(z.object({
    productId: z.string().min(1),
    presentationId: z.string().min(1),
    quantity: z.number().int().positive().max(1_000_000),
    unitPriceCents: z.number().int().nonnegative().optional(),
    allowMissingProduct: z.boolean().optional().default(false),
    allowMissingPresentation: z.boolean().optional().default(false),
    selections: z.array(selection).max(100).optional().default([]),
  }).strict()).min(1).max(100),
}).strict();

type Draft = z.infer<typeof orderDraftValidationSchema>;
interface DraftIssue {
  entity: "client" | "product" | "presentation" | "combo" | "selection";
  lineIndex?: number;
  code: string;
  message: string;
}

const inactive = (row: any) => row?.active === false || row?.active === 0;

/**
 * Preflight informativo sin escrituras: la creación transaccional vuelve a validar.
 * allowMissing solo identifica padres creados localmente aún sin ACK; jamás omite
 * una baja conocida, y no forma parte del contrato de creación de pedidos.
 */
export async function validateOrderDraft(client: PoolClient, draft: Draft, checkedAt: string) {
  const issues: DraftIssue[] = [];
  let unchecked = false;
  const { rows } = await client.query(
    `SELECT id, business_name, contact_name, name, active, updated_at FROM clients
     WHERE id = $1 OR client_local_id = $1
     ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END LIMIT 1`,
    [draft.clientId]
  );
  const customer = rows[0];
  let historicalCustomer = false;
  if (customer && inactive(customer) && draft.editingOrderId) {
    historicalCustomer = (await client.query(
      `SELECT id FROM orders WHERE (id = $1 OR idempotency_key = $1) AND client_id = $2 LIMIT 1`,
      [draft.editingOrderId, customer.id]
    )).rows.length > 0;
  }
  if (!customer) {
    if (draft.allowMissingClient) unchecked = true;
    else issues.push({ entity: "client", code: "CLIENT_UNAVAILABLE", message: "El cliente fue eliminado o ya no está disponible. Selecciona otro cliente antes de guardar." });
  } else if (inactive(customer) && !historicalCustomer) {
    issues.push({ entity: "client", code: "CLIENT_UNAVAILABLE", message: "El cliente fue eliminado en otro dispositivo. Selecciona otro cliente antes de guardar." });
  }

  const catalog = await loadOrderCatalog(client, draft.items);
  // El lookup normal de opciones devuelve solo activas. Una opción conocida
  // pero desactivada no debe confundirse con una alta local aún no publicada.
  const unresolvedSelectionIds = [...new Set(draft.items.flatMap(item => item.selections
    .filter(value => value.allowMissing && !catalog.selections.has(value.selectedPresentationId))
    .map(value => value.selectedPresentationId)))];
  const knownUnavailableSelections = unresolvedSelectionIds.length > 0 ? new Set((await client.query(
    `SELECT pp.id FROM product_presentations pp JOIN products p ON p.id = pp.product_id
     WHERE pp.id = ANY($1::text[])`, [unresolvedSelectionIds]
  )).rows.map(row => String(row.id))) : new Set<string>();
  const items = draft.items.map((item, lineIndex) => {
    const product = catalog.products.get(item.productId);
    const presentation = catalog.presentations.get(item.presentationId);
    const definition = product ? catalog.definitions.get(product.id) : null;
    const options = definition ? catalog.options.filter(option => option.combo_id === definition.id) : [];
    const metadata = {
      lineIndex, productId: item.productId, presentationId: item.presentationId,
      productName: product?.name ?? null, sku: product?.sku ?? null,
      presentationName: presentation?.name ?? null,
      unitEquivalence: presentation?.unit_equivalence ?? null,
      priceCents: presentation?.price_cents ?? null, productType: product?.product_type ?? null,
      comboDefinition: definition ? {
        selectionMin: Number(definition.selection_min), selectionMax: Number(definition.selection_max),
        options: options.map(option => ({ presentationId: String(option.presentation_id), maxQuantity: option.max_quantity == null ? null : Number(option.max_quantity) })),
      } : null,
      selections: [] as Array<{ selectedProductId: string; selectedPresentationId: string; productName: string; presentationName: string; quantity: number }>,
      unchecked: false,
    };
    const add = (entity: DraftIssue["entity"], code: string, message: string) => issues.push({ entity, lineIndex, code, message });
    if (!product) {
      if (item.allowMissingProduct) { unchecked = true; metadata.unchecked = true; }
      else add("product", "PRODUCT_UNAVAILABLE", "Un producto de la preventa fue eliminado o ya no está disponible. Retíralo del carrito.");
    } else if (inactive(product)) {
      add("product", "PRODUCT_UNAVAILABLE", `El producto "${product.name}" fue eliminado en otro dispositivo. Retíralo del carrito.`);
    }
    if (!presentation) {
      if (item.allowMissingPresentation) { unchecked = true; metadata.unchecked = true; }
      else add("presentation", "PRESENTATION_UNAVAILABLE", "Una presentación fue eliminada o ya no está disponible. Vuelve a elegirla.");
    } else if (inactive(presentation)) {
      add("presentation", "PRESENTATION_UNAVAILABLE", `La presentación "${presentation.name}" ya no está disponible. Vuelve a elegirla.`);
    } else if (presentation.product_id !== item.productId) {
      add("presentation", "PRESENTATION_MISMATCH", "La presentación ya no corresponde al producto seleccionado. Vuelve a elegir el producto.");
    }
    // Un combo recién creado localmente se valida en SQLite hasta subir su padre.
    if (!product || !presentation || inactive(product) || inactive(presentation)) return metadata;
    if (product.product_type !== "combo") {
      if (item.selections.length > 0) add("combo", "COMBO_CHANGED", `"${product.name}" ya no está configurado como combo. Vuelve a agregarlo al carrito.`);
      return metadata;
    }
    if (!definition) {
      add("combo", "COMBO_CHANGED", `El combo "${product.name}" ya no tiene una configuración activa. Vuelve a elegir el producto.`);
      return metadata;
    }
    const total = item.selections.reduce((sum, value) => sum + value.quantity, 0);
    if (total < definition.selection_min || total > definition.selection_max || item.selections.length === 0) {
      add("combo", "COMBO_CHANGED", `La configuración de "${product.name}" cambió: debes seleccionar entre ${definition.selection_min} y ${definition.selection_max} unidades.`);
    }
    const quantities = new Map<string, number>();
    for (const selected of item.selections) {
      const selectedPresentation = catalog.selections.get(selected.selectedPresentationId);
      if (!selectedPresentation) {
        if (selected.allowMissing && !knownUnavailableSelections.has(selected.selectedPresentationId)) { unchecked = true; metadata.unchecked = true; }
        else add("selection", "SELECTION_UNAVAILABLE", `Una opción de "${product.name}" fue eliminada o está inactiva. Vuelve a configurar el combo.`);
        continue;
      }
      if (selectedPresentation.prod_id !== selected.selectedProductId) {
        add("selection", "SELECTION_MISMATCH", "La opción elegida no pertenece al producto seleccionado. Vuelve a configurar el combo.");
        continue;
      }
      metadata.selections.push({
        selectedProductId: selectedPresentation.prod_id, selectedPresentationId: selected.selectedPresentationId,
        productName: selectedPresentation.prod_name, presentationName: selectedPresentation.pres_name, quantity: selected.quantity,
      });
      const option = options.find(value => value.presentation_id === selected.selectedPresentationId);
      if (!option) {
        add("combo", "COMBO_CHANGED", `Una opción seleccionada ya no pertenece a "${product.name}". Vuelve a configurar el combo.`);
        continue;
      }
      const aggregate = (quantities.get(option.id) || 0) + selected.quantity;
      quantities.set(option.id, aggregate);
      if (option.max_quantity != null && aggregate > option.max_quantity) {
        add("combo", "COMBO_CHANGED", `Cambió el límite de una opción de "${product.name}". Vuelve a configurar el combo.`);
      }
    }
    return metadata;
  });
  return {
    valid: issues.length === 0, checkedAt, unchecked,
    client: customer ? {
      id: customer.id, businessName: customer.business_name ?? null, contactName: customer.contact_name ?? null,
      name: customer.name ?? customer.business_name ?? null, active: !inactive(customer), updatedAt: customer.updated_at ?? null,
    } : null,
    issues, items,
  };
}

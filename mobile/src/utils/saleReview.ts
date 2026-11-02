import type { CartLine, Client, ComboCatalogSnapshot, ComboDefinition } from "../domain/types";
import { calcOrderTotals, centsToBs, updateLineUnitPrice } from "../domain/pricing";
import type { SaleDraftResponse } from "../services/saleValidation";

function normalizedCombo(snapshot: ComboCatalogSnapshot): ComboCatalogSnapshot {
  return {
    selectionMin: snapshot.selectionMin,
    selectionMax: snapshot.selectionMax,
    options: snapshot.options.map((option) => ({ presentationId: option.presentationId, maxQuantity: option.maxQuantity ?? null }))
      .sort((a, b) => a.presentationId.localeCompare(b.presentationId)),
  };
}

/** Copia la configuración completa, incluso las opciones que no se eligieron. */
export function captureComboCatalog(definition: ComboDefinition | null | undefined): ComboCatalogSnapshot | undefined {
  if (!definition) return undefined;
  return normalizedCombo({
    selectionMin: definition.selection_min,
    selectionMax: definition.selection_max,
    options: definition.options.filter((option) => option.active !== 0).map((option) => ({
      presentationId: option.presentation_id,
      maxQuantity: option.max_quantity,
    })),
  });
}

/** Identifica exactamente el borrador que revisó el vendedor, incluidos sus snapshots. */
export function saleDraftKey(clientId: string, lines: CartLine[], editingOrderId?: string): string {
  return JSON.stringify([clientId, editingOrderId || null, lines.map(line => [
    line.productId, line.presentationId, line.productName, line.sku, line.presentationName,
    line.unitEquivalence, line.unitPriceCents, line.quantity, Boolean(line.isCombo),
    (line.selections || []).map(selection => [selection.selectedProductId, selection.selectedPresentationId,
      selection.productNameSnapshot, selection.presentationNameSnapshot, selection.quantity, selection.sortOrder]),
    line.comboCatalogSnapshot && normalizedCombo(line.comboCatalogSnapshot),
  ])]);
}

/** El precio elegido se limita a este carrito y a esta versión del catálogo remoto. */
export function saleCatalogKey(response: SaleDraftResponse): string {
  return JSON.stringify([
    response.client && [response.client.id, response.client.businessName, response.client.contactName, response.client.name, response.client.active],
    response.items.map(item => [item.lineIndex, item.productId, item.presentationId,
      item.productName, item.sku, item.presentationName, item.unitEquivalence, item.priceCents, item.productType,
      item.comboDefinition && [item.comboDefinition.selectionMin, item.comboDefinition.selectionMax,
        [...item.comboDefinition.options].sort((a, b) => a.presentationId.localeCompare(b.presentationId))],
      item.selections, item.unchecked]),
  ]);
}

export function reviewSaleCatalog(
  client: Client,
  lines: CartLine[],
  response: SaleDraftResponse,
  approvedHistoricalPrices?: ReadonlyMap<string, number>
) {
  const changes: string[] = [];
  let priceChanged = false;
  const refreshedClient: Client = response.client ? {
    ...client, business_name: response.client.businessName, name: response.client.name,
    contact_name: response.client.contactName, owner_name: response.client.contactName,
  } : client;
  if (response.client && ((client.business_name || client.name || "") !== (response.client.businessName || response.client.name || "") ||
      (client.contact_name || client.owner_name || "") !== (response.client.contactName || ""))) {
    changes.push("El nombre del cliente cambió en otro dispositivo.");
  }
  const metadata = new Map(response.items.map(item => [item.lineIndex, item]));
  const preservedLines = lines.map((line, index) => {
    const item = metadata.get(index);
    if (!item) return line;
    const currentCombo = item.comboDefinition ? normalizedCombo(item.comboDefinition) : undefined;
    if (item.knownComboDefinition && currentCombo &&
        JSON.stringify(normalizedCombo(item.knownComboDefinition)) !== JSON.stringify(currentCombo)) {
      changes.push(`La configuración del combo ${item.productName ?? line.productName} cambió en otro dispositivo. Revisa sus opciones y límites.`);
    }
    const updated: CartLine = {
      ...line, productName: item.productName ?? line.productName, sku: item.sku ?? line.sku,
      presentationName: item.presentationName ?? line.presentationName,
      unitEquivalence: item.unitEquivalence ?? line.unitEquivalence,
      isCombo: item.productType ? item.productType === "combo" : line.isCombo,
      ...(currentCombo ? { comboCatalogSnapshot: currentCombo } : {}),
      selections: line.selections?.map((selection, position) => {
        // Las altas locales aún no publicadas pueden dejar metadatos parciales.
        const current = item.selections.length === line.selections!.length ? item.selections[position] : undefined;
        return current ? { ...selection, productNameSnapshot: current.productName ?? selection.productNameSnapshot,
          presentationNameSnapshot: current.presentationName ?? selection.presentationNameSnapshot } : selection;
      }),
    };
    if (updated.productName !== line.productName || updated.sku !== line.sku ||
        updated.presentationName !== line.presentationName || updated.unitEquivalence !== line.unitEquivalence ||
        Boolean(updated.isCombo) !== Boolean(line.isCombo) ||
        JSON.stringify(updated.selections || []) !== JSON.stringify(line.selections || [])) {
      changes.push(`Se actualizaron los datos de ${line.productName} (${line.presentationName}).`);
    }
    if (item.priceCents != null && item.priceCents !== line.unitPriceCents &&
        approvedHistoricalPrices?.get(line.presentationId) !== item.priceCents) {
      priceChanged = true;
      changes.push(`${updated.productName} (${updated.presentationName}): ${centsToBs(line.unitPriceCents)} → ${centsToBs(item.priceCents)}.`);
    }
    return updated;
  });
  const currentLines = preservedLines.map((line, index) => {
    const price = metadata.get(index)?.priceCents;
    return price != null ? updateLineUnitPrice(line, price) : line;
  });
  return {
    changes, priceChanged, refreshedClient, preservedLines, currentLines,
    previousTotalCents: calcOrderTotals(lines).totalCents,
    currentTotalCents: calcOrderTotals(currentLines).totalCents,
    catalogKey: saleCatalogKey(response),
  };
}

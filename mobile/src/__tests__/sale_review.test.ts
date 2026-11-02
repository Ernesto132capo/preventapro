import type { CartLine, Client, ComboCatalogSnapshot, ComboDefinition } from "../domain/types";
import type { SaleDraftResponse } from "../services/saleValidation";
import { captureComboCatalog, reviewSaleCatalog, saleCatalogKey, saleDraftKey } from "../utils/saleReview";

const client = {
  id: "local-client", server_id: "remote-client", business_name: "Tienda", name: "Tienda",
  contact_name: "Rosa", owner_name: "Rosa", active: 1,
} as Client;
const standard: CartLine = {
  productId: "local-product", presentationId: "local-pres", productName: "Papa", sku: "P1",
  presentationName: "Unidad", unitEquivalence: 1, unitPriceCents: 1001, quantity: 2, subtotalCents: 2002,
};
const combo: CartLine = {
  productId: "local-combo", presentationId: "local-combo-pres", productName: "Combo", sku: "C1",
  presentationName: "Pack", unitEquivalence: 1, unitPriceCents: 101, quantity: 3, subtotalCents: 303,
  isCombo: true,
  selections: [
    { selectedProductId: "local-a", selectedPresentationId: "local-a-pres", productNameSnapshot: "A", presentationNameSnapshot: "Unidad A", quantity: 2, sortOrder: 0 },
    { selectedProductId: "local-b", selectedPresentationId: "local-b-pres", productNameSnapshot: "B", presentationNameSnapshot: "Unidad B", quantity: 1, sortOrder: 1 },
  ],
};

function responseFor(lines: CartLine[]): SaleDraftResponse {
  return {
    valid: true, checkedAt: "2026-10-24T12:00:00.000Z", unchecked: false,
    client: { id: "remote-client", businessName: "Tienda", name: "Tienda", contactName: "Rosa", active: true, updatedAt: "2026-10-23T12:00:00.000Z" },
    issues: [],
    items: lines.map((line, lineIndex) => ({
      lineIndex, productId: `remote-product-${lineIndex}`, presentationId: `remote-pres-${lineIndex}`,
      productName: line.productName, sku: line.sku, presentationName: line.presentationName,
      unitEquivalence: line.unitEquivalence, priceCents: line.unitPriceCents,
      productType: line.isCombo ? "combo" : "standard",
      comboDefinition: line.isCombo ? { selectionMin: 3, selectionMax: 3,
        options: [{ presentationId: "remote-a-pres", maxQuantity: 2 }, { presentationId: "remote-b-pres", maxQuantity: 1 }] } : null,
      selections: (line.selections || []).map((selection, index) => ({
        selectedProductId: `remote-component-${index}`, selectedPresentationId: `remote-component-pres-${index}`,
        productName: selection.productNameSnapshot, presentationName: selection.presentationNameSnapshot,
        quantity: selection.quantity,
      })),
      unchecked: false,
    })),
  };
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("Revisión de snapshots, precios y metadatos del carrito", () => {
  it("calcula totales actuales y preservados en centavos sin modificar el carrito original", () => {
    const lines = [copy(standard)];
    const original = copy(lines);
    const response = responseFor(lines);
    response.items[0].priceCents = 2002;
    const result = reviewSaleCatalog(client, lines, response);
    expect(result.priceChanged).toBe(true);
    expect(result.previousTotalCents).toBe(2002);
    expect(result.currentTotalCents).toBe(4004);
    expect(result.preservedLines[0]).toMatchObject({ unitPriceCents: 1001, quantity: 2, subtotalCents: 2002 });
    expect(result.currentLines[0]).toMatchObject({ unitPriceCents: 2002, quantity: 2, subtotalCents: 4004 });
    expect(result.changes).toEqual(["Papa (Unidad): Bs. 10.01 → Bs. 20.02."]);
    expect(lines).toEqual(original);
  });

  it("suma productos y múltiples combos de la misma presentación sin mezclarlos", () => {
    const lines = [copy(standard), copy(combo), { ...copy(combo), quantity: 2, subtotalCents: 202 }];
    const response = responseFor(lines);
    response.items[0].priceCents = 1002;
    response.items[1].priceCents = 103;
    response.items[2].priceCents = 103;
    const result = reviewSaleCatalog(client, lines, response);
    expect(result.previousTotalCents).toBe(2507);
    expect(result.currentTotalCents).toBe(2519);
    expect(result.preservedLines.map(line => line.subtotalCents)).toEqual([2002, 303, 202]);
    expect(result.currentLines.map(line => line.subtotalCents)).toEqual([2004, 309, 206]);
    expect(result.currentLines[1].selections).toEqual(combo.selections);
    expect(result.currentLines[2].selections).toEqual(combo.selections);
  });

  it("reconoce un precio vigente de cero en lugar de ignorarlo como un valor vacío", () => {
    const response = responseFor([standard]);
    response.items[0].priceCents = 0;
    const result = reviewSaleCatalog(client, [standard], response);
    expect(result.priceChanged).toBe(true);
    expect(result.currentTotalCents).toBe(0);
    expect(result.currentLines[0]).toMatchObject({ unitPriceCents: 0, subtotalCents: 0 });
    expect(result.preservedLines[0].unitPriceCents).toBe(1001);
  });

  it("conserva los precios cuando la metadata de una presentación local es incompleta", () => {
    const response = responseFor([standard]);
    response.items[0] = { ...response.items[0], productName: null, sku: null, presentationName: null,
      unitEquivalence: null, priceCents: null, productType: null, unchecked: true };
    const result = reviewSaleCatalog(client, [standard], response);
    expect(result.priceChanged).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.currentTotalCents).toBe(2002);
    expect(result.currentLines[0]).toEqual(standard);
  });

  it("refresca nombres sin reemplazar IDs locales del cliente, producto, presentación o componentes", () => {
    const response = responseFor([combo]);
    response.client!.businessName = "Tienda actualizada";
    response.items[0].productName = "Combo nuevo";
    response.items[0].selections[0].productName = "A nuevo";
    response.items[0].selections[0].presentationName = "Caja A";
    const result = reviewSaleCatalog(client, [combo], response);
    expect(result.refreshedClient.id).toBe("local-client");
    expect(result.refreshedClient.server_id).toBe("remote-client");
    expect(result.preservedLines[0]).toMatchObject({ productId: "local-combo", presentationId: "local-combo-pres", productName: "Combo nuevo" });
    expect(result.preservedLines[0].selections![0]).toMatchObject({ selectedProductId: "local-a", selectedPresentationId: "local-a-pres",
      productNameSnapshot: "A nuevo", presentationNameSnapshot: "Caja A", quantity: 2, sortOrder: 0 });
    expect(result.currentLines[0].selections![1].selectedPresentationId).toBe("local-b-pres");
  });

  it("no cruza los nombres de opciones cuando solo hay metadata de una parte del combo", () => {
    const response = responseFor([combo]);
    response.items[0].selections = [{ ...response.items[0].selections[1], productName: "B actualizado" }];
    response.items[0].unchecked = true;
    const result = reviewSaleCatalog(client, [combo], response);
    expect(result.preservedLines[0].selections).toEqual(combo.selections);
    expect(result.preservedLines[0].selections![0].productNameSnapshot).toBe("A");
    expect(result.preservedLines[0].selections![1].productNameSnapshot).toBe("B");
    expect(result.changes).toEqual([]);
  });

  it("los nombres nulos de las opciones conservan los snapshots existentes", () => {
    const response = responseFor([combo]);
    response.items[0].selections[0].productName = null;
    response.items[0].selections[0].presentationName = null;
    const result = reviewSaleCatalog(client, [combo], response);
    expect(result.preservedLines[0].selections).toEqual(combo.selections);
    expect(result.changes).toEqual([]);
  });

  it("una elección histórica aceptada no vuelve a alertar para el mismo precio vigente", () => {
    const response = responseFor([standard]);
    response.items[0].priceCents = 2002;
    const approved = new Map([[standard.presentationId, 2002]]);
    const result = reviewSaleCatalog(client, [standard], response, approved);
    expect(result.priceChanged).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.preservedLines[0].unitPriceCents).toBe(1001);
    expect(result.previousTotalCents).toBe(2002);
    expect(result.currentTotalCents).toBe(4004);
  });

  it("vuelve a advertir si el catálogo cambió después de aceptar el precio histórico", () => {
    const response = responseFor([standard]);
    response.items[0].priceCents = 2003;
    const result = reviewSaleCatalog(client, [standard], response, new Map([[standard.presentationId, 2002]]));
    expect(result.priceChanged).toBe(true);
    expect(result.changes).toEqual(["Papa (Unidad): Bs. 10.01 → Bs. 20.03."]);
    expect(result.currentTotalCents).toBe(4006);
  });

  it("acepta también la elección histórica frente a un precio vigente de cero", () => {
    const response = responseFor([standard]);
    response.items[0].priceCents = 0;
    const result = reviewSaleCatalog(client, [standard], response, new Map([[standard.presentationId, 0]]));
    expect(result.priceChanged).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.preservedLines[0].unitPriceCents).toBe(1001);
    expect(result.currentTotalCents).toBe(0);
  });

  it("detecta renombrados de cliente/producto/presentación y cambios de equivalencia sin alterar importes", () => {
    const response = responseFor([standard]);
    Object.assign(response.client!, { businessName: "Nueva tienda", name: "Nueva tienda", contactName: "Luis" });
    Object.assign(response.items[0], { productName: "Papa nueva", presentationName: "Bolsa", sku: "P2", unitEquivalence: 5 });
    const result = reviewSaleCatalog(client, [standard], response);
    expect(result.refreshedClient).toMatchObject({ business_name: "Nueva tienda", name: "Nueva tienda", contact_name: "Luis", owner_name: "Luis" });
    expect(result.preservedLines[0]).toMatchObject({ productName: "Papa nueva", presentationName: "Bolsa", sku: "P2", unitEquivalence: 5, unitPriceCents: 1001 });
    expect(result.priceChanged).toBe(false);
    expect(result.changes).toEqual(["El nombre del cliente cambió en otro dispositivo.", "Se actualizaron los datos de Papa (Unidad)."]);
    expect(result.currentTotalCents).toBe(result.previousTotalCents);
  });

  it("asocia los metadatos a lineIndex aunque la respuesta de líneas esté en otro orden", () => {
    const lines = [standard, combo];
    const response = responseFor(lines);
    response.items[0].priceCents = 10;
    response.items[1].priceCents = 20;
    response.items.reverse();
    const result = reviewSaleCatalog(client, lines, response);
    expect(result.currentLines.map(line => line.unitPriceCents)).toEqual([10, 20]);
    expect(result.currentTotalCents).toBe(80);
  });

  it("un cliente local aún sin metadata no provoca un renombrado ficticio", () => {
    const response = responseFor([standard]);
    response.client = null;
    const result = reviewSaleCatalog(client, [standard], response);
    expect(result.refreshedClient).toBe(client);
    expect(result.changes).toEqual([]);
  });
});

describe("Claves de aprobación limitadas al carrito y catálogo revisados", () => {
  it.each([
    ["precio", (line: CartLine) => { line.unitPriceCents++; }],
    ["cantidad", (line: CartLine) => { line.quantity++; }],
    ["producto", (line: CartLine) => { line.productName += " nuevo"; }],
    ["presentación", (line: CartLine) => { line.presentationName += " nueva"; }],
    ["equivalencia", (line: CartLine) => { line.unitEquivalence++; }],
    ["SKU", (line: CartLine) => { line.sku += "2"; }],
    ["opción", (line: CartLine) => { line.selections![0].productNameSnapshot += " nueva"; }],
    ["cantidad opción", (line: CartLine) => { line.selections![0].quantity++; }],
  ])("la clave del borrador cambia al modificar %s", (_name, change) => {
    const before = saleDraftKey(client.id, [combo], "order");
    const changed = copy(combo);
    (change as (line: CartLine) => void)(changed);
    expect(saleDraftKey(client.id, [changed], "order")).not.toBe(before);
  });

  it("cambiar cliente o pedido invalida la aprobación; un subtotal derivado no la altera", () => {
    const key = saleDraftKey(client.id, [standard], "order");
    expect(saleDraftKey("otro-cliente", [standard], "order")).not.toBe(key);
    expect(saleDraftKey(client.id, [standard], "otro-order")).not.toBe(key);
    expect(saleDraftKey(client.id, [{ ...standard, subtotalCents: 999999 }], "order")).toBe(key);
  });

  it("checkedAt y updatedAt no causan una nueva aprobación sin cambios en datos", () => {
    const response = responseFor([combo]);
    const later = copy(response);
    later.checkedAt = "2026-10-25T12:00:00.000Z";
    later.client!.updatedAt = "2026-10-25T12:00:00.000Z";
    expect(saleCatalogKey(later)).toBe(saleCatalogKey(response));
  });

  it.each([
    ["precio", (response: SaleDraftResponse) => { response.items[0].priceCents!++; }],
    ["nombre producto", (response: SaleDraftResponse) => { response.items[0].productName += " nuevo"; }],
    ["nombre cliente", (response: SaleDraftResponse) => { response.client!.businessName += " nueva"; }],
    ["cliente", (response: SaleDraftResponse) => { response.client!.id = "otro"; }],
    ["equivalencia", (response: SaleDraftResponse) => { response.items[0].unitEquivalence!++; }],
    ["regla combo", (response: SaleDraftResponse) => { response.items[0].comboDefinition!.selectionMax++; }],
    ["límite opción", (response: SaleDraftResponse) => { response.items[0].comboDefinition!.options[0].maxQuantity!++; }],
    ["nombre opción", (response: SaleDraftResponse) => { response.items[0].selections[0].productName += " nuevo"; }],
  ])("la clave del catálogo cambia al modificar %s", (_name, change) => {
    const response = responseFor([combo]);
    const before = saleCatalogKey(response);
    (change as (response: SaleDraftResponse) => void)(response);
    expect(saleCatalogKey(response)).not.toBe(before);
  });

  it("ordenar opciones equivalentes del combo no invalida una aprobación", () => {
    const response = responseFor([combo]);
    const key = saleCatalogKey(response);
    response.items[0].comboDefinition!.options.reverse();
    expect(saleCatalogKey(response)).toBe(key);
  });
});

describe("Cambios de configuración de combos que todavía admiten el carrito", () => {
  const baseline: ComboCatalogSnapshot = {
    selectionMin: 3, selectionMax: 3,
    options: [{ presentationId: "remote-a-pres", maxQuantity: 2 }, { presentationId: "remote-b-pres", maxQuantity: 1 }],
  };

  it("captura una copia completa ordenada del catálogo, incluidas opciones no seleccionadas", () => {
    const definition = { id: "def", product_id: "combo", selection_min: 1, selection_max: 5, options: [
      { id: "opt-z", combo_id: "def", presentation_id: "local-z", max_quantity: 3, sort_order: 0, active: 1 },
      { id: "opt-a", combo_id: "def", presentation_id: "remote-a", max_quantity: null, sort_order: 1 },
      { id: "opt-disabled", combo_id: "def", presentation_id: "disabled", max_quantity: 1, sort_order: 2, active: 0 },
    ] } as ComboDefinition;
    const snapshot = captureComboCatalog(definition)!;
    expect(snapshot).toEqual({ selectionMin: 1, selectionMax: 5, options: [
      { presentationId: "local-z", maxQuantity: 3 }, { presentationId: "remote-a", maxQuantity: null },
    ] });
    definition.options[0].max_quantity = 99;
    expect(snapshot.options[0].maxQuantity).toBe(3);
    expect(captureComboCatalog(null)).toBeUndefined();
    expect(captureComboCatalog(undefined)).toBeUndefined();
  });

  it.each([
    ["mínimo", (snapshot: ComboCatalogSnapshot) => { snapshot.selectionMin = 2; }],
    ["máximo", (snapshot: ComboCatalogSnapshot) => { snapshot.selectionMax = 4; }],
    ["opción añadida", (snapshot: ComboCatalogSnapshot) => { snapshot.options.push({ presentationId: "remote-c-pres", maxQuantity: 2 }); }],
    ["opción quitada", (snapshot: ComboCatalogSnapshot) => { snapshot.options.pop(); }],
    ["límite de opción", (snapshot: ComboCatalogSnapshot) => { snapshot.options[0].maxQuantity = 4; }],
  ])("advierte cuando cambia %s sin modificar precios ni cantidades", (_name, change) => {
    const line = { ...copy(combo), comboCatalogSnapshot: copy(baseline) };
    const response = responseFor([line]);
    response.items[0].knownComboDefinition = copy(baseline);
    if (_name === "opción quitada") {
      // Quitar una alternativa no elegida mantiene válida la selección A/B del carrito.
      const extra = { presentationId: "remote-c-pres", maxQuantity: 2 };
      line.comboCatalogSnapshot.options.push({ ...extra });
      response.items[0].knownComboDefinition.options.push({ ...extra });
      response.items[0].comboDefinition!.options.push({ ...extra });
    }
    (change as (snapshot: ComboCatalogSnapshot) => void)(response.items[0].comboDefinition!);
    const result = reviewSaleCatalog(client, [line], response);
    expect(result.priceChanged).toBe(false);
    expect(result.changes).toEqual(["La configuración del combo Combo cambió en otro dispositivo. Revisa sus opciones y límites."]);
    expect(result.currentTotalCents).toBe(303);
    expect(result.previousTotalCents).toBe(303);
    expect(result.preservedLines[0].quantity).toBe(3);
    expect(result.preservedLines[0].unitPriceCents).toBe(101);
    expect(result.preservedLines[0].selections).toEqual(combo.selections);
    expect(result.preservedLines[0].comboCatalogSnapshot).toEqual(result.currentLines[0].comboCatalogSnapshot);
    expect(result.preservedLines[0].comboCatalogSnapshot).toEqual(expect.objectContaining({
      selectionMin: response.items[0].comboDefinition!.selectionMin,
      selectionMax: response.items[0].comboDefinition!.selectionMax,
    }));
  });

  it("no repite el aviso después de revisar y adoptar la nueva configuración remota", () => {
    const line = { ...copy(combo), comboCatalogSnapshot: copy(baseline) };
    const response = responseFor([line]);
    response.items[0].knownComboDefinition = copy(baseline);
    response.items[0].comboDefinition!.selectionMax = 5;
    const first = reviewSaleCatalog(client, [line], response);
    expect(first.changes).toHaveLength(1);
    const nextResponse = copy(response);
    nextResponse.items[0].knownComboDefinition = copy(first.preservedLines[0].comboCatalogSnapshot!);
    const second = reviewSaleCatalog(client, first.preservedLines, nextResponse);
    expect(second.changes).toEqual([]);
    expect(second.preservedLines[0].selections).toEqual(combo.selections);
  });

  it("un orden distinto de opciones es equivalente después de normalizar IDs", () => {
    const line = { ...copy(combo), comboCatalogSnapshot: copy(baseline) };
    const response = responseFor([line]);
    response.items[0].knownComboDefinition = copy(baseline);
    response.items[0].knownComboDefinition.options.reverse();
    expect(reviewSaleCatalog(client, [line], response).changes).toEqual([]);
  });

  it("la clave de borrador incluye su baseline pero la clave de catálogo ignora el baseline local", () => {
    const line = { ...copy(combo), comboCatalogSnapshot: copy(baseline) };
    const changed = copy(line);
    changed.comboCatalogSnapshot.selectionMax++;
    expect(saleDraftKey(client.id, [line])).not.toBe(saleDraftKey(client.id, [changed]));
    const reordered = copy(line);
    reordered.comboCatalogSnapshot.options.reverse();
    expect(saleDraftKey(client.id, [line])).toBe(saleDraftKey(client.id, [reordered]));
    const response = responseFor([line]);
    const before = saleCatalogKey(response);
    response.items[0].knownComboDefinition = copy(baseline);
    expect(saleCatalogKey(response)).toBe(before);
    response.items[0].knownComboDefinition.selectionMax++;
    expect(saleCatalogKey(response)).toBe(before);
  });
});

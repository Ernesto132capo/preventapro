import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";
import { reviewSaleCatalog, saleDraftKey } from "../utils/saleReview";

// Ejecuta componentes/handlers de producción. No sustituye pruebas táctiles en Android.
function compile(source: string, fileName: string) {
  return ts.transpileModule(source, { fileName, compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
}

function walk(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) { const found = walk(child, predicate); if (found) return found; }
  } else if (node && typeof node === "object") {
    if (predicate(node)) return node;
    return walk(node.props?.children, predicate);
  }
  return undefined;
}
function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return textOf(node?.props?.children || []);
}

function comboHarness() {
  const slots: any[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  const react = {
    memo: (fn: any) => fn,
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: (fn: any) => fn(),
    useEffect: (effect: () => void, deps: any[]) => {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index][i]))) {
        slots[index] = deps;
        effects.push(effect);
      }
    },
  };
  const native: any = { StyleSheet: { create: (value: any) => value }, Alert: { alert: jest.fn() } };
  for (const name of ["View", "Text", "TextInput", "Modal", "FlatList", "Pressable"]) native[name] = name;
  const dependencies: Record<string, unknown> = {
    react, "react-native": native,
    "../theme/tokens": { colors: {}, spacing: {}, radius: {}, touchTarget: {} },
    "./Button": { Button: "Button" }, "./Card": { Card: "Card" },
    "../domain/pricing": { centsToBs: (n: number) => String(n / 100) },
    "../utils/useDebounce": { useDebounce: (value: any) => value },
  };
  const module = { exports: {} as any };
  const file = path.join(__dirname, "../components/ComboSelectorModal.tsx");
  vm.runInNewContext(compile(fs.readFileSync(file, "utf8"), file), {
    module, exports: module.exports,
    require: (name: string) => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; },
  });
  const onAdd = jest.fn();
  const onClose = jest.fn();
  function render(product: any, presentation: any, visible = Boolean(product)) {
    let tree: any;
    let attempts = 0;
    do {
      if (++attempts > 10) throw new Error("Render inestable");
      cursor = 0; dirty = false; effects = [];
      tree = module.exports.ComboSelectorModal({ visible, product, presentation, onAdd, onClose });
      for (const effect of effects) effect();
    } while (dirty);
    return tree;
  }
  return { render, onAdd, onClose, alerts: native.Alert.alert };
}

const productFor = (id: string, option: string) => ({
  id, name: id, combo_definition: {
    selection_min: 1, selection_max: 1,
    options: [{ id: option, presentation_id: option, product_id: "normal-" + option,
      product_name: option, presentation_name: "Unidad", max_quantity: 1 }],
  },
});
const presentationFor = (id: string) => ({ id, name: "Combo", price_cents: 2000 });
const addButton = (tree: any) => walk(tree, (node) => node.type === "Button" && node.props.label === "Agregar combo");
function selectOption(tree: any) {
  const list = walk(tree, (node) => node.type === "FlatList");
  const row = list.props.renderItem({ item: list.props.data[0] });
  walk(row, (node) => node.type === "Pressable" && textOf(node) === "+").props.onPress();
}

describe("Selecciones del modal real de combos", () => {
  it.each(["distinta", "compartida"])("cancelar A y abrir B reinicia la selección aunque su opción sea %s", (kind) => {
    const h = comboHarness();
    const a = productFor("A", "opcion-a");
    const b = productFor("B", kind === "compartida" ? "opcion-a" : "opcion-b");
    const pa = presentationFor("pres-a"), pb = presentationFor("pres-b");
    selectOption(h.render(a, pa));
    const staleAdd = addButton(h.render(a, pa)).props.onPress;
    expect(addButton(h.render(a, pa)).props.disabled).toBe(false);
    h.render(null, null, false);
    const treeB = h.render(b, pb);
    expect(addButton(treeB).props.disabled).toBe(true);
    addButton(treeB).props.onPress();
    staleAdd();
    expect(h.onAdd).not.toHaveBeenCalled();
    selectOption(treeB);
    addButton(h.render(b, pb)).props.onPress();
    expect(h.onAdd).toHaveBeenCalledTimes(1);
    expect(h.onAdd.mock.calls[0][0].id).toBe("B");
    expect(h.onAdd.mock.calls[0][3]).toMatchObject([{ selectedPresentationId: b.combo_definition.options[0].presentation_id, quantity: 1 }]);
  });

  it("reabrir el mismo combo limpia búsqueda, selección y cantidad de combos", () => {
    const h = comboHarness();
    const p = productFor("A", "opcion-a"), pres = presentationFor("pres-a");
    let tree = h.render(p, pres);
    selectOption(tree);
    walk(tree, (node) => node.type === "TextInput").props.onChangeText("texto anterior");
    tree = h.render(p, pres);
    walk(tree, (node) => node.type === "Pressable" && textOf(node) === "+").props.onPress();
    h.render(p, pres, false);
    tree = h.render(p, pres);
    expect(walk(tree, (node) => node.type === "TextInput").props.value).toBe("");
    expect(addButton(tree).props.disabled).toBe(true);
    selectOption(tree);
    addButton(h.render(p, pres)).props.onPress();
    expect(h.onAdd.mock.calls[0][2]).toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function saveHarness(editing = false) {
  const fileName = path.join(__dirname, "../screens/NewSaleScreen.tsx");
  const source = ts.createSourceFile(fileName, fs.readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "executeSaveOrder") handler = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!handler) throw new Error("No se encontró el handler de guardado real");
  const scope: any = {
    saveInFlightRef: { current: false }, selectedClient: { id: "client", business_name: "Tienda", contact_name: null }, user: { id: "user" },
    setSaving: jest.fn(), setError: jest.fn(), setWorkDay: jest.fn(), setCart: jest.fn(),
    setSelectedClient: jest.fn(), setCartModalVisible: jest.fn(), setFinalConfirmModalVisible: jest.fn(), setStep: jest.fn(),
    getTodayWorkDay: jest.fn(async () => ({ id: "day", status: "open" })),
    apiFetch: jest.fn(() => { throw new Error("La red no debe preceder al guardado"); }),
    editingOrderId: editing ? "order" : undefined,
    createOrderLocal: jest.fn(async () => "order"), updateOrderLocal: jest.fn(async () => {}),
    pushSync: jest.fn(() => new Promise<void>(() => {})),
    cart: [{ productId: "product", presentationId: "presentation", productName: "Papa", sku: "P1",
      presentationName: "Unidad", unitEquivalence: 1, unitPriceCents: 1000, quantity: 1, subtotalCents: 1000 }],
    paymentCondition: "Contado 48h",
    connection: "offline", isEditing: editing, priceDecision: null, currentPresMap: new Map(),
    draftKeyRef: { current: "" }, focusedRef: { current: true }, approvedCatalogRef: { current: null },
    saleDraftKey, reviewSaleCatalog, centsToBs: (value: number) => "Bs. " + (value / 100).toFixed(2),
    validateSaleDraft: jest.fn(async () => ({ status: "unverified", reason: "offline", message: "Sin conexión" })),
    forceSync: jest.fn(async () => {}), setClients: jest.fn(),
    handleReopen: jest.fn(), Alert: { alert: jest.fn() }, navigation: { navigate: jest.fn(), goBack: jest.fn() },
    measurePerformance: (_name: string, task: () => Promise<unknown>) => task(),
    module: { exports: {} },
  };
  const refreshKey = () => { scope.draftKeyRef.current = saleDraftKey(scope.selectedClient?.id || "", scope.cart, scope.editingOrderId); };
  scope.setCart.mockImplementation((value: any) => { scope.cart = typeof value === "function" ? value(scope.cart) : value; refreshKey(); });
  scope.setSelectedClient.mockImplementation((value: any) => { scope.selectedClient = value; refreshKey(); });
  refreshKey();
  vm.runInNewContext(compile(handler + "\nmodule.exports = executeSaveOrder;", fileName), scope);
  return { ...scope, state: scope, save: scope.module.exports as (offlineConsentKey?: string) => Promise<void> };
}

describe("Guardado SQLite del formulario real de venta", () => {
  it.each([false, true])("termina guardando y navegando mientras el envío sigue pendiente (edición=%s)", async (editing) => {
    const h = saveHarness(editing);
    await h.save();
    expect(editing ? h.updateOrderLocal : h.createOrderLocal).toHaveBeenCalledTimes(1);
    expect(h.pushSync).toHaveBeenCalledTimes(1);
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(h.setCart).toHaveBeenCalledWith([]);
    expect(editing ? h.navigation.goBack : h.navigation.navigate).toHaveBeenCalledTimes(1);
    expect(h.saveInFlightRef.current).toBe(false);
  });

  it("dos toques durante la escritura pendiente generan una sola preventa", async () => {
    const h = saveHarness();
    const gate = deferred<string>();
    const entered = deferred<void>();
    h.createOrderLocal.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const first = h.save();
    await entered.promise;
    await h.save();
    expect(h.createOrderLocal).toHaveBeenCalledTimes(1);
    gate.resolve("order");
    await first;
    expect(h.pushSync).toHaveBeenCalledTimes(1);
    expect(h.navigation.navigate).toHaveBeenCalledTimes(1);
  });

  it("un fallo SQLite conserva el carrito y permite reintentar sin enviar nada", async () => {
    const h = saveHarness();
    h.createOrderLocal.mockRejectedValueOnce(new Error("Disco lleno"));
    await h.save();
    expect(h.setCart).not.toHaveBeenCalled();
    expect(h.pushSync).not.toHaveBeenCalled();
    expect(h.navigation.navigate).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith("Disco lleno");
    expect(h.saveInFlightRef.current).toBe(false);
    await h.save();
    expect(h.createOrderLocal).toHaveBeenCalledTimes(2);
  });

  it("una jornada cerrada bloquea el guardado antes de escribir o enviar", async () => {
    const h = saveHarness();
    h.getTodayWorkDay.mockResolvedValueOnce({ id: "day", status: "closed" });
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.pushSync).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining("concluida"));
  });
});

function verifiedDraft(overrides: any = {}) {
  return {
    status: "verified", valid: true, checkedAt: "2026-10-24T12:00:00.000Z", unchecked: false,
    client: { id: "remote-client", businessName: "Tienda", contactName: null, name: "Tienda", active: true, updatedAt: null },
    issues: [], items: [{ lineIndex: 0, productId: "remote-product", presentationId: "remote-pres",
      productName: "Papa", sku: "P1", presentationName: "Unidad", unitEquivalence: 1,
      priceCents: 1000, productType: "standard", comboDefinition: null, selections: [], unchecked: false }],
    ...overrides,
  };
}
function alertButton(h: ReturnType<typeof saveHarness>, text: string) {
  const alerts = h.Alert.alert.mock.calls;
  const buttons = alerts[alerts.length - 1][2];
  const button = buttons?.find((candidate: any) => candidate.text === text);
  if (!button?.onPress) throw new Error("No se encontró el botón: " + text);
  return button;
}

function saleFocusLifecycle(focusedRef: { current: boolean }) {
  const fileName = path.join(__dirname, "../screens/NewSaleScreen.tsx");
  const source = ts.createSourceFile(fileName, fs.readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useFocusEffect") callback = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const module = { exports: {} as () => () => void };
  vm.runInNewContext(compile("module.exports = " + callback + ";", fileName), {
    focusedRef, checkWorkDay: jest.fn(async () => {}), useCallback: (fn: any) => fn,
    module, exports: module.exports,
  });
  return module.exports();
}

describe("Comprobación previa del formulario real", () => {
  it("espera la comprobación online antes de guardar, pero no espera al push", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    const gate = deferred<any>(), entered = deferred<void>();
    h.validateSaleDraft.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const saving = h.save();
    await entered.promise;
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    gate.resolve(verifiedDraft());
    await saving;
    expect(h.createOrderLocal).toHaveBeenCalledTimes(1);
    expect(h.pushSync).toHaveBeenCalledTimes(1);
    expect(h.navigation.navigate).toHaveBeenCalledTimes(1);
  });

  it("bloquea un cliente borrado en otro teléfono y conserva el carrito para elegir otro", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    h.validateSaleDraft.mockResolvedValueOnce(verifiedDraft({ valid: false, issues: [
      { entity: "client", code: "CLIENT_UNAVAILABLE", message: "El cliente fue eliminado en otro dispositivo." },
    ] }));
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.pushSync).not.toHaveBeenCalled();
    expect(h.state.selectedClient).toBeNull();
    expect(h.state.cart).toHaveLength(1);
    expect(h.setStep).toHaveBeenCalledWith("client");
    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining("eliminado"));
  });

  it("ofrece quitar del carrito un producto eliminado sin guardar un pedido inválido", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    h.setCart((lines: any[]) => [...lines, { ...lines[0], productId: "other", presentationId: "other-pres" }]);
    h.validateSaleDraft.mockResolvedValueOnce(verifiedDraft({ valid: false, issues: [
      { entity: "product", lineIndex: 0, code: "PRODUCT_UNAVAILABLE", message: "Papa fue eliminada." },
    ] }));
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    alertButton(h, "Quitar no disponibles").onPress();
    expect(h.state.cart).toHaveLength(1);
    expect(h.state.cart[0].productId).toBe("other");
  });

  it.each(["Mantener precios", "Usar precios actuales"])("avisa un cambio de precio y exige revisar antes de guardar con %s", async (choice) => {
    const h = saveHarness();
    h.state.connection = "online";
    const response = verifiedDraft();
    response.items[0].priceCents = 2000;
    h.validateSaleDraft.mockResolvedValue(response);
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    alertButton(h, choice).onPress();
    const expected = choice === "Mantener precios" ? 1000 : 2000;
    expect(h.state.cart[0].unitPriceCents).toBe(expected);
    expect(h.state.cart[0].subtotalCents).toBe(expected);
    await h.save();
    expect(h.validateSaleDraft).toHaveBeenCalledTimes(2);
    expect(h.createOrderLocal).toHaveBeenCalledTimes(1);
    expect(h.createOrderLocal.mock.calls[0][0].lines[0].unitPriceCents).toBe(expected);
  });

  it("vuelve a avisar si el precio cambia de nuevo después de aceptar la revisión", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    const first = verifiedDraft(); first.items[0].priceCents = 2000;
    const next = verifiedDraft(); next.items[0].priceCents = 3000;
    h.validateSaleDraft.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    await h.save();
    alertButton(h, "Mantener precios").onPress();
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.Alert.alert.mock.calls[1][1]).toContain("Bs. 30.00");
  });

  it("avisa y vuelve a confirmar si cambia la regla del combo aunque sus opciones sigan siendo válidas", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    h.setCart((lines: any[]) => [{ ...lines[0], isCombo: true,
      comboCatalogSnapshot: { selectionMin: 1, selectionMax: 1, options: [{ presentationId: "option-local", maxQuantity: 1 }] },
      selections: [{ selectedProductId: "normal-local", selectedPresentationId: "option-local", productNameSnapshot: "Sabor",
        presentationNameSnapshot: "Unidad", quantity: 1, sortOrder: 0 }],
    }]);
    const before = { selectionMin: 1, selectionMax: 1, options: [{ presentationId: "option-remote", maxQuantity: 1 }] };
    const current = { ...before, selectionMax: 2 };
    const response: any = verifiedDraft();
    Object.assign(response.items[0], { productType: "combo", comboDefinition: current, knownComboDefinition: before,
      selections: [{ selectedProductId: "normal-remote", selectedPresentationId: "option-remote", productName: "Sabor", presentationName: "Unidad", quantity: 1 }],
    });
    h.validateSaleDraft.mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ ...response, items: [{ ...response.items[0], knownComboDefinition: current }] });
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    alertButton(h, "Actualizar pedido").onPress();
    expect(h.state.cart[0].comboCatalogSnapshot.selectionMax).toBe(2);
    await h.save();
    expect(h.createOrderLocal).toHaveBeenCalledTimes(1);
    expect(h.createOrderLocal.mock.calls[0][0].lines[0].selections[0].selectedPresentationId).toBe("option-local");
  });

  it("no pierde la elección histórica ya aceptada al abrir una edición", async () => {
    const h = saveHarness(true);
    h.state.connection = "online";
    h.state.priceDecision = "historical";
    h.state.currentPresMap.set("presentation", { price_cents: 2000 });
    const response = verifiedDraft(); response.items[0].priceCents = 2000;
    h.validateSaleDraft.mockResolvedValueOnce(response);
    await h.save();
    expect(h.updateOrderLocal).toHaveBeenCalledTimes(1);
    expect(h.updateOrderLocal.mock.calls[0][1][0].unitPriceCents).toBe(1000);
  });

  it("una caída de red pide consentimiento para guardar sin verificar y no repite la espera", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    h.validateSaleDraft.mockResolvedValueOnce({ status: "unverified", reason: "network", message: "No se pudo contactar al servidor." });
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    const finished = deferred<void>();
    h.navigation.navigate.mockImplementationOnce(() => finished.resolve());
    alertButton(h, "Guardar sin verificar").onPress();
    await finished.promise;
    expect(h.validateSaleDraft).toHaveBeenCalledTimes(1);
    expect(h.createOrderLocal).toHaveBeenCalledTimes(1);
  });

  it("no guarda una validación de un carrito anterior si el vendedor cambió cantidades durante la consulta", async () => {
    const h = saveHarness();
    const gate = deferred<any>(), entered = deferred<void>();
    h.state.connection = "online";
    h.validateSaleDraft.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const saving = h.save();
    await entered.promise;
    h.setCart((lines: any[]) => [{ ...lines[0], quantity: 2, subtotalCents: 2000 }]);
    gate.resolve(verifiedDraft());
    await saving;
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining("cambió durante"));
  });

  it("un error de sesión no ofrece guardar saltando la comprobación", async () => {
    const h = saveHarness();
    h.state.connection = "online";
    h.validateSaleDraft.mockRejectedValueOnce(new Error("Sesión expirada"));
    await h.save();
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith("Sesión expirada");
    expect(h.Alert.alert.mock.calls[0][0]).toBe("Error al guardar");
  });

  it("el cleanup real de pantalla invalida una consulta pendiente al salir o desmontar", async () => {
    const h = saveHarness();
    const leaveScreen = saleFocusLifecycle(h.focusedRef);
    h.state.connection = "online";
    const gate = deferred<any>(), entered = deferred<void>();
    h.validateSaleDraft.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const saving = h.save();
    await entered.promise;
    leaveScreen();
    gate.resolve(verifiedDraft());
    await saving;
    expect(h.createOrderLocal).not.toHaveBeenCalled();
    expect(h.pushSync).not.toHaveBeenCalled();
    expect(h.navigation.navigate).not.toHaveBeenCalled();
    expect(h.focusedRef.current).toBe(false);
  });
});

function historyOrdersHarness() {
  const fileName = path.join(__dirname, "../screens/HistoryScreen.tsx");
  const source = ts.createSourceFile(fileName, fs.readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "loadOrders" &&
        node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!callback) throw new Error("No se encontró loadOrders de HistoryScreen");
  const ordersMap: Record<string, any[]> = {};
  const scope: any = {
    ordersRequest: { current: 0 }, setLoadingOrders: jest.fn(),
    setOrdersMap: (update: any) => { Object.assign(ordersMap, update(ordersMap)); },
    listOrdersForWorkDay: jest.fn(async () => [{ id: "local-order", total_cents: 1001 }]),
    resolveServerWorkDayId: jest.fn(async () => "remote-day"),
    apiFetch: jest.fn(async () => ({ orders: [{ id: "remote-order", total_cents: 1001 }] })),
    module: { exports: {} },
  };
  vm.runInNewContext(compile("module.exports = " + callback + ";", fileName), scope);
  return { ...scope, ordersMap, loadOrders: scope.module.exports as (item: any) => Promise<void> };
}

describe("Historial real: copia local y respuestas fuera de orden", () => {
  it("conserva las preventas SQLite cuando falla la consulta de una jornada con ID remoto", async () => {
    const h = historyOrdersHarness();
    h.apiFetch.mockRejectedValueOnce(new Error("Sin conexión"));
    await h.loadOrders({ id: "remote-day", server_id: "remote-day" });
    expect(h.listOrdersForWorkDay).toHaveBeenCalledWith("remote-day");
    expect(h.ordersMap["remote-day"]).toMatchObject([{ id: "local-order", total_cents: 1001 }]);
    expect(h.setLoadingOrders).toHaveBeenLastCalledWith(null);
  });

  it("vuelve a consultar al reabrir una jornada y refleja una preventa eliminada", async () => {
    const h = historyOrdersHarness();
    await h.loadOrders({ id: "local-day", server_id: "remote-day" });
    h.listOrdersForWorkDay.mockResolvedValueOnce([]);
    h.apiFetch.mockResolvedValueOnce({ orders: [] });
    await h.loadOrders({ id: "local-day", server_id: "remote-day" });
    expect(h.apiFetch).toHaveBeenCalledTimes(2);
    expect(h.ordersMap["local-day"]).toEqual([]);
  });

  it("una respuesta antigua no reemplaza el contenido de la jornada recién abierta", async () => {
    const h = historyOrdersHarness();
    const responseA = deferred<any>();
    const responseB = deferred<any>();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    h.apiFetch.mockImplementationOnce(() => { enteredA.resolve(); return responseA.promise; })
      .mockImplementationOnce(() => { enteredB.resolve(); return responseB.promise; });
    const first = h.loadOrders({ id: "a", server_id: "remote-a" });
    await enteredA.promise;
    const second = h.loadOrders({ id: "b", server_id: "remote-b" });
    await enteredB.promise;
    responseB.resolve({ orders: [{ id: "new-b" }] });
    await second;
    responseA.resolve({ orders: [{ id: "stale-a" }] });
    await first;
    expect(h.ordersMap.b).toEqual([{ id: "new-b" }]);
    expect(h.ordersMap.a).not.toEqual([{ id: "stale-a" }]);
    expect(h.setLoadingOrders).toHaveBeenLastCalledWith(null);
  });
});

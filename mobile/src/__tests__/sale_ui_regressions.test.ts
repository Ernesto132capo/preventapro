import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

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
    saveInFlightRef: { current: false }, selectedClient: { id: "client" }, user: { id: "user" },
    setSaving: jest.fn(), setError: jest.fn(), setWorkDay: jest.fn(), setCart: jest.fn(),
    setSelectedClient: jest.fn(), setCartModalVisible: jest.fn(), setFinalConfirmModalVisible: jest.fn(), setStep: jest.fn(),
    getTodayWorkDay: jest.fn(async () => ({ id: "day", status: "open" })),
    apiFetch: jest.fn(() => { throw new Error("La red no debe preceder al guardado"); }),
    editingOrderId: editing ? "order" : undefined,
    createOrderLocal: jest.fn(async () => "order"), updateOrderLocal: jest.fn(async () => {}),
    pushSync: jest.fn(() => new Promise<void>(() => {})), cart: [{ quantity: 1 }], paymentCondition: "Contado 48h",
    handleReopen: jest.fn(), Alert: { alert: jest.fn() }, navigation: { navigate: jest.fn(), goBack: jest.fn() },
    module: { exports: {} },
  };
  vm.runInNewContext(compile(handler + "\nmodule.exports = executeSaveOrder;", fileName), scope);
  return { ...scope, save: scope.module.exports as () => Promise<void> };
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
    h.createOrderLocal.mockImplementationOnce(() => gate.promise);
    const first = h.save();
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

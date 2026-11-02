import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function compile(source: string, file: string) {
  return ts.transpileModule(source, { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
}
function find(node: any, predicate: (item: any) => boolean): any {
  if (Array.isArray(node)) { for (const item of node) { const result = find(item, predicate); if (result) return result; } }
  else if (node && typeof node === "object") { if (predicate(node)) return node; return find(node.props?.children, predicate); }
}
function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return textOf(node?.props?.children || []);
}

/** Ejecuta los componentes de producción, conservando estados, refs, efectos y sus limpiezas. */
function screenHarness(fileName: string, component: string, dependencies: Record<string, any>) {
  const slots: any[] = [];
  let cursor = 0, dirty = false;
  let effects: Array<() => void> = [];
  const changed = (before: any, deps: any[]) => !before || deps.some((value, index) => !Object.is(value, before.deps[index]));
  const react = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { dirty = true; slots[index] = next; }
      }];
    },
    useRef: (initial: any) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback: (fn: any, deps: any[]) => { const index = cursor++; if (changed(slots[index], deps)) slots[index] = { deps, fn }; return slots[index].fn; },
    useEffect: (effect: () => any, deps: any[]) => {
      const index = cursor++, before = slots[index];
      if (changed(before, deps)) effects.push(() => { before?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const native: any = { StyleSheet: { create: (value: any) => value }, Alert: { alert: jest.fn() }, Linking: { openURL: jest.fn() } };
  for (const type of ["View", "Text", "TextInput", "ScrollView", "Pressable", "Modal", "FlatList", "ActivityIndicator"]) native[type] = type;
  const defaults: Record<string, any> = {
    react, "react-native": native,
    "@react-navigation/native": { useNavigation: () => ({ setOptions: jest.fn(), navigate: jest.fn() }), useRoute: () => ({ params: {} }),
      useIsFocused: () => true, useFocusEffect: (callback: any) => react.useEffect(callback, [callback]) },
    "../theme/tokens": { colors: {}, spacing: { lg: 16, sm: 8, md: 12 }, radius: {}, touchTarget: {} },
    "../components/Button": { Button: "Button" }, "../components/Card": { Card: "Card" },
    "../components/EmptyState": { EmptyState: "EmptyState" }, "../components/StatusPill": { StatusPill: "StatusPill" },
    "../components/CategoryManagerModal": { CategoryManagerModal: "CategoryManagerModal" },
    "../components/LoadErrorBanner": { LoadErrorBanner: "LoadErrorBanner" },
    "../domain/pricing": { centsToBs: (value: number) => String(value / 100) },
    "../utils/money": { parseBsToCents: jest.fn() }, "../utils/useDebounce": { useDebounce: (value: string) => value },
    "../services/config": { API_BASE_URL: "https://test.invalid" },
    "../domain/client-display": { formatClientDisplayName: (client: any) => ({ primary: client.business_name || client.client_name || "Cliente", secondary: null }) },
    ...dependencies,
  };
  const file = path.join(__dirname, "../screens", fileName);
  const module = { exports: {} as any };
  vm.runInNewContext(compile(fs.readFileSync(file, "utf8"), file), { module, exports: module.exports,
    require: (name: string) => { if (!(name in defaults)) throw new Error(name); return defaults[name]; }, console,
  });
  function render() {
    let tree: any, attempts = 0;
    do {
      if (++attempts > 20) throw new Error("Render no estable");
      cursor = 0; dirty = false; effects = [];
      tree = module.exports[component]();
      for (const effect of effects) effect();
    } while (dirty);
    return tree;
  }
  async function flush() {
    let tree: any;
    for (let pass = 0; pass < 3; pass++) { for (let step = 0; step < 20; step++) await Promise.resolve(); tree = render(); }
    return tree;
  }
  return { render, flush };
}

describe("Carga visible sin dependencias de red innecesarias", () => {
  it.each([true, false])("el cierre de una jornada vacía confirma sólo una fecha compatible (%s)", async matchingDate => {
    const file = path.join(__dirname, "../screens/DailySalesScreen.tsx");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = "";
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "handleClose") handler = node.getText(source); ts.forEachChild(node, visit); }
    visit(source);
    const remote = { id: "remote-day", work_date: matchingDate ? "2026-11-01" : "2026-10-31", order_count: 0, total_cents: 0 };
    const scope: any = { module: { exports: {} }, closeInFlightRef: { current: false }, reopenInFlightRef: { current: false },
      confirmText: "CONFIRMAR", workDay: { id: "local-day", work_date: "2026-11-01" }, setError: jest.fn(), setClosing: jest.fn(),
      forceSync: jest.fn(async () => {}), countUnsyncedOrders: jest.fn(async () => 0), resolveServerWorkDayId: jest.fn(async () => null),
      apiFetch: jest.fn(async () => ({ workDay: remote })), upsertServerWorkDay: jest.fn(async () => {}), markWorkDayClosed: jest.fn(async () => {}),
      setWorkDay: jest.fn(), setShowCloseForm: jest.fn(), Alert: { alert: jest.fn() }, centsToBs: String, load: jest.fn(async () => {}), ApiError: Error,
    };
    vm.runInNewContext(compile(handler + "\nmodule.exports = handleClose;", file), scope);
    await scope.module.exports();
    expect(scope.apiFetch).toHaveBeenCalledWith("/workdays/current");
    expect(scope.closeInFlightRef.current).toBe(false);
    if (matchingDate) {
      expect(scope.apiFetch).toHaveBeenCalledWith("/workdays/remote-day/close", expect.objectContaining({ method: "POST" }));
      expect(scope.markWorkDayClosed).toHaveBeenCalledWith("local-day", 0, 0);
    } else {
      expect(scope.markWorkDayClosed).not.toHaveBeenCalled();
      expect(scope.setError).toHaveBeenCalledWith(expect.stringContaining("No se pudo confirmar"));
    }
  });

  it("confirma la categoría local sin esperar al envío en segundo plano", async () => {
    const file = path.join(__dirname, "../components/CategoryManagerModal.tsx");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = "";
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "handleCreate") handler = node.getText(source); ts.forEachChild(node, visit); }
    visit(source);
    const push = deferred<void>(), record = { id: "category", name: "Prueba" };
    const scope: any = { module: { exports: {} }, isSubmittingRef: { current: false }, creating: false, submitting: false, newCatName: "Prueba",
      setCreating: jest.fn(), setSubmitting: jest.fn(), setNewCatName: jest.fn(), createCategoryLocal: jest.fn(async () => record),
      pushSync: jest.fn(() => push.promise), load: jest.fn(async () => {}), onSelect: jest.fn(), onClose: jest.fn(), Alert: { alert: jest.fn() } };
    vm.runInNewContext(compile(handler + "\nmodule.exports = handleCreate;", file), scope);
    await scope.module.exports();
    expect(scope.onSelect).toHaveBeenCalledWith(record);
    expect(scope.onClose).toHaveBeenCalledTimes(1);
    expect(scope.setSubmitting).toHaveBeenLastCalledWith(false);
    push.resolve();
  });

  function productHarness(getProduct = jest.fn(async () => ({ id: "product", name: "Papa", product_type: "standard", presentations: [] }))) {
    const listProducts = jest.fn(async (..._args: any[]): Promise<any[]> => []);
    const h = screenHarness("ProductFormScreen.tsx", "ProductFormScreen", {
      "@react-navigation/native": { useNavigation: () => ({ setOptions: jest.fn() }), useRoute: () => ({ params: { productId: "product" } }) },
      "../context/SyncContext": { useSync: () => ({ pushSync: jest.fn(), catalogRevision: 0 }) },
      "../db/repositories/products": { getProduct, listProducts }, "../db/repositories/categories": { getCategory: jest.fn() },
    });
    return { ...h, getProduct, listProducts };
  }

  it("abre un producto normal sin cargar todo el catálogo", async () => {
    const h = productHarness();
    expect(textOf(h.render())).toContain("Cargando producto");
    const tree = await h.flush();
    expect(find(tree, node => node.props.label === "Nombre del producto *" && node.props.value === "Papa")).toBeDefined();
    expect(h.listProducts).not.toHaveBeenCalled();
  });

  it("un error al abrir el producto muestra reintento y después recupera el formulario", async () => {
    const getProduct = jest.fn().mockRejectedValueOnce(new Error("SQLite ocupado")).mockResolvedValue({ id: "product", name: "Papa", presentations: [] });
    const h = productHarness(getProduct);
    h.render();
    const error = find(await h.flush(), node => node.type === "LoadErrorBanner");
    expect(error.props.message).toBe("SQLite ocupado");
    error.props.onRetry(); h.render();
    expect(find(await h.flush(), node => node.props.label === "Nombre del producto *" && node.props.value === "Papa")).toBeDefined();
    expect(getProduct).toHaveBeenCalledTimes(2);
    expect(h.listProducts).not.toHaveBeenCalled();
  });

  it("carga y pagina las opciones sólo al abrir el selector de un combo", async () => {
    const getProduct = jest.fn().mockResolvedValue({ id: "product", name: "Combo", product_type: "combo", presentations: [],
      combo_definition: { selection_min: 1, selection_max: 1, options: [] } });
    const h = productHarness(getProduct);
    h.render(); let tree = await h.flush();
    expect(h.listProducts).not.toHaveBeenCalled();
    h.listProducts.mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => ({ id: `p-${index}`, name: `Producto ${index}`, presentations: [] })))
      .mockResolvedValueOnce([{ id: "last", name: "Último", presentations: [] }]);
    find(tree, node => node.type === "Button" && node.props.label === "+ Agregar opción").props.onPress();
    tree = await h.flush();
    expect(h.listProducts).toHaveBeenLastCalledWith({ search: "", productType: "standard", limit: 50, offset: 0 });
    let list = find(tree, node => node.type === "FlatList");
    expect(list.props.data).toHaveLength(50);
    list.props.ListFooterComponent.props.onPress();
    tree = await h.flush();
    expect(h.listProducts).toHaveBeenLastCalledWith({ search: "", productType: "standard", limit: 50, offset: 50 });
    list = find(tree, node => node.type === "FlatList");
    expect(list.props.data).toHaveLength(51);
    expect(list.props.ListFooterComponent).toBeNull();
  });

  it.each([1, 25])("conserva el detalle local del historial sin esperar red y muestra sus %s pedidos por páginas", async count => {
    const day = { id: "local-day", server_id: "remote-day", work_date: "2026-11-01", status: "closed", total_cents: 100, order_count: 1, created_at: "2026-11-01T12:00:00Z" };
    const orders = Array.from({ length: count }, (_, index) => ({ id: `order-${index}`, business_name: `Cliente visible ${index}`, total_cents: 100 }));
    const listOrders = jest.fn(async () => orders), history = deferred<any>();
    let revision = 0, slow = false;
    const api = jest.fn(async (url: string) => url.includes("/history")
      ? slow ? history.promise : { workDays: [{ ...day, id: "remote-day" }] }
      : { orders });
    const h = screenHarness("HistoryScreen.tsx", "HistoryScreen", {
      "../context/AuthContext": { useAuth: () => ({ user }) },
      "../context/SyncContext": { useSync: () => ({ pullRevision: revision }) },
      "../db/repositories/workdays": { listClosedWorkDays: async () => [day] },
      "../db/repositories/orders": { listOrdersForWorkDay: listOrders }, "../services/api": { apiFetch: api },
    });
    const user = { id: "user" };
    const row = (tree: any) => { const list = find(tree, node => node.type === "FlatList"); return list.props.renderItem({ item: list.props.data[0] }); };
    h.render(); let tree = await h.flush();
    find(row(tree), node => node.type === "Button" && node.props.label === "Ver preventas de esta jornada").props.onPress();
    tree = await h.flush();
    expect(textOf(row(tree))).toContain("Cliente visible");
    if (count > 10) {
      expect(textOf(row(tree))).not.toContain("Cliente visible 10");
      find(row(tree), node => node.type === "Button" && node.props.label === "Siguiente").props.onPress();
      tree = h.render();
      expect(textOf(row(tree))).toContain("Cliente visible 10");
      expect(textOf(row(tree))).not.toContain("Cliente visible 20");
    }
    const reads = listOrders.mock.calls.length;
    slow = true; revision++; h.render(); tree = await h.flush();
    expect(textOf(row(tree))).toContain("Cliente visible");
    expect(listOrders.mock.calls.length).toBeGreaterThan(reads);
    history.resolve({ workDays: [{ ...day, id: "remote-day" }] });
    expect(textOf(row(await h.flush()))).toContain("Cliente visible");
  });
});

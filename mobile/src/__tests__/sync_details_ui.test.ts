import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";
import type { OutboxDetail, OutboxSummary } from "../db/outbox";
import { syncChangeDate, syncDetailAction, syncDetailStatus } from "../utils/syncDetails";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function walk(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) { const result = walk(child, predicate); if (result) return result; }
  } else if (node && typeof node === "object") {
    if (predicate(node)) return node;
    return walk(node.props?.children, predicate);
  }
}

function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return textOf(node?.props?.children || []);
}

const emptySummary: OutboxSummary = { total: 0, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 0 };
const detail = (id: string, overrides: Partial<OutboxDetail> = {}): OutboxDetail => ({
  id, entity_type: "order", local_entity_id: `local-${id}`, operation: "create", priority: 2,
  status: "pending", attempts: 0, last_error: null, next_retry_at: null,
  created_at: "2026-10-27T12:00:00.000Z", entity_name: `Preventa ${id}`,
  entity_subtitle: "Tienda central", entity_exists: 1, entity_active: 1, ...overrides,
});

// Renderiza la pantalla real con hooks estables y el ciclo de foco controlado.
// Las promesas representan lecturas SQLite pendientes, sin iniciar red ni Expo.
function screenHarness() {
  const slots: any[] = [];
  const writes: unknown[] = [];
  let cursor = 0, dirty = false, focused = true;
  let effects: Array<() => void> = [];
  let tree: any;
  const changed = (before: any[] | undefined, after: any[]) => !before || after.some((value, i) => !Object.is(value, before[i]));
  function useEffect(effect: () => void | (() => void), deps: any[]) {
    const index = cursor++;
    if (changed(slots[index]?.deps, deps)) {
      const previous = slots[index];
      const slot = { deps, cleanup: undefined as void | (() => void) };
      slots[index] = slot;
      effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
    }
  }
  const react = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; writes.push(next); }
      }];
    },
    useRef: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback: any, deps: any[]) => {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect,
  };
  const navigation = { navigate: jest.fn() };
  const route = { params: { errorsOnly: false } };
  const sync = {
    connection: "online", isSyncing: false, forceSync: jest.fn(async () => {}),
    refreshPending: jest.fn(async (): Promise<OutboxSummary> => emptySummary), syncTick: 0, lastError: null,
  };
  const db = { listOutboxDetails: jest.fn(async (..._args: any[]): Promise<OutboxDetail[]> => []) };
  const conflicts = {
    resolveKeepDeleted: jest.fn(async () => {}),
    prepareConflictRestore: jest.fn(async () => null),
    getConflictByOutboxId: jest.fn(async () => null),
  };
  const dependencies: Record<string, any> = {
    react,
    "react-native": { StyleSheet: { create: (value: unknown) => value }, ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Text: "Text", View: "View", Alert: { alert: jest.fn() } },
    "@react-navigation/native": {
      useNavigation: () => navigation, useRoute: () => route,
      useFocusEffect: (callback: () => void | (() => void)) => useEffect(() => focused ? callback() : undefined, [callback, focused]),
    },
    "../components/Button": { Button: "Button" }, "../components/Card": { Card: "Card" },
    "../components/CategoryManagerModal": { CategoryManagerModal: "CategoryManagerModal" },
    "../components/StatusPill": { StatusPill: "StatusPill" },
    "../context/SyncContext": { useSync: () => sync }, "../db/outbox": db,
    "../db/conflicts": conflicts,
    "../theme/tokens": { colors: {}, spacing: {} },
    "../utils/syncDetails": { syncChangeDate, syncDetailAction, syncDetailStatus },
  };
  const file = path.join(__dirname, "../screens/SyncDetailsScreen.tsx");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} as { SyncDetailsScreen?: () => unknown } };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Dependencia inesperada: ${name}`);
    return dependencies[name];
  } }, { filename: file });

  function render() {
    let attempts = 0;
    do {
      if (++attempts > 10) throw new Error("Render inestable de pendientes");
      cursor = 0; dirty = false; effects = [];
      tree = module.exports.SyncDetailsScreen!();
      effects.forEach(effect => effect());
    } while (dirty);
    return tree;
  }
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return render();
  }
  const list = () => walk(tree, node => node.type === "FlatList").props;
  const button = (prefix: string, region = list().ListHeaderComponent) => walk(region, node => node.type === "Button" && node.props.label.startsWith(prefix));
  return { render, settle, list, button, db, sync, navigation, writes, blur: () => { focused = false; render(); } };
}

describe("Detalle real de cambios pendientes", () => {
  it("muestra conteos completos aunque la página cargada solo contenga dos cambios", async () => {
    const h = screenHarness();
    h.sync.refreshPending.mockResolvedValue({ total: 70, pending: 59, syncing: 0, failed: 3, error: 8, conflict: 0 });
    h.db.listOutboxDetails.mockResolvedValue([detail("a"), detail("b")]);
    h.render(); await h.settle();

    expect(h.button("Todos").props.label).toBe("Todos (70)");
    expect(h.button("Por revisar").props.label).toBe("Por revisar (11)");
    expect(textOf(h.list().ListHeaderComponent)).toContain("8 requieren corrección · 0 conflictos · 3 con error temporal");
    expect(textOf(h.list().ListFooterComponent)).toContain("Mostrando 2 de 70 cambios.");
  });

  it("una respuesta anterior no reemplaza el filtro de errores seleccionado después", async () => {
    const h = screenHarness();
    const older = deferred<OutboxDetail[]>();
    h.sync.refreshPending.mockResolvedValueOnce({ total: 90, pending: 89, syncing: 0, failed: 0, error: 1, conflict: 0 })
      .mockResolvedValue({ total: 1, pending: 0, syncing: 0, failed: 0, error: 1, conflict: 0 });
    h.db.listOutboxDetails.mockImplementationOnce(() => older.promise).mockResolvedValueOnce([detail("error", { status: "error" })]);
    h.render();
    h.button("Por revisar").props.onPress(); h.render();
    await h.settle();
    older.resolve([detail("obsoleto")]); await h.settle();

    expect(h.db.listOutboxDetails).toHaveBeenLastCalledWith({ offset: 0, limit: 30, errorsOnly: true });
    expect(h.list().data.map((row: OutboxDetail) => row.id)).toEqual(["error"]);
    expect(h.button("Todos").props.label).toBe("Todos (1)");
  });

  it("una lectura que termina después de salir de la pantalla no actualiza el estado", async () => {
    const h = screenHarness();
    const reading = deferred<OutboxDetail[]>();
    h.db.listOutboxDetails.mockImplementationOnce(() => reading.promise);
    h.render(); h.blur();
    const countBefore = h.writes.length;
    reading.resolve([detail("tardío")]); await h.settle();

    expect(h.writes).toHaveLength(countBefore);
    expect(h.list().data).toEqual([]);
  });

  it("un filtro que falla no conserva filas anteriores ni acepta una página obsoleta en vuelo", async () => {
    const h = screenHarness();
    const olderPage = deferred<OutboxDetail[]>();
    h.sync.refreshPending.mockResolvedValue({ total: 31, pending: 30, syncing: 0, failed: 0, error: 1, conflict: 0 });
    h.db.listOutboxDetails.mockResolvedValueOnce(Array.from({ length: 30 }, (_, index) => detail(`todos-${index}`)))
      .mockImplementationOnce(() => olderPage.promise).mockRejectedValueOnce(new Error("No se pudo leer la lista de errores"));
    h.render(); await h.settle();
    h.button("Cargar más", h.list().ListFooterComponent).props.onPress(); h.render();
    h.button("Por revisar").props.onPress(); h.render(); await h.settle();

    expect(h.list().data).toEqual([]);
    expect(textOf(h.list().ListHeaderComponent)).toContain("No se pudo leer la lista de errores");
    expect(h.button("Por revisar").props.variant).toBe("secondary");
    olderPage.resolve([detail("respuesta-obsoleta")]); await h.settle();

    expect(h.list().data).toEqual([]);
    expect(textOf(h.list().ListHeaderComponent)).toContain("No se pudo leer la lista de errores");
    expect(h.list().ListFooterComponent).toBeNull();
  });

  it("refrescar sustituye la lista e invalida una página adicional todavía en vuelo", async () => {
    const h = screenHarness();
    const nextPage = deferred<OutboxDetail[]>();
    h.db.listOutboxDetails.mockResolvedValueOnce(Array.from({ length: 30 }, (_, index) => detail(`viejo-${index}`)))
      .mockImplementationOnce(() => nextPage.promise).mockResolvedValueOnce([detail("actual")]);
    h.render(); await h.settle();
    h.button("Cargar más", h.list().ListFooterComponent).props.onPress(); h.render();
    expect(h.db.listOutboxDetails).toHaveBeenLastCalledWith({ offset: 30, limit: 30, errorsOnly: false });
    h.list().onRefresh(); await h.settle();
    nextPage.resolve([detail("página-obsoleta")]); await h.settle();

    expect(h.list().data.map((row: OutboxDetail) => row.id)).toEqual(["actual"]);
    expect(h.db.listOutboxDetails).toHaveBeenLastCalledWith({ offset: 0, limit: 30, errorsOnly: false });
  });
});

describe("Acciones y estados de revisión de sincronización", () => {
  it("abre incluso una preventa anulada mediante su detalle, conservando las reglas de edición existentes", () => {
    expect(syncDetailAction(detail("anulada", { operation: "cancel", entity_active: 0 }))).toEqual({
      label: "Ver preventa", route: "DetallePreventa", params: { orderId: "local-anulada" },
    });
  });

  it.each(["client", "product", "category"] as const)("no ofrece editar %s dado de baja o eliminado", entity_type => {
    expect(syncDetailAction(detail("inactivo", { entity_type, entity_active: 0 }))).toBeNull();
    expect(syncDetailAction(detail("baja", { entity_type, operation: "delete" }))).toBeNull();
    expect(syncDetailAction(detail("ausente", { entity_type, entity_exists: 0 }))).toBeNull();
  });

  it("distingue el reintento programado de una validación que requiere corrección", () => {
    expect(syncDetailStatus({ status: "pending", next_retry_at: "2026-10-27T13:00:00.000Z" }).label).toBe("Reintento programado");
    expect(syncDetailStatus({ status: "error", next_retry_at: null })).toEqual({ kind: "failed", label: "Requiere corrección" });
    expect(syncDetailStatus({ status: "failed", next_retry_at: null }).label).toBe("Error temporal");
  });

  it("identifica un conflicto de registro eliminado", () => {
    expect(syncDetailStatus({ status: "conflict", next_retry_at: null })).toEqual({ kind: "failed", label: "Conflicto: registro eliminado" });
  });

  it("ofrece mantener eliminado o restaurar para un conflicto", async () => {
    const h = screenHarness();
    h.sync.refreshPending.mockResolvedValue({ total: 1, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 1 });
    const conflictItem = detail("c1", { entity_type: "product", status: "conflict", last_error: "Este producto fue eliminado desde otro dispositivo." });
    h.db.listOutboxDetails.mockResolvedValue([conflictItem]);
    h.render(); await h.settle();

    const itemTree = h.list().renderItem({ item: conflictItem });
    const keep = walk(itemTree, (n: any) => n?.type === "Button" && n?.props?.label === "Mantener eliminado");
    const restore = walk(itemTree, (n: any) => n?.type === "Button" && n?.props?.label === "Restaurar con mis cambios");
    expect(keep).toBeTruthy();
    expect(restore).toBeTruthy();
  });
});

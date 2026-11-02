import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function catalogHarness() {
  const file = path.join(__dirname, "../hooks/useSaleCatalog.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const slots: any[] = [];
  let cursor = 0, dirty = false;
  let effects: Array<() => void> = [];
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const repositories = {
    listActiveClients: jest.fn(async (..._args: any[]): Promise<any[]> => []),
    listProducts: jest.fn(async (..._args: any[]): Promise<any[]> => []),
    listFrequentProducts: jest.fn(async (..._args: any[]): Promise<any[]> => []),
    listRecentProductsForClient: jest.fn(async (..._args: any[]): Promise<any[]> => []),
    toggleFavoriteLocal: jest.fn(async () => true),
    listCategories: jest.fn(async () => []),
  };
  const dependencies: Record<string, unknown> = {
    react,
    "../db/repositories/clients": repositories,
    "../db/repositories/products": repositories,
    "../db/repositories/categories": repositories,
    "../utils/useDebounce": { useDebounce: (value: unknown) => value },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: (name: string) => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; },
  }, { filename: file });
  let options: any = { isFocused: true, catalogRevision: 0, clientSearch: "", productSearch: "",
    filterMode: "all", selectedCategoryId: null, selectedClient: null };
  function render(patch: any = {}) {
    options = { ...options, ...patch };
    let result: any;
    let attempts = 0;
    do {
      if (++attempts > 5) throw new Error("Hook render inestable");
      cursor = 0; dirty = false; effects = [];
      result = module.exports.useSaleCatalog(options);
      for (const effect of effects) effect();
    } while (dirty);
    return result;
  }
  async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
    return render();
  }
  return { render, flush, repositories };
}

describe("Lecturas del catálogo separadas de la pantalla de venta", () => {
  it("conserva las filas del mismo filtro mientras refresca y si falla esa recarga", async () => {
    const h = catalogHarness();
    h.repositories.listProducts.mockResolvedValue([{ id: "product" }]);
    h.repositories.listActiveClients.mockResolvedValue([{ id: "client" }]);
    h.render(); await h.flush();
    const products = deferred<any[]>(), clients = deferred<any[]>();
    h.repositories.listProducts.mockImplementationOnce(() => products.promise);
    h.repositories.listActiveClients.mockImplementationOnce(() => clients.promise);
    const refreshing = h.render({ catalogRevision: 1 });
    expect(refreshing.products).toMatchObject([{ id: "product" }]);
    expect(refreshing.clients).toMatchObject([{ id: "client" }]);
    products.resolve([{ id: "new-product" }]); clients.resolve([{ id: "new-client" }]);
    expect((await h.flush()).products).toMatchObject([{ id: "new-product" }]);
    h.repositories.listProducts.mockRejectedValueOnce(new Error("SQLite ocupado"));
    h.render({ catalogRevision: 2 });
    const failed = await h.flush();
    expect(failed.products).toMatchObject([{ id: "new-product" }]);
    expect(failed.catalogError).toBe("SQLite ocupado");
  });

  it("comparte la lectura de recientes con su contador y la invalida al cambiar de catálogo", async () => {
    const h = catalogHarness();
    h.repositories.listRecentProductsForClient.mockResolvedValue([{ id: "recent" }]);
    h.render({ filterMode: "recent", selectedClient: { id: "client" } });
    const current = await h.flush();
    expect(current.recentCount).toBe(1);
    expect(current.products).toMatchObject([{ id: "recent" }]);
    expect(h.repositories.listRecentProductsForClient).toHaveBeenCalledTimes(1);
    h.render({ catalogRevision: 1 }); await h.flush();
    expect(h.repositories.listRecentProductsForClient).toHaveBeenCalledTimes(2);
  });

  it("un filtro antiguo no reemplaza los productos del filtro actual", async () => {
    const h = catalogHarness(), old = deferred<any[]>();
    h.repositories.listProducts.mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce([{ id: "favorite", is_favorite: true }]);
    h.render();
    h.render({ filterMode: "favorites" });
    expect((await h.flush()).products).toMatchObject([{ id: "favorite" }]);
    old.resolve([{ id: "stale" }]);
    expect((await h.flush()).products).toMatchObject([{ id: "favorite" }]);
    expect(h.repositories.listProducts).toHaveBeenLastCalledWith({ search: "", categoryId: undefined, onlyFavorites: true });
  });

  it("vuelve a leer recientes al regresar a la pantalla, sin conservar una respuesta de antes de guardar", async () => {
    const h = catalogHarness();
    h.repositories.listRecentProductsForClient.mockResolvedValue([{ id: "old" }]);
    h.render({ filterMode: "recent", selectedClient: { id: "client" } }); await h.flush();
    h.render({ isFocused: false });
    h.repositories.listRecentProductsForClient.mockResolvedValue([{ id: "new" }]);
    h.render({ isFocused: true });
    expect((await h.flush()).products).toMatchObject([{ id: "new" }]);
    expect(h.repositories.listRecentProductsForClient).toHaveBeenCalledTimes(2);
  });

  it("salir de la pantalla invalida consultas pendientes", async () => {
    const h = catalogHarness(), pending = deferred<any[]>();
    h.repositories.listProducts.mockImplementationOnce(() => pending.promise);
    h.render();
    h.render({ isFocused: false });
    pending.resolve([{ id: "after-blur" }]);
    expect((await h.flush()).products).toEqual([]);
  });

  it("una búsqueda nueva de clientes ignora la respuesta anterior y muestra un fallo sin datos del filtro previo", async () => {
    const h = catalogHarness(), old = deferred<any[]>();
    h.repositories.listActiveClients.mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce([{ id: "new-client" }]);
    h.render({ clientSearch: "anterior" });
    h.render({ clientSearch: "actual" });
    expect((await h.flush()).clients).toMatchObject([{ id: "new-client" }]);
    old.resolve([{ id: "stale-client" }]);
    expect((await h.flush()).clients).toMatchObject([{ id: "new-client" }]);
    h.repositories.listActiveClients.mockRejectedValueOnce(new Error("Lectura no disponible"));
    h.render({ clientSearch: "otro" });
    const failed = await h.flush();
    expect(failed.clients).toEqual([]);
    expect(failed.catalogError).toBe("Lectura no disponible");
    expect(failed.loadingClients).toBe(false);
  });

  it("el contador de compras previas pertenece al cliente seleccionado más reciente", async () => {
    const h = catalogHarness(), first = deferred<any[]>();
    h.repositories.listRecentProductsForClient.mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([{ id: "one" }]);
    h.render({ selectedClient: { id: "A" } });
    h.render({ selectedClient: { id: "B" } });
    expect((await h.flush()).recentCount).toBe(1);
    first.resolve([{ id: "old-one" }, { id: "old-two" }]);
    expect((await h.flush()).recentCount).toBe(1);
  });

  it("un cambio de sincronización vuelve a consultar y los favoritos actualizan el producto actual", async () => {
    const h = catalogHarness();
    h.repositories.listProducts.mockResolvedValue([{ id: "product", is_favorite: false }]);
    h.render();
    let current = await h.flush();
    await current.handleToggleFavorite("product");
    expect(h.render().products).toMatchObject([{ id: "product", is_favorite: true }]);
    h.render({ catalogRevision: 1 });
    current = await h.flush();
    expect(h.repositories.listProducts).toHaveBeenCalledTimes(2);
    expect(current.loadingProducts).toBe(false);
  });
});

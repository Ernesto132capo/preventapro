import { LOCAL_SCHEMA } from "../db/schema";
import { createOrderLocal, updateOrderLocal, cancelOrderLocal, upsertOrderFromServer, getConsolidatedProductsForWorkDay, listOrdersForWorkDay } from "../db/repositories/orders";
import { createClientLocal, updateClientLocal, upsertFromServer } from "../db/repositories/clients";
import { upsertCategoryFromServer } from "../db/repositories/categories";
import { resolveServerPresentationId, upsertProductFromServer, createProductLocal, updateProductLocal, getProduct, toggleFavoriteLocal, listProducts, isFavoriteLocal } from "../db/repositories/products";
import { getWorkDay, deleteClosedWorkDayLocal, assertClosedWorkDayDeletable } from "../db/repositories/workdays";
import { pullCatalog, pushOnlySync, runSync, resetSyncCooldown, withSyncMaintenance } from "../services/sync";
import { apiFetch, ApiError } from "../services/api";
import { listPending, retryFailed } from "../db/outbox";
import { todayBolivia } from "../utils/dates";
import type { CartLine } from "../domain/types";

// Integration checks use real SQLite without adding a native npm dependency.
// Node 22.13+ exposes SQLite; older Node versions still run the unit suites.
const DatabaseSync = (process as any).getBuiltinModule?.("node:sqlite")?.DatabaseSync;
const sqliteDescribe = DatabaseSync ? describe : describe.skip;
let mockSqlite: any;
let mockFailOutbox = false;
const bind = (values: any[]) => values.map((v) => typeof v === "boolean" ? Number(v) : v);
const mockDb = {
  runAsync: async (sql: string, params: any[] = []) => {
    if (mockFailOutbox && sql.includes("INSERT INTO outbox")) throw new Error("Simulated outbox disk failure");
    return mockSqlite.prepare(sql).run(...bind(params));
  },
  getFirstAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...bind(params)) || null,
  getAllAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...bind(params)),
  execAsync: async (sql: string) => mockSqlite.exec(sql),
};
jest.mock("../db/client", () => ({
  getDb: async () => mockDb,
  nowIso: () => new Date().toISOString(),
  withTx: async (cb: any) => {
    mockSqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await cb(mockDb);
      mockSqlite.exec("COMMIT");
      return result;
    } catch (error) {
      mockSqlite.exec("ROLLBACK");
      throw error;
    }
  },
  getMeta: async (key: string) => (await mockDb.getFirstAsync("SELECT value FROM meta WHERE key = ?", [key]))?.value || null,
  setMeta: async (key: string, value: string) => mockDb.runAsync("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)", [key, value]),
}));
jest.mock("../services/api", () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
}));

const ts = "2026-10-20T12:00:00.000Z";
const line: CartLine = { productId: "p", presentationId: "pres", productName: "Papa", sku: "P1", presentationName: "Unidad", unitEquivalence: 1, unitPriceCents: 1001, quantity: 1, subtotalCents: 1001 };
const orderFixture = (overrides: any = {}) => ({
  id: "remote-order", idempotency_key: "local-order", work_day_id: "remote-day", client_id: "remote-client", client_name: "Tienda", status: "active",
  subtotal_cents: 1001, tax_cents: 0, total_cents: 1001, item_count: 1, created_at: ts, updated_at: ts,
  items: [{ id: "remote-item", product_id: "remote-product", presentation_id: "remote-pres", product_name_snapshot: "Papa", sku_snapshot: "P1", presentation_name_snapshot: "Unidad", unit_equivalence_snapshot: 1, unit_price_cents_snapshot: 1001, quantity: 1, subtotal_cents: 1001, selections: [] }],
  ...overrides,
});
async function seedOrder(id = "local-order", serverId: string | null = null, syncStatus = "pending") {
  await mockDb.runAsync(`INSERT INTO orders(id,server_id,work_day_id,client_id,client_name,subtotal_cents,tax_cents,total_cents,item_count,status,sync_status,created_at,updated_at) VALUES (?,?, 'day','client','Tienda',1001,0,1001,1,'active',?,?,?)`, [id, serverId, syncStatus, ts, ts]);
  await mockDb.runAsync(`INSERT INTO order_items(id,order_id,product_id,presentation_id,product_name_snapshot,sku_snapshot,presentation_name_snapshot,unit_equivalence_snapshot,unit_price_cents_snapshot,quantity,subtotal_cents) VALUES (?,?,'p','pres','Papa','P1','Unidad',1,1001,1,1001)`, [`item-${id}`, id]);
}
async function queue(id: string, operation = "create", attempts = 0) {
  await mockDb.runAsync(`INSERT INTO outbox(id,entity_type,local_entity_id,operation,status,attempts,created_at) VALUES (?, 'order', ?, ?, 'pending', ?, ?)`, [`q-${id}`, id, operation, attempts, ts]);
}
const scalar = (sql: string) => mockSqlite.prepare(sql).get();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const productResponse = (body: any, id = "new-remote-product") => ({
  id, sku: body.sku, name: body.name, product_type: body.productType,
  presentations: body.presentations.map((p: any) => ({ id: p.id || p.localId || "new-remote-pres", name: p.name, unit_equivalence: p.unitEquivalence, price_cents: p.priceCents, cost_cents: p.costCents })),
  ...(body.comboDefinition ? { combo_definition: { id: "new-remote-definition", selection_min: body.comboDefinition.selectionMin, selection_max: body.comboDefinition.selectionMax,
    options: body.comboDefinition.options.map((o: any, i: number) => ({ id: `remote-option-${i}`, presentation_id: o.presentationId, max_quantity: o.maxQuantity, sort_order: i })) } } : {}),
});

sqliteDescribe("Offline sync data integrity with real SQLite", () => {
  beforeEach(async () => {
    mockSqlite = new DatabaseSync(":memory:");
    mockSqlite.exec(LOCAL_SCHEMA);
    mockFailOutbox = false;
    jest.clearAllMocks();
    resetSyncCooldown();
    await mockDb.runAsync("INSERT INTO clients(id,server_id,business_name,created_at,updated_at) VALUES ('client','remote-client','Tienda',?,?)", [ts, ts]);
    await mockDb.runAsync("INSERT INTO products(id,server_id,sku,name) VALUES ('p','remote-product','P1','Papa')");
    await mockDb.runAsync("INSERT INTO product_presentations(id,server_id,product_id,name,unit_equivalence,price_cents) VALUES ('pres','remote-pres','p','Unidad',1,1001)");
    await mockDb.runAsync("INSERT INTO work_days(id,server_id,user_id,work_date,status,created_at,sync_status) VALUES ('day','remote-day','user',?,'open',?,'synced')", [todayBolivia(), ts]);
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", user_id: "user", work_date: todayBolivia(), status: "open" } };
      if (path.startsWith("/sync/pull")) return { clients: [], products: [], orders: [], categories: [], comboOptions: [], comboDefinitions: [], cursor: ts };
      return { order: { id: "remote-order" } };
    });
  });
  afterEach(() => mockSqlite.close());

  it("persists an edit made after a lost client create ACK and coalesces its pending events", async () => {
    const client = await createClientLocal({ businessName: "First" });
    let remote = { id: "new-remote-client", client_local_id: client.id, business_name: "First" };
    let first = true;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/clients" && first) { first = false; throw new ApiError("Respuesta perdida", 0); }
      if (path === "/clients") return { client: remote, deduped: true };
      if (path === "/clients/new-remote-client") { remote = { ...remote, business_name: options.body.businessName }; return { client: remote }; }
      return { workDay: null };
    });
    expect((await pushOnlySync("user")).pushed.deferred).toBe(1);
    await updateClientLocal(client.id, { businessName: "Second" });
    await mockDb.runAsync("UPDATE outbox SET next_retry_at=NULL");
    expect((await pushOnlySync("user")).pushed.done).toBe(1);
    expect(remote.business_name).toBe("Second");
    expect(scalar(`SELECT COUNT(*) n FROM outbox WHERE status <> 'done'`).n).toBe(0);
    await upsertFromServer(remote);
    expect(scalar(`SELECT business_name,sync_status FROM clients WHERE id='${client.id}'`)).toMatchObject({ business_name: "Second", sync_status: "synced" });
  });

  it("an old client ACK cannot confirm or overwrite a newer local edit", async () => {
    const client = await createClientLocal({ businessName: "First" });
    const entered = deferred<void>(), ack = deferred<any>();
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path === "/clients") { entered.resolve(); return ack.promise; }
      return { workDay: null };
    });
    const firstPush = pushOnlySync("user");
    await entered.promise;
    await updateClientLocal(client.id, { businessName: "Second" });
    ack.resolve({ client: { id: "new-remote-client" } });
    await firstPush;
    expect(scalar(`SELECT sync_status FROM clients WHERE id='${client.id}'`).sync_status).toBe("pending");
    await upsertFromServer({ id: "new-remote-client", client_local_id: client.id, business_name: "First" });
    expect(scalar(`SELECT business_name FROM clients WHERE id='${client.id}'`).business_name).toBe("Second");
    expect(scalar("SELECT COUNT(*) n FROM outbox WHERE status <> 'done'").n).toBe(1);
  });

  it("an old order ACK leaves a newer quantity pending and protects it from pull", async () => {
    const order = await createOrderLocal({ workDayLocalId: "day", clientId: "client", paymentCondition: "Contado", lines: [line] });
    const entered = deferred<void>(), ack = deferred<any>();
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path === "/orders") { entered.resolve(); return ack.promise; }
      return { workDay: null };
    });
    const firstPush = pushOnlySync("user");
    await entered.promise;
    await updateOrderLocal(order.id, [{ ...line, quantity: 2, subtotalCents: 2002 }]);
    ack.resolve({ order: { id: "new-remote-order" } });
    await firstPush;
    expect(scalar("SELECT total_cents,sync_status FROM orders")).toMatchObject({ total_cents: 2002, sync_status: "pending" });
    await upsertOrderFromServer(orderFixture({ id: "new-remote-order", idempotency_key: order.id }));
    expect(scalar("SELECT total_cents,sync_status FROM orders")).toMatchObject({ total_cents: 2002, sync_status: "pending" });
    expect(scalar("SELECT quantity FROM order_items").quantity).toBe(2);
    let finalBody: any;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/orders/new-remote-order") { finalBody = options.body; return { order: { id: "new-remote-order" } }; }
      return { workDay: null };
    });
    await pushOnlySync("user");
    expect(finalBody.items[0].quantity).toBe(2);
    expect(scalar("SELECT sync_status FROM orders").sync_status).toBe("synced");
  });

  it("retries a deduplicated order creation with its edited quantities before completing it", async () => {
    const order = await createOrderLocal({ workDayLocalId: "day", clientId: "client", paymentCondition: "Contado", lines: [line] });
    let first = true, remoteQuantity = 1;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/orders" && first) { first = false; throw new ApiError("Respuesta perdida", 0); }
      if (path === "/orders") return { order: { id: "new-remote-order", status: "active", payment_condition: "Contado", items: [{ productId: "remote-product", presentationId: "remote-pres", quantity: 1, unitPriceCents: 1001 }] }, deduped: true };
      if (path === "/orders/new-remote-order") { remoteQuantity = options.body.items[0].quantity; return { order: { id: "new-remote-order" } }; }
      return { workDay: null };
    });
    await pushOnlySync("user");
    await updateOrderLocal(order.id, [{ ...line, quantity: 3, subtotalCents: 3003 }]);
    await mockDb.runAsync("UPDATE outbox SET next_retry_at=NULL");
    await pushOnlySync("user");
    expect(remoteQuantity).toBe(3);
    expect(scalar("SELECT COUNT(*) n FROM orders").n).toBe(1);
    expect(scalar("SELECT total_cents,sync_status FROM orders")).toMatchObject({ total_cents: 3003, sync_status: "synced" });
  });

  it("retries a deduplicated product creation with its latest name and prices", async () => {
    const p = await createProductLocal({ name: "First", presentations: [{ name: "Bolsa", unitEquivalence: 1, priceCents: 100, costCents: 0 }] });
    let remote: any, first = true;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/catalog/products" && first) { first = false; remote = productResponse(options.body); throw new ApiError("Respuesta perdida", 0); }
      if (path === "/catalog/products") return { product: remote, deduped: true };
      if (path === "/catalog/products/new-remote-product") { remote = productResponse(options.body); return { product: remote }; }
      return { workDay: null };
    });
    await pushOnlySync("user");
    await updateProductLocal(p.id, { name: "Second", presentations: [{ id: p.presentations[0].id, name: "Bolsa", unitEquivalence: 1, priceCents: 200, costCents: 0 }] });
    await mockDb.runAsync("UPDATE outbox SET next_retry_at=NULL");
    await pushOnlySync("user");
    expect(remote.name).toBe("Second");
    expect(remote.presentations[0].price_cents).toBe(200);
    await upsertProductFromServer(remote);
    expect((await getProduct(p.id))!.name).toBe("Second");
    expect((await getProduct(p.id))!.presentations[0].price_cents).toBe(200);
    expect(scalar("SELECT COUNT(*) n FROM outbox WHERE status <> 'done'").n).toBe(0);
  });

  it("an old product ACK leaves later presentation edits pending during a pull", async () => {
    const p = await createProductLocal({ name: "First", presentations: [{ name: "Bolsa", unitEquivalence: 1, priceCents: 100, costCents: 0 }] });
    const entered = deferred<void>(), ack = deferred<any>();
    let original: any;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/catalog/products") { original = productResponse(options.body); entered.resolve(); return ack.promise; }
      return { workDay: null };
    });
    const pushing = pushOnlySync("user");
    await entered.promise;
    await updateProductLocal(p.id, { name: "Second", presentations: [{ id: p.presentations[0].id, name: "Bolsa grande", unitEquivalence: 1, priceCents: 200, costCents: 0 }] });
    ack.resolve({ product: original });
    await pushing;
    await upsertProductFromServer(original);
    const local = (await getProduct(p.id))!;
    expect(local).toMatchObject({ name: "Second", sync_status: "pending" });
    expect(local.presentations[0]).toMatchObject({ name: "Bolsa grande", price_cents: 200 });
  });

  it("favorites survive aliases, filter correctly and remove both legacy copies", async () => {
    await toggleFavoriteLocal("p");
    await mockDb.runAsync("INSERT INTO product_favorites(product_id,created_at) VALUES ('remote-product',?)", [ts]);
    await upsertProductFromServer({ id: "remote-product", sku: "P1", name: "Papa", presentations: [{ id: "remote-pres", name: "Unidad", price_cents: 1001 }] });
    expect(scalar("SELECT COUNT(*) n FROM product_favorites").n).toBe(1);
    expect((await listProducts({ onlyFavorites: true })).map(p => p.id)).toEqual(["p"]);
    expect(await isFavoriteLocal("remote-product")).toBe(true);
    expect(await toggleFavoriteLocal("remote-product")).toBe(false);
    expect(scalar("SELECT COUNT(*) n FROM product_favorites").n).toBe(0);
    expect(await listProducts({ onlyFavorites: true })).toHaveLength(0);
  });

  it("a synced combo keeps one active definition and editing uses the new limits", async () => {
    const p = await createProductLocal({ name: "Combo", productType: "combo", presentations: [{ name: "Combo", unitEquivalence: 1, priceCents: 200, costCents: 0 }], comboDefinition: { selectionMin: 1, selectionMax: 1, options: [{ presentationId: "pres", maxQuantity: 2 }] } });
    let remote: any;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/catalog/products" || path === "/catalog/products/new-remote-product") { remote = productResponse(options.body); return { product: remote }; }
      return { workDay: null };
    });
    await pushOnlySync("user");
    await upsertProductFromServer(remote);
    expect(scalar("SELECT COUNT(*) n FROM combo_definitions WHERE active=1").n).toBe(1);
    const local = (await getProduct(p.id))!;
    await updateProductLocal(p.id, { name: "Combo", productType: "combo", presentations: [{ id: local.presentations[0].id, name: "Combo", unitEquivalence: 1, priceCents: 200, costCents: 0 }], comboDefinition: { selectionMin: 1, selectionMax: 2, options: [{ presentationId: "pres", maxQuantity: 2 }] } });
    expect((await getProduct(p.id))!.combo_definition!.selection_max).toBe(2);
    await pushOnlySync("user");
    await upsertProductFromServer(remote);
    expect(scalar("SELECT COUNT(*) n FROM combo_definitions WHERE active=1").n).toBe(1);
    expect((await getProduct(p.id))!.combo_definition!.selection_max).toBe(2);
  });

  it("renaming a presentation sends its stable remote ID and preserves dependent combo links", async () => {
    await mockDb.runAsync("INSERT INTO combo_definitions(id,product_id,selection_min,selection_max) VALUES ('definition','p',1,1)");
    await mockDb.runAsync("INSERT INTO combo_options(id,combo_id,presentation_id) VALUES ('option','definition','remote-pres')");
    await updateProductLocal("p", { name: "Papa", presentations: [{ id: "pres", name: "Bolsa nueva", unitEquivalence: 1, priceCents: 1001, costCents: 0 }] });
    let body: any;
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path === "/catalog/products/remote-product") { body = options.body; return { product: productResponse(body, "remote-product") }; }
      return { workDay: null };
    });
    await pushOnlySync("user");
    expect(body.presentations[0]).toMatchObject({ id: "remote-pres", localId: "pres", name: "Bolsa nueva" });
    expect(scalar("SELECT presentation_id FROM combo_options").presentation_id).toBe("remote-pres");
    expect(await resolveServerPresentationId("pres")).toBe("remote-pres");
  });

  it.each(["empty", "foreign", "above-limit"])("rejects an invalid %s combo atomically before writing its header", async (kind) => {
    const combo = await createProductLocal({ name: "Combo", productType: "combo", presentations: [{ name: "Combo", unitEquivalence: 1, priceCents: 200, costCents: 0 }], comboDefinition: { selectionMin: 1, selectionMax: 2, options: [{ presentationId: "pres", maxQuantity: 1 }] } });
    const comboLine: CartLine = {
      ...line, productId: combo.id, presentationId: combo.presentations[0].id,
      unitPriceCents: 200, subtotalCents: 200, isCombo: true,
      selections: kind === "empty" ? [] : [{ selectedProductId: "p", selectedPresentationId: kind === "foreign" ? "missing-pres" : "pres",
        productNameSnapshot: "Papa", presentationNameSnapshot: "Unidad", quantity: kind === "above-limit" ? 2 : 1, sortOrder: 0 }],
    };
    await expect(createOrderLocal({ workDayLocalId: "day", clientId: "client", paymentCondition: "Contado", lines: [comboLine] })).rejects.toThrow();
    expect(scalar("SELECT COUNT(*) n FROM orders").n).toBe(0);
    expect(scalar("SELECT COUNT(*) n FROM order_items").n).toBe(0);
    expect(scalar("SELECT COUNT(*) n FROM outbox WHERE entity_type='order'").n).toBe(0);
  });

  it("historical orders and local deletion accept a remote workday ID without orphan selections", async () => {
    await seedOrder("local-order", "remote-order", "synced");
    await mockDb.runAsync("UPDATE work_days SET status='closed'");
    await mockDb.runAsync("INSERT INTO order_item_selections(id,order_item_id,selected_product_id,selected_presentation_id,product_name_snapshot,presentation_name_snapshot,quantity) VALUES ('s','item-local-order','p','pres','Papa','Unidad',1)");
    expect((await getWorkDay("remote-day"))!.id).toBe("day");
    expect((await listOrdersForWorkDay("remote-day")).map(o => o.id)).toEqual(["local-order"]);
    await assertClosedWorkDayDeletable("remote-day");
    await deleteClosedWorkDayLocal("remote-day");
    for (const table of ["work_days", "orders", "order_items", "order_item_selections"]) expect(scalar(`SELECT COUNT(*) n FROM ${table}`).n).toBe(0);
  });

  it.each(["pending", "outbox-only"])("preflight blocks remote workday deletion with %s local work", async (mode) => {
    await seedOrder("local-order", "remote-order", mode === "pending" ? "pending" : "synced");
    await mockDb.runAsync("UPDATE work_days SET status='closed'");
    if (mode === "outbox-only") await queue("local-order", "update");
    await expect(assertClosedWorkDayDeletable("remote-day")).rejects.toThrow(/pendientes/);
    await expect(deleteClosedWorkDayLocal("remote-day")).rejects.toThrow(/pendientes/);
    expect(scalar("SELECT COUNT(*) n FROM work_days").n).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM orders").n).toBe(1);
  });

  it("reconciles a lost create ACK by its original UUID without a second local order or doubled totals", async () => {
    await seedOrder();
    await queue("local-order");
    await upsertOrderFromServer(orderFixture());
    expect(scalar("SELECT COUNT(*) AS n FROM orders").n).toBe(1);
    expect(scalar("SELECT server_id,sync_status FROM orders")).toMatchObject({ server_id: "remote-order", sync_status: "pending" });
    expect(scalar("SELECT total_cents,order_count FROM work_days")).toMatchObject({ total_cents: 1001, order_count: 1 });
    expect(scalar("SELECT COUNT(*) AS n FROM order_items").n).toBe(1);
  });

  it("repairs a previously downloaded duplicate without replacing a pending local edit", async () => {
    await seedOrder();
    await seedOrder("remote-order", "remote-order", "synced");
    await mockDb.runAsync("UPDATE order_items SET quantity = 2, subtotal_cents = 2002 WHERE order_id = 'local-order'");
    await mockDb.runAsync("UPDATE orders SET total_cents=2002,subtotal_cents=2002,item_count=2 WHERE id='local-order'");
    await upsertOrderFromServer(orderFixture());
    expect(scalar("SELECT COUNT(*) AS n FROM orders").n).toBe(1);
    expect(scalar("SELECT total_cents FROM orders").total_cents).toBe(2002);
    expect(scalar("SELECT total_cents FROM work_days").total_cents).toBe(2002);
  });

  it("rejects incomplete server details before deleting valid local lines", async () => {
    await seedOrder("remote-order", "remote-order", "synced");
    await expect(upsertOrderFromServer(orderFixture({ items: [] }))).rejects.toThrow("incompleta");
    expect(scalar("SELECT COUNT(*) AS n FROM order_items").n).toBe(1);
  });

  it.each(["pending", "failed", "syncing"])("preserves %s client/category fields while attaching server mappings", async (status) => {
    await mockDb.runAsync("UPDATE clients SET phone='77777777',sync_status=? WHERE id='client'", [status]);
    await mockDb.runAsync("INSERT INTO categories(id,server_id,name,sync_status) VALUES ('cat','remote-cat','Nombre editado',?)", [status]);
    await upsertFromServer({ id: "remote-client", client_local_id: "client", business_name: "Tienda", phone: "11111111" });
    await upsertCategoryFromServer({ id: "remote-cat", name: "Nombre antiguo", active: false });
    expect(scalar("SELECT phone,sync_status FROM clients")).toMatchObject({ phone: "77777777", sync_status: status });
    expect(scalar("SELECT name,active,sync_status FROM categories")).toMatchObject({ name: "Nombre editado", active: 1, sync_status: status });
  });

  it("rolls back the whole new order if its outbox write fails", async () => {
    mockFailOutbox = true;
    await expect(createOrderLocal({ workDayLocalId: "day", clientId: "client", paymentCondition: "Contado", lines: [line] })).rejects.toThrow("outbox disk");
    expect(scalar("SELECT COUNT(*) AS n FROM orders").n).toBe(0);
    expect(scalar("SELECT COUNT(*) AS n FROM order_items").n).toBe(0);
    expect(scalar("SELECT total_cents FROM work_days").total_cents).toBe(0);
  });

  it.each(["update", "cancel"])("rolls back %s and totals if enqueue fails", async (operation) => {
    await seedOrder("local-order", "remote-order", "synced");
    await mockDb.runAsync("UPDATE work_days SET total_cents=1001,order_count=1");
    mockFailOutbox = true;
    const action = operation === "update" ? updateOrderLocal("local-order", [{ ...line, quantity: 2, subtotalCents: 2002 }]) : cancelOrderLocal("local-order");
    await expect(action).rejects.toThrow("outbox disk");
    expect(scalar("SELECT total_cents,status,sync_status FROM orders")).toMatchObject({ total_cents: 1001, status: "active", sync_status: "synced" });
    expect(scalar("SELECT quantity FROM order_items").quantity).toBe(1);
    expect(scalar("SELECT total_cents FROM work_days").total_cents).toBe(1001);
  });

  it("replaces removed combo options in a complete snapshot and protects pending combo edits", async () => {
    await mockDb.runAsync("INSERT INTO combo_definitions(id,server_id,product_id,selection_min,selection_max) VALUES ('combo','remote-combo','p',1,2)");
    await mockDb.runAsync("INSERT INTO combo_options(id,server_id,combo_id,presentation_id) VALUES ('old','remote-old','combo','pres')");
    (apiFetch as jest.Mock).mockResolvedValue({ comboOptionsComplete: true, comboOptions: [], categories: [], clients: [], products: [], orders: [] });
    await pullCatalog("user", true);
    expect(scalar("SELECT active FROM combo_options").active).toBe(0);
    await mockDb.runAsync("UPDATE combo_options SET active=1");
    await mockDb.runAsync("UPDATE products SET sync_status='pending'");
    await pullCatalog("user", true);
    expect(scalar("SELECT active FROM combo_options").active).toBe(1);
  });

  it("reconciles embedded combo options and unknown presentations without sending local UUIDs", async () => {
    await mockDb.runAsync("INSERT INTO combo_definitions(id,server_id,product_id,selection_min,selection_max) VALUES ('combo','remote-combo','p',1,2)");
    await mockDb.runAsync("INSERT INTO combo_options(id,combo_id,presentation_id) VALUES ('old','combo','pres')");
    await upsertProductFromServer({ id: "remote-product", sku: "P1", name: "Papa", presentations: [{ id: "remote-pres", name: "Unidad", price_cents: 1001 }], combo_definition: { id: "remote-combo", selection_min: 1, selection_max: 2, options: [] } });
    expect(scalar("SELECT active FROM combo_options").active).toBe(0);
    expect(await resolveServerPresentationId("unknown-local-uuid")).toBeNull();
  });

  it("sends explicit null for cleared client fields", async () => {
    await mockDb.runAsync("UPDATE clients SET sync_status='pending',contact_name=NULL,owner_name=NULL,phone=NULL,address=NULL,lat=NULL,lng=NULL");
    await mockDb.runAsync("INSERT INTO outbox(id,entity_type,local_entity_id,status,created_at) VALUES ('q-client','client','client','pending',?)", [ts]);
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => path === "/clients/remote-client" ? { client: { id: "remote-client" } } : { workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } });
    await pushOnlySync("user");
    const options = (apiFetch as jest.Mock).mock.calls.find(([path]) => path === "/clients/remote-client")![1];
    expect(options.body).toMatchObject({ contactName: null, phone: null, address: null, lat: null, lng: null });
  });

  it("continues after a per-record 500 even after many attempts, and retries it after backoff", async () => {
    await seedOrder("bad"); await seedOrder("good");
    await queue("bad", "create", 20); await queue("good");
    (apiFetch as jest.Mock).mockImplementation(async (path: string, options: any) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } };
      if (path === "/orders" && options.body.idempotencyKey === "bad") throw new ApiError("Temporary database issue", 500);
      return { order: { id: "server-good" } };
    });
    const result = await pushOnlySync("user");
    expect(result.pushed).toMatchObject({ done: 1, deferred: 1, failed: 0 });
    expect(scalar("SELECT status,next_retry_at FROM outbox WHERE id='q-bad'")).toMatchObject({ status: "pending", next_retry_at: expect.any(String) });
    expect((await listPending()).map((row) => row.id)).not.toContain("q-bad");
    const payload = (apiFetch as jest.Mock).mock.calls.find(([path, options]) => path === "/orders" && options.body.idempotencyKey === "bad")![1].body;
    expect(payload.createdAt).toBe(ts);
    await mockDb.runAsync("UPDATE outbox SET next_retry_at=NULL WHERE id='q-bad'");
    (apiFetch as jest.Mock).mockResolvedValue({ order: { id: "server-bad" }, workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } });
    expect((await pushOnlySync("user")).pushed.done).toBe(1);
  });

  it("force sync preserves an offline order when the other phone closed the workday", async () => {
    await seedOrder(); await queue("local-order");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", work_date: todayBolivia(), status: "closed" } };
      if (path.startsWith("/sync/pull")) return { clients: [], products: [], orders: [] };
      throw new ApiError("La jornada está cerrada", 400);
    });
    await runSync("user", { forcePull: true });
    expect(scalar("SELECT status,sync_status FROM orders")).toMatchObject({ status: "active", sync_status: "failed" });
    expect(scalar("SELECT COUNT(*) AS n FROM order_items").n).toBe(1);
    expect(scalar("SELECT status,last_error FROM outbox")).toMatchObject({ status: "error", last_error: expect.stringContaining("conserva") });
  });

  it("recreates a missing legacy outbox operation exactly once", async () => {
    await seedOrder();
    await pushOnlySync("user"); await pushOnlySync("user");
    expect(scalar("SELECT COUNT(*) AS n FROM outbox").n).toBe(1);
    expect((apiFetch as jest.Mock).mock.calls.filter(([path]) => path === "/orders")).toHaveLength(1);
  });

  it("cancels the remote order even when its create ACK was lost before the local cancellation", async () => {
    await seedOrder();
    await mockDb.runAsync("UPDATE orders SET status='cancelled'");
    await queue("local-order", "cancel");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } };
      if (path === "/sync/push") return { results: [{ id: "local-order", status: "synced", serverId: "remote-order" }] };
      return { order: { id: "remote-order" } };
    });
    const result = await pushOnlySync("user");
    expect(result.pushed.done).toBe(1);
    expect(apiFetch).toHaveBeenCalledWith("/sync/push", { method: "POST", body: { operations: [{ id: "local-order", entityType: "order", operation: "cancel", data: { idempotencyKey: "local-order" } }] } });
    expect((apiFetch as jest.Mock).mock.calls.some(([path]) => path.startsWith("/sync/pull"))).toBe(false);
    expect(scalar("SELECT status,sync_status,server_id FROM orders")).toMatchObject({ status: "cancelled", sync_status: "synced", server_id: "remote-order" });
  });

  it("keeps a cancellation pending when lookup by original UUID fails temporarily", async () => {
    await seedOrder();
    await mockDb.runAsync("UPDATE orders SET status='cancelled'");
    await queue("local-order", "cancel");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } };
      return { results: [{ id: "local-order", status: "failed", httpStatus: 503, error: "Database unavailable" }] };
    });
    expect((await pushOnlySync("user")).pushed.deferred).toBe(1);
    expect(scalar("SELECT status,sync_status FROM orders")).toMatchObject({ status: "cancelled", sync_status: "pending" });
    expect(scalar("SELECT status,next_retry_at FROM outbox")).toMatchObject({ status: "pending", next_retry_at: expect.any(String) });
  });

  it("confirms a local-only cancellation when the server has no order for its original UUID", async () => {
    await seedOrder();
    await mockDb.runAsync("UPDATE orders SET status='cancelled'");
    await queue("local-order", "cancel");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "remote-day", work_date: todayBolivia(), status: "open" } };
      return { results: [{ id: "local-order", status: "synced", action: "cancelled" }] };
    });
    expect((await pushOnlySync("user")).pushed.done).toBe(1);
    expect(scalar("SELECT status,sync_status,server_id FROM orders")).toMatchObject({ status: "cancelled", sync_status: "synced", server_id: null });
    expect(scalar("SELECT status FROM outbox").status).toBe("done");
  });

  it("resolves a workday captured entirely offline on a previous day through atomic batch sync", async () => {
    await mockDb.runAsync("UPDATE work_days SET server_id=NULL,work_date='2026-10-19',status='closed'");
    await seedOrder(); await queue("local-order");
    await mockDb.runAsync("UPDATE orders SET created_at='2026-10-19T12:00:00.000Z'");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "today-remote", work_date: todayBolivia(), status: "open" } };
      if (path === "/sync/push") return { results: [{ id: "local-order", status: "synced", serverId: "historical-order", workDay: { id: "historical-day", work_date: "2026-10-19", status: "closed" } }] };
      throw new Error(`Unexpected request ${path}`);
    });
    const result = await pushOnlySync("user");
    expect(result.pushed.done).toBe(1);
    const payload = (apiFetch as jest.Mock).mock.calls.find(([path]) => path === "/sync/push")![1].body;
    expect(payload.operations[0]).toMatchObject({ id: "local-order", entityType: "order", operation: "create", data: { work_date: "2026-10-19", createdAt: "2026-10-19T12:00:00.000Z", idempotencyKey: "local-order" } });
    expect(scalar("SELECT server_id,sync_status FROM orders")).toMatchObject({ server_id: "historical-order", sync_status: "synced" });
    expect(scalar("SELECT server_id,status,total_cents FROM work_days WHERE id='day'")).toMatchObject({ server_id: "historical-day", status: "closed", total_cents: 1001 });
    expect((apiFetch as jest.Mock).mock.calls.filter(([path]) => path === "/orders")).toHaveLength(0);
  });

  it("does not merge today's local workday with a historical workDay returned by pull", async () => {
    await seedOrder(); await queue("local-order");
    (apiFetch as jest.Mock).mockResolvedValue({
      clients: [], products: [], orders: [], categories: [],
      workDay: { id: "historical-day", work_date: "2026-10-18", status: "closed", total_cents: 0, order_count: 0 },
    });
    await pullCatalog("user", true);
    expect(scalar("SELECT server_id,work_date,status FROM work_days WHERE id='day'")).toMatchObject({ server_id: "remote-day", work_date: todayBolivia(), status: "open" });
    expect(scalar("SELECT work_date,status FROM work_days WHERE id='historical-day'")).toMatchObject({ work_date: "2026-10-18", status: "closed" });
    expect(scalar("SELECT work_day_id FROM orders").work_day_id).toBe("day");
  });

  it("retains historical offline orders when a batch operation reports a retryable database failure", async () => {
    await mockDb.runAsync("UPDATE work_days SET server_id=NULL,work_date='2026-10-19',status='closed'");
    await seedOrder(); await queue("local-order");
    await mockDb.runAsync("UPDATE orders SET created_at='2026-10-19T12:00:00.000Z'");
    (apiFetch as jest.Mock).mockImplementation(async (path: string) => {
      if (path.startsWith("/workdays/current")) return { workDay: { id: "today-remote", work_date: todayBolivia(), status: "open" } };
      return { results: [{ id: "local-order", status: "failed", httpStatus: 503, retryable: true, error: "Database temporarily unavailable" }] };
    });
    expect((await pushOnlySync("user")).pushed.deferred).toBe(1);
    expect(scalar("SELECT status,sync_status FROM orders")).toMatchObject({ status: "active", sync_status: "pending" });
    expect(scalar("SELECT status,next_retry_at FROM outbox")).toMatchObject({ status: "pending", next_retry_at: expect.any(String) });
  });

  it("receives deleted workdays without discarding unsynced orders", async () => {
    await seedOrder(); await queue("local-order");
    (apiFetch as jest.Mock).mockResolvedValue({ clients: [], products: [], orders: [], deletedWorkDayIds: ["remote-day"] });
    await pullCatalog("user", true);
    expect(scalar("SELECT COUNT(*) AS n FROM orders").n).toBe(1);
    expect(scalar("SELECT status FROM orders").status).toBe("active");
    expect(scalar("SELECT status FROM work_days").status).toBe("closed");
    expect(scalar("SELECT status FROM outbox").status).toBe("error");
    expect(scalar("SELECT sync_error FROM orders").sync_error).toContain("eliminada");
  });

  it("cleans an already synced deleted workday including combo selections", async () => {
    await seedOrder("local-order", "remote-order", "synced");
    await mockDb.runAsync("INSERT INTO order_item_selections(id,order_item_id,selected_product_id,selected_presentation_id,product_name_snapshot,presentation_name_snapshot,quantity) VALUES ('s','item-local-order','p','pres','Papa','Unidad',1)");
    (apiFetch as jest.Mock).mockResolvedValue({ deletedWorkDayIds: ["remote-day"] });
    await pullCatalog("user", true);
    expect(scalar("SELECT COUNT(*) AS n FROM work_days").n).toBe(0);
    expect(scalar("SELECT COUNT(*) AS n FROM order_items").n).toBe(0);
    expect(scalar("SELECT COUNT(*) AS n FROM order_item_selections").n).toBe(0);
  });

  it("consolidates combo components with exact cent allocation and weighted prices like Excel", async () => {
    await seedOrder();
    await mockDb.runAsync("UPDATE order_items SET product_name_snapshot='Combo',quantity=2,subtotal_cents=1001 WHERE id='item-local-order'");
    await mockDb.runAsync("INSERT INTO order_item_selections(id,order_item_id,selected_product_id,selected_presentation_id,product_name_snapshot,presentation_name_snapshot,quantity,sort_order) VALUES ('s1','item-local-order','p','pres','Papa','Unidad',3,0),('s2','item-local-order','p','pres','Yuca','Unidad',1,1)");
    await mockDb.runAsync("INSERT INTO order_items SELECT 'standard',order_id,product_id,presentation_id,'Papa',sku_snapshot,presentation_name_snapshot,unit_equivalence_snapshot,1000,1,1000 FROM order_items LIMIT 1");
    const result = await getConsolidatedProductsForWorkDay("day");
    expect(result.grandTotalCents).toBe(2001);
    expect(result.grandTotalUnits).toBe(9);
    expect(result.items).toEqual([
      { productName: "Papa", presentationName: "Unidad", unitPriceCents: 250, totalSubtotalCents: 1751, totalUnits: 7 },
      { productName: "Yuca", presentationName: "Unidad", unitPriceCents: 125, totalSubtotalCents: 250, totalUnits: 2 },
    ]);
  });

  it("serializes maintenance behind an active sync", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    (apiFetch as jest.Mock).mockImplementation(async () => { await gate; events.push("sync"); return { workDay: null }; });
    const sync = pushOnlySync("user");
    const maintenance = withSyncMaintenance(async () => { events.push("backup"); });
    await Promise.resolve(); expect(events).toEqual([]);
    release(); await Promise.all([sync, maintenance]);
    expect(events[events.length - 1]).toBe("backup");
  });
});

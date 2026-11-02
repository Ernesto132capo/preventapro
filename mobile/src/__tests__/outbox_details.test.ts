import { LOCAL_SCHEMA } from "../db/schema";
import { getOutboxSummary, listOutboxDetails, OutboxEntity, OutboxRow } from "../db/outbox";

const DatabaseSync = (process as any).getBuiltinModule?.("node:sqlite")?.DatabaseSync;
const sqliteDescribe = DatabaseSync ? describe : describe.skip;
let mockSqlite: any;
const mockDb = {
  getFirstAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) || null,
  getAllAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params),
};
jest.mock("../db/client", () => ({ getDb: async () => mockDb, nowIso: () => new Date().toISOString() }));

const ts = "2026-10-20T02:00:00.000Z";
function queue(id: string, status: OutboxRow["status"], type: OutboxEntity = "order", entityId = id, createdAt = ts) {
  mockSqlite.prepare(`INSERT INTO outbox(id,entity_type,local_entity_id,status,last_error,created_at)
    VALUES (?,?,?,?,?,?)`).run(id, type, entityId, status, status === "error" || status === "failed" ? "No se pudo guardar" : null, createdAt);
}
function seedOrder(id: string, status = "active") {
  mockSqlite.prepare(`INSERT INTO orders(id,work_day_id,client_id,client_name,subtotal_cents,tax_cents,total_cents,item_count,status,created_at,updated_at)
    VALUES (?,'day','client','Tienda Esperanza',1000,0,1000,1,?,?,?)`).run(id, status, ts, ts);
}

sqliteDescribe("Detalle de operaciones pendientes con SQLite real", () => {
  beforeEach(() => {
    mockSqlite = new DatabaseSync(":memory:");
    mockSqlite.exec(LOCAL_SCHEMA);
  });
  afterEach(() => mockSqlite.close());

  it("cuenta todos los errores, incluidos más de cinco y los permanentes, sin contar completados", async () => {
    for (let index = 0; index < 7; index++) queue(`error-${index}`, "error");
    for (let index = 0; index < 2; index++) queue(`failed-${index}`, "failed");
    for (let index = 0; index < 3; index++) queue(`pending-${index}`, "pending");
    queue("syncing", "syncing");
    queue("done", "done");
    queue("done-2", "done");

    expect(await getOutboxSummary()).toEqual({ total: 13, pending: 3, syncing: 1, failed: 2, error: 7, conflict: 0 });
    const errors = await listOutboxDetails({ errorsOnly: true });
    expect(errors).toHaveLength(9);
    expect(errors.every(row => row.status === "failed" || row.status === "error")).toBe(true);
    expect(await listOutboxDetails()).toHaveLength(13);
  });

  it("devuelve ceros y una lista vacía cuando no hay operaciones pendientes", async () => {
    queue("done", "done");
    expect(await getOutboxSummary()).toEqual({ total: 0, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 0 });
    expect(await listOutboxDetails()).toEqual([]);
  });

  it("incluye conflictos persistentes en el total y en Por revisar", async () => {
    queue("conflict-product", "conflict", "product");
    expect(await getOutboxSummary()).toEqual({ total: 1, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 1 });
    expect(await listOutboxDetails({ errorsOnly: true })).toMatchObject([{ id: "conflict-product", status: "conflict" }]);
  });

  it("pagina con un orden estable, incluso si varias operaciones tienen la misma fecha", async () => {
    queue("a", "pending");
    queue("b", "error");
    queue("c", "syncing");
    queue("newer", "failed", "order", "order", "2026-10-21T12:00:00.000Z");
    const first = await listOutboxDetails({ limit: 2 });
    const second = await listOutboxDetails({ limit: 2, offset: 2 });
    expect(first.map(row => row.id)).toEqual(["newer", "c"]);
    expect(second.map(row => row.id)).toEqual(["b", "a"]);
    expect((await listOutboxDetails({ offset: 4 })).length).toBe(0);
    expect((await listOutboxDetails({ errorsOnly: true, limit: 1, offset: 1 })).map(row => row.id)).toEqual(["b"]);
  });

  it("identifica preventas, clientes, productos y categorías usando sus datos locales", async () => {
    seedOrder("order-uuid");
    mockSqlite.prepare(`INSERT INTO clients(id,business_name,contact_name,phone,created_at,updated_at)
      VALUES ('client','Tienda Esperanza','Ana','77777777',?,?)`).run(ts, ts);
    mockSqlite.exec("INSERT INTO products(id,sku,name) VALUES ('product','P-001','Arroz')");
    mockSqlite.exec("INSERT INTO categories(id,name) VALUES ('category','Alimentos')");
    queue("order-op", "pending", "order", "order-uuid");
    queue("client-op", "failed", "client", "client");
    queue("product-op", "error", "product", "product");
    queue("category-op", "syncing", "category", "category");

    const rows = await listOutboxDetails();
    const byType = Object.fromEntries(rows.map(row => [row.entity_type, row]));
    expect(byType.order).toMatchObject({ entity_name: "Preventa · Tienda Esperanza", entity_subtitle: "Ref. order-uu · 19/10/2026 22:00" });
    expect(byType.client).toMatchObject({ entity_name: "Tienda Esperanza", entity_subtitle: "Ana" });
    expect(byType.product).toMatchObject({ entity_name: "Arroz", entity_subtitle: "P-001" });
    expect(byType.category).toMatchObject({ entity_name: "Alimentos", entity_subtitle: null });
    expect(rows.every(row => row.entity_exists === 1 && row.entity_active === 1)).toBe(true);
  });

  it("identifica clientes sin nombre de tienda mediante su propietario y evita repetir el nombre", async () => {
    mockSqlite.prepare(`INSERT INTO clients(id,business_name,name,contact_name,owner_name,phone,created_at,updated_at)
      VALUES ('owner',' ','','', 'María','77777777',?,?)`).run(ts, ts);
    queue("owner-op", "pending", "client", "owner");
    expect((await listOutboxDetails())[0]).toMatchObject({ entity_name: "María", entity_subtitle: "77777777" });
  });

  it("conserva operaciones de registros inexistentes o inactivos sin ofrecerlos como activos", async () => {
    seedOrder("cancelled", "cancelled");
    mockSqlite.prepare("INSERT INTO clients(id,business_name,active,created_at,updated_at) VALUES ('inactive-client','Antes',0,?,?)").run(ts, ts);
    mockSqlite.exec("INSERT INTO products(id,sku,name,active) VALUES ('inactive-product','OLD','Antiguo',0)");
    mockSqlite.exec("INSERT INTO categories(id,name,active) VALUES ('inactive-category','Anterior',0)");
    const types: OutboxEntity[] = ["order", "client", "product", "category"];
    const inactiveIds = ["cancelled", "inactive-client", "inactive-product", "inactive-category"];
    types.forEach((type, index) => {
      queue(`inactive-${index}`, "error", type, inactiveIds[index]);
      queue(`missing-${index}`, "pending", type, `removed-${index}`);
    });
    const before = mockSqlite.prepare("SELECT * FROM outbox ORDER BY id").all();
    const details = await listOutboxDetails();
    expect(details).toHaveLength(8);
    expect(details.filter(row => row.id.startsWith("inactive")).every(row => row.entity_exists === 1 && row.entity_active === 0)).toBe(true);
    const missing = details.filter(row => row.id.startsWith("missing"));
    expect(missing.every(row => row.entity_exists === 0 && row.entity_active === 0)).toBe(true);
    expect(missing.every(row => row.entity_name.includes("no disponible"))).toBe(true);
    expect(mockSqlite.prepare("SELECT * FROM outbox ORDER BY id").all()).toEqual(before);
  });

  it("limita el tamaño de las páginas y normaliza parámetros inválidos", async () => {
    for (let index = 0; index < 105; index++) queue(`pending-${String(index).padStart(3, "0")}`, "pending");
    expect(await listOutboxDetails()).toHaveLength(30);
    expect(await listOutboxDetails({ limit: 10000, offset: -10 })).toHaveLength(100);
    expect(await listOutboxDetails({ limit: Number.NaN, offset: Number.POSITIVE_INFINITY })).toHaveLength(30);
    expect(await listOutboxDetails({ limit: 1.9, offset: 104.9 })).toHaveLength(1);
  });
});

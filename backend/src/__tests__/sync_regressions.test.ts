import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../db/pg", () => ({
  pool: { query: (...args: any[]) => db.query(...args), connect: () => db.connect() },
  nowIso: () => "2026-10-20T10:00:00.000Z",
}));
vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.userId = "user"; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../routes/workdays", () => ({ closeStaleOpenWorkDays: async () => false, invalidateWorkdayCache: vi.fn() }));
vi.mock("../services/dates", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getBoliviaToday: () => "2026-10-20" }));
import { invalidatePullCache, syncRouter } from "../routes/sync";

function request(method: string, url: string, body: any = {}): Promise<{ status: number; body: any }> {
  const app = express();
  app.use("/api/sync", syncRouter);
  return new Promise((resolve, reject) => {
    const req = { method, url, body, headers: {}, socket: {}, connection: {} } as any;
    const res = {
      statusCode: 200, setHeader: vi.fn(), getHeader: vi.fn(),
      status(status: number) { this.statusCode = status; return this; },
      json(value: any) { resolve({ status: this.statusCode, body: value }); },
      end() { resolve({ status: this.statusCode, body: null }); },
    } as any;
    app(req, res, (error: any) => error ? reject(error) : resolve({ status: res.statusCode, body: null }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePullCache("all");
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
});

describe("Pull completo independiente del límite de caché", () => {
  it.each([26, 40])("conserva las líneas y selecciones de %i preventas", async (count) => {
    const orders = Array.from({ length: count }, (_, i) => ({ id: `order-${i}`, work_day_id: "wd", client_id: "client", status: "active" }));
    db.query.mockImplementation(async (sql: string, values: any[] = []) => {
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: [{ id: "wd", work_date: "2026-10-20" }] };
      if (sql.startsWith("SELECT * FROM orders WHERE work_day_id")) return { rows: orders };
      if (sql.startsWith("SELECT * FROM order_items")) return { rows: orders.filter(o => values[0].includes(o.id)).map(o => ({ id: `item-${o.id}`, order_id: o.id, quantity: 2, unit_price_cents_snapshot: 99, subtotal_cents: 198 })) };
      if (sql.startsWith("SELECT * FROM order_item_selections")) return { rows: values[0].map((id: string) => ({ id: `selection-${id}`, order_item_id: id, quantity: 1 })) };
      if (sql.startsWith("SELECT * FROM clients")) return { rows: [{ id: "client", business_name: "Tienda" }] };
      return { rows: [] };
    });
    // Segunda descarga mezcla detalles presentes y expulsados de la caché.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request("GET", "/api/sync/pull");
      expect(result.status).toBe(200);
      expect(result.body.orders).toHaveLength(count);
      for (const order of result.body.orders) {
        expect(order.items).toHaveLength(1);
        expect(order.items[0].selections).toHaveLength(1);
        expect(order.items[0].subtotal_cents).toBe(198);
      }
    }
  });

  it("conserva los pedidos de las 30 jornadas aunque la caché solo retenga 25", async () => {
    const workDays = Array.from({ length: 30 }, (_, i) => ({ id: `wd-${i}`, work_date: "2026-10-20" }));
    db.query.mockImplementation(async (sql: string, values: any[] = []) => {
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: workDays };
      if (sql.startsWith("SELECT * FROM orders WHERE work_day_id")) return { rows: values[0].map((id: string) => ({ id: `order-${id}`, work_day_id: id, status: "active" })) };
      if (sql.startsWith("SELECT * FROM order_items")) return { rows: values[0].map((id: string) => ({ id: `item-${id}`, order_id: id, quantity: 1 })) };
      return { rows: [] };
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request("GET", "/api/sync/pull");
      expect(result.body.workDays).toHaveLength(30);
      expect(result.body.orders).toHaveLength(30);
      expect(result.body.orders.every((o: any) => o.items.length === 1)).toBe(true);
    }
  });

  it.each(["", "?since=2026-10-19T10:00:00.000Z"])("propaga inactivos, borrados de jornadas y snapshot de opciones %s", async (query) => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM clients")) return { rows: [{ id: "client", active: false }] };
      if (sql.startsWith("SELECT * FROM products")) return { rows: [{ id: "product", active: false }] };
      if (sql.startsWith("SELECT * FROM categories")) return { rows: [{ id: "category", active: false }] };
      if (sql.includes("FROM product_presentations")) return { rows: [{ id: "presentation", active: false }] };
      if (sql.startsWith("SELECT * FROM combo_definitions")) return { rows: [{ id: "combo", active: false }] };
      if (sql.startsWith("SELECT * FROM combo_options")) return { rows: [{ id: "option", active: false }] };
      if (sql.includes("FROM sync_tombstones")) return { rows: [{ entity_id: "deleted-wd" }] };
      return { rows: [] };
    });
    const result = await request("GET", `/api/sync/pull${query}`);
    for (const key of ["clients", "products", "categories", "presentations", "comboDefinitions", "comboOptions"]) {
      expect(result.body[key][0].active).toBe(0);
    }
    expect(result.body.deletedWorkDayIds).toEqual(["deleted-wd"]);
    expect(result.body.comboOptionsComplete).toBe(true);
    const sourceQueries = db.query.mock.calls.map(c => c[0]).filter(sql => /FROM (clients|products|categories|product_presentations|combo_definitions|combo_options)/.test(sql));
    expect(sourceQueries.every(sql => !sql.includes("active = true"))).toBe(true);
  });
});

describe("Lotes aplican ediciones y borrados dentro de su savepoint", () => {
  function orderDatabase(failInsertion = false) {
    let state = { order: { id: "server-order", idempotency_key: "local-order", work_day_id: "wd", client_id: "client", status: "active", total_cents: 100 }, items: [{ id: "old-item", order_id: "server-order", quantity: 1 }] as any[] };
    let savepoint = structuredClone(state);
    db.query.mockImplementation(async (sql: string, values: any[] = []) => {
      if (sql.startsWith("SAVEPOINT")) savepoint = structuredClone(state);
      if (sql.startsWith("ROLLBACK TO SAVEPOINT")) state = structuredClone(savepoint);
      if (sql.startsWith("SELECT * FROM orders")) return { rows: [state.order] };
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: [{ id: "wd", status: "open" }] };
      if (sql.startsWith("SELECT id, active FROM clients")) return { rows: [{ id: "client", active: true }] };
      if (sql.includes("FROM products WHERE id")) return { rows: [{ id: "product", name: "Papa", sku: "P", product_type: "standard", active: true }] };
      if (sql.includes("FROM product_presentations WHERE id")) return { rows: [{ id: "presentation", product_id: "product", name: "Unidad", unit_equivalence: 1, price_cents: 200, active: true }] };
      if (sql.startsWith("DELETE FROM order_items")) state.items = [];
      if (sql.startsWith("UPDATE orders SET payment_condition")) state.order.total_cents = values[5];
      if (sql.includes("INSERT INTO order_items")) {
        if (failInsertion) throw new Error("Item inválido simulado");
        state.items.push({ id: values[0], order_id: values[1], quantity: values[9] });
      }
      if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: 1, total: state.order.total_cents }] };
      return { rows: [] };
    });
    return () => state;
  }
  const update = { id: "local-order", entityType: "order", operation: "update", data: { serverId: "server-order", items: [{ productId: "product", presentationId: "presentation", quantity: 2, unitPriceCents: 100 }] } };

  it("aplica y reintenta una edición sin duplicar la cabecera ni las líneas", async () => {
    const getState = orderDatabase();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request("POST", "/api/sync/push", { operations: [update] });
      expect(result.body.succeeded).toBe(1);
      expect(result.body.results[0].serverId).toBe("server-order");
      expect(getState().order.total_cents).toBe(200);
      expect(getState().items).toHaveLength(1);
      expect(getState().items[0].quantity).toBe(2);
    }
    expect(db.query.mock.calls.some(c => c[0].includes("INSERT INTO orders"))).toBe(false);
  });

  it("respeta operation:update en el formato de arrays por dominio", async () => {
    const getState = orderDatabase();
    const result = await request("POST", "/api/sync", { orders: [update] });
    expect(result.body.succeeded).toBe(1);
    expect(getState().order.total_cents).toBe(200);
  });

  it("revierte la cabecera y los detalles si una inserción falla, y continúa con otro registro", async () => {
    const getState = orderDatabase(true);
    const result = await request("POST", "/api/sync/push", { operations: [update, { id: "category", entityType: "category", operation: "delete" }] });
    expect(result.body.failed).toBe(1);
    expect(result.body.succeeded).toBe(1);
    expect(getState().order.total_cents).toBe(100);
    expect(getState().items).toEqual([{ id: "old-item", order_id: "server-order", quantity: 1 }]);
    expect(db.query.mock.calls.some(c => c[0].startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
  });

  it.each(["client", "category", "product"])("acepta el borrado idempotente de %s sin exigir datos de creación", async (entityType) => {
    db.query.mockResolvedValue({ rows: [] });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request("POST", "/api/sync/push", { operations: [{ id: "local", entityType, operation: "delete", data: { serverId: "server" } }] });
      expect(result.body.succeeded).toBe(1);
      expect(result.body.results[0].action).toBe("deleted");
    }
    const queries = db.query.mock.calls.filter(c => c[0].startsWith(`UPDATE ${entityType === "category" ? "categories" : `${entityType}s`}`));
    expect(queries).toHaveLength(2);
    expect(queries.every(c => c[0].includes("active = false"))).toBe(true);
    expect(db.query.mock.calls.some(c => c[0].includes("INSERT INTO"))).toBe(false);
  });

  it("cancela de forma idempotente aunque la jornada ya se haya cerrado", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM orders") ? [{ id: "server", status: "cancelled", work_day_id: "closed" }] : [] }));
    const result = await request("POST", "/api/sync/push", { operations: [{ id: "local", entityType: "order", operation: "cancel", data: { serverId: "server" } }] });
    expect(result.body.succeeded).toBe(1);
    expect(result.body.results[0].deduped).toBe(true);
    expect(db.query.mock.calls.some(c => c[0].startsWith("UPDATE orders"))).toBe(false);
  });

  it("no recrea una jornada eliminada para aceptar una preventa pendiente", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM sync_tombstones") ? [{ entity_id: "deleted-wd" }] : [] }));
    const result = await request("POST", "/api/sync/push", { operations: [{ id: "pending", entityType: "order", data: { workDayId: "deleted-wd", clientId: "client", items: [] } }] });
    expect(result.body.failed).toBe(1);
    expect(result.body.results[0].error).toContain("jornada fue eliminada");
    expect(db.query.mock.calls.some(c => c[0].includes("INSERT INTO work_days") || c[0].includes("INSERT INTO orders"))).toBe(false);
  });

  it.each([
    { items: [{ productId: "product", presentationId: "presentation", quantity: 0 }], error: "cantidad" },
    { items: [{ productId: "product", presentationId: "presentation", quantity: 1, unitPriceCents: 10.5 }], error: "centavos" },
    { items: [{ productId: "other-product", presentationId: "presentation", quantity: 1 }], error: "no pertenece" },
  ])("rechaza datos inválidos sin modificar el pedido: $error", async ({ items, error }) => {
    const getState = orderDatabase();
    const result = await request("POST", "/api/sync/push", { operations: [{ ...update, data: { ...update.data, items } }] });
    expect(result.body.failed).toBe(1);
    expect(result.body.results[0].error).toContain(error);
    expect(getState().order.total_cents).toBe(100);
  });
});

it("migración009 conserva tombstones independientemente de las tablas operativas", async () => {
  db.query.mockResolvedValue({ rows: [] });
  const { migrations } = await vi.importActual<any>("../../scripts/migrate");
  await migrations.find((m: any) => m.id === "009_sync_tombstones")!.run({ query: db.query } as any);
  const sql = db.query.mock.calls[0][0];
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS sync_tombstones");
  expect(sql).toContain("PRIMARY KEY (entity_type, entity_id)");
  expect(sql).not.toContain("REFERENCES work_days");
});

it("cancela por UUID original si se perdió la respuesta de creación sin descargar el historial", async () => {
  let cancelled = false;
  db.query.mockImplementation(async (sql: string, values: any[] = []) => {
    if (sql.startsWith("SELECT * FROM orders WHERE id = $1 OR idempotency_key = $2")) {
      expect(values).toEqual(["local-old", "local-old"]);
      return { rows: [{ id: "remote-old", work_day_id: "day", status: cancelled ? "cancelled" : "active" }] };
    }
    if (sql.startsWith("SELECT status FROM work_days")) return { rows: [{ status: "open" }] };
    if (sql.startsWith("UPDATE orders SET status = 'cancelled'")) cancelled = true;
    if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: 0, total: 0 }] };
    return { rows: [] };
  });
  const body = { operations: [{ id: "local-old", entityType: "order", operation: "cancel", data: { idempotencyKey: "local-old" } }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await request("POST", "/api/sync/push", body);
    expect(result.body.results[0]).toMatchObject({ status: "synced", serverId: "remote-old", action: "cancelled" });
  }
  expect(db.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE orders SET status = 'cancelled'"))).toHaveLength(1);
});

describe("Recuperación de jornadas capturadas enteramente offline", () => {
  function offlineDatabase() {
    const workDays: any[] = [{ id: "today", work_date: "2026-10-20", status: "open", user_id: "user" }];
    const orders: any[] = [];
    db.query.mockImplementation(async (sql: string, values: any[] = []) => {
      if (sql.startsWith("SELECT id, user_id FROM orders WHERE idempotency_key")) return { rows: orders.filter(o => o.idempotency_key === values[0]) };
      if (sql.startsWith("SELECT * FROM work_days WHERE work_date")) return { rows: workDays.filter(w => w.work_date === values[0]) };
      if (sql.includes("INSERT INTO work_days")) {
        const row = { id: values[0], user_id: values[1], work_date: values[2], created_at: values[3], status: values[4], closed_at: values[5], auto_closed: values[6], order_count: 0, total_cents: 0 };
        workDays.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT id, active FROM clients")) return { rows: [{ id: "client", active: true }] };
      if (sql.includes("FROM products WHERE id")) return { rows: [{ id: "p", name: "Papa", sku: "P", product_type: "standard", active: true }] };
      if (sql.includes("FROM product_presentations WHERE id")) return { rows: [{ id: "pres", product_id: "p", name: "Unidad", unit_equivalence: 1, price_cents: 300, active: true }] };
      if (sql.includes("INSERT INTO orders")) orders.push({ id: values[0], idempotency_key: values[1], work_day_id: values[2], status: "active", total_cents: values[9] });
      if (sql.startsWith("SELECT COUNT")) {
        const rows = orders.filter(o => o.work_day_id === values[0] && o.status === "active");
        return { rows: [{ count: rows.length, total: rows.reduce((sum, o) => sum + o.total_cents, 0) }] };
      }
      if (sql.startsWith("UPDATE work_days SET order_count")) Object.assign(workDays.find(w => w.id === values[0]), { order_count: values[1], total_cents: values[2] });
      if (sql.startsWith("SELECT wd.* FROM work_days")) return { rows: workDays.filter(w => w.id === orders.find(o => o.id === values[0])?.work_day_id) };
      return { rows: [] };
    });
    return { workDays, orders };
  }
  const payload = (overrides: any = {}) => ({ operations: [{ id: "local-offline-order", entityType: "order", operation: "create", data: { idempotencyKey: "local-offline-order", clientId: "client", work_date: "2026-10-19", createdAt: "2026-10-20T03:30:00.000Z", items: [{ productId: "p", presentationId: "pres", quantity: 2, unitPriceCents: 101 }], ...overrides } }] });

  it("crea ayer cerrada, conserva hoy abierta y devuelve mapping también al perderse la confirmación", async () => {
    const state = offlineDatabase();
    let serverId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request("POST", "/api/sync/push", payload());
      expect(result.body.succeeded).toBe(1);
      const operation = result.body.results[0];
      expect(operation.workDay).toMatchObject({ work_date: "2026-10-19", status: "closed", auto_closed: true, order_count: 1, total_cents: 202 });
      expect(operation.workDayId).toBe(operation.workDay.id);
      if (attempt) expect(operation.serverId).toBe(serverId);
      else serverId = operation.serverId;
    }
    expect(state.orders).toHaveLength(1);
    expect(state.workDays).toHaveLength(2);
    expect(state.workDays.filter(w => w.status === "open").map(w => w.id)).toEqual(["today"]);
  });

  it("usa la fecha de Bolivia cuando createdAt está en el día UTC siguiente y no viene work_date", async () => {
    offlineDatabase();
    const result = await request("POST", "/api/sync/push", payload({ work_date: undefined }));
    expect(result.body.results[0].workDay.work_date).toBe("2026-10-19");
  });

  it("da prioridad a la fecha explícita de la jornada", async () => {
    offlineDatabase();
    const result = await request("POST", "/api/sync/push", payload({ work_date: "2026-10-18" }));
    expect(result.body.results[0].workDay.work_date).toBe("2026-10-18");
  });

  it.each(["2026-10-21", "2026-02-30", "fecha inválida"])("rechaza fecha inválida o futura %s como conflicto permanente sin crear jornadas", async (workDate) => {
    const state = offlineDatabase();
    const result = await request("POST", "/api/sync/push", payload({ work_date: workDate }));
    expect(result.body.failed).toBe(1);
    expect(result.body.results[0]).toMatchObject({ httpStatus: 400, retryable: false });
    expect(state.orders).toHaveLength(0);
    expect(state.workDays).toHaveLength(1);
  });

  it("distingue fallos temporales del servidor para que el móvil no descarte la preventa", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM work_days WHERE work_date")) throw new Error("Connection terminated unexpectedly");
      return { rows: [] };
    });
    const result = await request("POST", "/api/sync/push", payload());
    expect(result.body.results[0]).toMatchObject({ status: "failed", httpStatus: 503, retryable: true });
  });
});

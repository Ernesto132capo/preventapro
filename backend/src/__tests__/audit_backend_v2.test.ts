import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../db/pg", () => ({ pool: { query: (...args: any[]) => db.query(...args), connect: () => db.connect() }, nowIso: () => "2026-10-23T10:00:00.000Z" }));
vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.userId = "user"; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
import { catalogRouter, syncProductPresentations } from "../routes/catalog";
import { syncRouter, invalidatePullCache } from "../routes/sync";
import { ordersRouter } from "../routes/orders";
import { settingsRouter } from "../routes/settings";
import { isLegitimateOfflineOrder } from "../services/workday-policy";
import { loadOrderCatalog, insertOrderItems } from "../services/order-storage";
let migrations: Array<{ id: string; run: (client: any) => Promise<void> }>;
beforeAll(async () => { migrations = (await vi.importActual<any>("../../scripts/migrate")).migrations; });

function request(router: express.Router, method: string, url: string, body: any = {}) {
  const app = express();
  app.use(router);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = { method, url, body, headers: {}, socket: {}, connection: {} } as any;
    const res = {
      statusCode: 200, setHeader: vi.fn(), getHeader: vi.fn(),
      status(value: number) { this.statusCode = value; return this; },
      json(value: any) { resolve({ status: this.statusCode, body: value }); },
      end() { resolve({ status: this.statusCode, body: null }); },
    } as any;
    app(req, res, (error: unknown) => error ? reject(error) : resolve({ status: res.statusCode, body: null }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockResolvedValue({ rows: [] });
  invalidatePullCache("all");
});

describe("Identidad estable del catálogo", () => {
  function presentationDatabase(initial: Array<{ id: string; name: string; active?: boolean }>) {
    const rows = initial.map((row) => ({ ...row, active: row.active !== false }));
    db.query.mockImplementation(async (sql: string, values: any[] = []) => {
      if (sql.startsWith("SELECT id, name FROM product_presentations")) return { rows: rows.map((row) => ({ ...row })) };
      if (sql.startsWith("UPDATE product_presentations SET name")) {
        if (rows.some((row) => row.id !== values[0] && row.name === values[1])) throw new Error("duplicate name");
        rows.find((row) => row.id === values[0])!.name = values[1];
      }
      if (sql.startsWith("UPDATE product_presentations SET sort_order")) {
        if (rows.some((row) => row.id !== values[0] && row.name === values[6])) throw new Error("duplicate name");
        Object.assign(rows.find((row) => row.id === values[0])!, { name: values[6], active: true });
      }
      if (sql.startsWith("UPDATE product_presentations SET active")) rows.find((row) => row.id === values[0])!.active = false;
      if (sql.includes("INSERT INTO product_presentations")) rows.push({ id: values[0], name: values[2], active: true });
      return { rows: [] };
    });
    return rows;
  }
  const presentation = (name: string, id?: string, localId?: string) => ({ name, id, localId, unitEquivalence: 1, priceCents: 201, costCents: 100 });

  it("renombra conservando el UUID referenciado por otros combos", async () => {
    const rows = presentationDatabase([{ id: "pres-original", name: "Unidad" }]);
    await syncProductPresentations({ query: db.query } as any, "product", [presentation("Bolsa", "pres-original")], "now");
    expect(rows).toEqual([{ id: "pres-original", name: "Bolsa", active: true }]);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO product_presentations"))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE product_presentations SET active"))).toBe(false);
  });

  it("intercambia nombres sin colisiones de UNIQUE y conserva la compatibilidad por nombre", async () => {
    const rows = presentationDatabase([{ id: "a", name: "Unidad" }, { id: "b", name: "Caja" }]);
    await syncProductPresentations({ query: db.query } as any, "product", [presentation("Caja", "a"), presentation("Unidad", "b")], "now");
    await syncProductPresentations({ query: db.query } as any, "product", [presentation("Caja"), presentation("Unidad")], "now");
    expect(rows).toEqual([{ id: "a", name: "Caja", active: true }, { id: "b", name: "Unidad", active: true }]);
  });

  it("recupera un alta renombrada tras perder ACK usando localId", async () => {
    const rows = presentationDatabase([]);
    await syncProductPresentations({ query: db.query } as any, "product", [presentation("Unidad", undefined, "local-presentation")], "now");
    await syncProductPresentations({ query: db.query } as any, "product", [presentation("Bolsa", undefined, "local-presentation")], "later");
    expect(rows).toEqual([{ id: "local-presentation", name: "Bolsa", active: true }]);
  });

  it("rechaza IDs ajenos sin desactivar las presentaciones válidas", async () => {
    const rows = presentationDatabase([{ id: "owned", name: "Unidad" }]);
    await expect(syncProductPresentations({ query: db.query } as any, "product", [presentation("Otra", "foreign")], "now")).rejects.toThrow("no pertenece");
    expect(rows[0].active).toBe(true);
  });

  it("deduplica una categoría por categoryLocalId aunque cambió de nombre antes del ACK", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    db.query.mockImplementation(async (sql: string, values: any[]) => ({ rows: sql.startsWith("SELECT id, name, active FROM categories") ? [{ id: values[0], name: "Nombre original", active: true }] : [] }));
    const result = await request(catalogRouter, "POST", "/categories", { categoryLocalId: id, name: "Nombre actualizado" });
    expect(result).toMatchObject({ status: 200, body: { deduped: true, category: { id, name: "Nombre original" } } });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO categories"))).toBe(false);
  });
});

describe("Autocierre del pull dentro de una transacción", () => {
  it("adquiere el lock antes del FOR UPDATE y confirma antes de descargar los datos", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT id FROM work_days WHERE status = 'open'") ? [{ id: "stale" }] : [] }));
    const result = await request(syncRouter, "GET", "/pull?force=1");
    expect(result.status).toBe(200);
    const queries = db.query.mock.calls.map(([sql]) => String(sql));
    const lock = queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const stale = queries.findIndex((sql) => sql.includes("FOR UPDATE"));
    const commit = queries.indexOf("COMMIT");
    expect(queries[0]).toBe("BEGIN");
    expect(lock).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(lock);
    expect(commit).toBeGreaterThan(stale);
    expect(queries.indexOf("SELECT * FROM clients")).toBeGreaterThan(commit);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("hace rollback si falla el autocierre", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) throw new Error("simulated transaction failure");
      return { rows: [] };
    });
    const result = await request(syncRouter, "GET", "/pull?force=1");
    expect(result.status).toBe(500);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("Regla compartida de capturas offline", () => {
  it.each([
    ["2026-10-24T03:30:00.000Z", true], // 23:30 del 23 en Bolivia, aunque UTC diga 24.
    ["2026-10-24T04:16:00.000Z", false],
    ["2026-10-22T15:00:00.000Z", true], // Captura anterior al cierre / fecha explícita offline.
    ["fecha inválida", false],
    [undefined, false],
  ])("evalúa %s de forma consistente (%s)", (createdAt, expected) => {
    expect(isLegitimateOfflineOrder({ work_date: "2026-10-23", closed_at: "2026-10-24T04:00:00.000Z" }, createdAt)).toBe(expected);
  });

  it("no admite una nueva captura posterior al cierre aunque siga siendo el mismo día de Bolivia", () => {
    const day = { work_date: "2026-10-23", closed_at: "2026-10-23T16:00:00.000Z" };
    expect(isLegitimateOfflineOrder(day, "2026-10-23T16:15:00.000Z")).toBe(true);
    expect(isLegitimateOfflineOrder(day, "2026-10-23T16:15:00.001Z")).toBe(false);
    expect(isLegitimateOfflineOrder(day, "2026-10-23T22:00:00.000Z")).toBe(false);
  });

  it.each([null, "fecha inválida"])("sin cierre válido (%s) usa el día de Bolivia como recuperación legacy", (closedAt) => {
    const day = { work_date: "2026-10-23", closed_at: closedAt };
    expect(isLegitimateOfflineOrder(day, "2026-10-24T03:59:59.000Z")).toBe(true);
    expect(isLegitimateOfflineOrder(day, "2026-10-24T04:00:00.000Z")).toBe(false);
    expect(isLegitimateOfflineOrder(day, "2026-10-22T16:00:00.000Z")).toBe(false);
  });
});

describe("Migración aditiva y bases nuevas", () => {
  it("incluye assigned_user_id en base001 y una migración010 idempotente sin borrar tablas", async () => {
    for (const id of ["001_base_schema", "010_clients_assigned_user"]) {
      const migration = migrations.find((m) => m.id === id)!;
      expect(migration).toBeDefined();
      await migration.run({ query: db.query } as any);
    }
    const sql = db.query.mock.calls.map(([query]) => query).join("\n");
    expect(sql).toMatch(/assigned_user_id TEXT REFERENCES users\(id\)/);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS assigned_user_id");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_clients_assigned_user");
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});

describe("Lectura y persistencia de pedidos por lotes", () => {
  it("sincroniza 100 líneas con dos lecturas de catálogo y una inserción de detalle", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ productId: `p${i}`, presentationId: `q${i}`, quantity: 1 }));
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: [{ id: "day", status: "open" }] };
      if (sql.startsWith("SELECT id, active FROM clients")) return { rows: [{ id: "client", active: true }] };
      if (sql.startsWith("SELECT id, name, sku")) return { rows: items.map((item) => ({ id: item.productId, name: item.productId, sku: item.productId, product_type: "standard", active: true })) };
      if (sql.startsWith("SELECT id, product_id")) return { rows: items.map((item) => ({ id: item.presentationId, product_id: item.productId, name: "Unidad", active: true, price_cents: 101, unit_equivalence: 1 })) };
      if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: 1, total: 10100 }] };
      return { rows: [] };
    });
    const result = await request(syncRouter, "POST", "/push", { operations: [{ id: "order", entityType: "order", data: { workDayId: "day", clientId: "client", items } }] });
    expect(result.body.succeeded).toBe(1);
    const queries = db.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.filter((sql) => sql.startsWith("SELECT id, name, sku"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.startsWith("SELECT id, product_id"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.startsWith("INSERT INTO order_items"))).toHaveLength(1);
    expect(queries[queries.length - 1]).toBe("COMMIT");
  });

  it("lee 100 productos estándar con dos consultas, sin N+1", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ productId: `p${i}`, presentationId: `q${i}` }));
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM products") ? items.map((it) => ({ id: it.productId, product_type: "standard" })) : items.map((it) => ({ id: it.presentationId })) }));
    const result = await loadOrderCatalog({ query: db.query } as any, items);
    expect(result.products.size).toBe(100);
    expect(result.presentations.size).toBe(100);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.every(([sql]) => sql.includes("ANY($1::text[])"))).toBe(true);
  });

  it("inserta todas las líneas y selecciones en dos consultas preservando snapshots", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, product_id: `p${i}`, presentation_id: `q${i}`, product_name_snapshot: "Combo", sku_snapshot: "C", presentation_name_snapshot: "Pack", unit_equivalence_snapshot: 1, unit_price_cents_snapshot: 101, quantity: 3, subtotal_cents: 303, selections: [{ id: `s${i}`, selected_product_id: "potato", selected_presentation_id: "bag", product_name_snapshot: "Papa", presentation_name_snapshot: "Bolsa", quantity: 2, sort_order: 0 }] }));
    await insertOrderItems({ query: db.query } as any, "order", items, "timestamp");
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1]).toHaveLength(1200);
    expect(db.query.mock.calls[1][1]).toHaveLength(900);
    expect(db.query.mock.calls[0][1].slice(0, 12)).toEqual(["i0", "order", "p0", "q0", "Combo", "C", "Pack", 1, 101, 3, 303, "timestamp"]);
  });

  it("revierte cabecera y detalles si falla la inserción de una línea", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: [{ id: "day", status: "open" }] };
      if (sql.startsWith("SELECT * FROM clients")) return { rows: [{ id: "client", active: true }] };
      if (sql.startsWith("SELECT id, name, sku")) return { rows: [{ id: "p", name: "Papa", sku: "P", product_type: "standard", active: true }] };
      if (sql.startsWith("SELECT id, product_id")) return { rows: [{ id: "q", product_id: "p", name: "Unidad", active: true, price_cents: 101, unit_equivalence: 1 }] };
      if (sql.startsWith("INSERT INTO order_items")) throw new Error("simulated detail failure");
      return { rows: [] };
    });
    const result = await request(ordersRouter, "POST", "/", { idempotencyKey: "key", workDayId: "day", clientId: "client", items: [{ productId: "p", presentationId: "q", quantity: 2 }] });
    expect(result.status).toBe(500);
    const queries = db.query.mock.calls.map(([sql]) => sql);
    expect(queries.some((sql) => sql.includes("INSERT INTO orders"))).toBe(true);
    expect(queries[queries.length - 1]).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    log.mockRestore();
  });
});

describe("Estadísticas y correlativos seguros", () => {
  it("distingue el número real de preventas del último correlativo", async () => {
    db.query.mockResolvedValue({ rows: [{ total_historical_orders: 2, last_receipt_number: 100 }] });
    expect(await request(settingsRouter, "GET", "/stats")).toEqual({ status: 200, body: { totalHistoricalOrders: 2, lastReceiptNumber: 100 } });
    expect(db.query.mock.calls[0][0]).toContain("COUNT(*)");
  });

  it("rechaza retroceder por debajo de una boleta emitida y no cambia la secuencia", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("MAX(receipt_number)") ? [{ max_receipt_number: 12 }] : [] }));
    const result = await request(settingsRouter, "PUT", "/receipt-counter", { value: 11 });
    expect(result).toMatchObject({ status: 409, body: { minimum: 12 } });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("setval"))).toBe(false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  });

  it("ajusta un correlativo válido bajo el mismo lock que la creación de pedidos", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("MAX(receipt_number)") ? [{ max_receipt_number: 12 }] : [] }));
    expect(await request(settingsRouter, "PUT", "/receipt-counter", { value: 30 })).toEqual({ status: 200, body: { ok: true, value: 30 } });
    const queries = db.query.mock.calls.map(([sql]) => sql);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(queries[queries.length - 1]).toBe("COMMIT");
  });
});

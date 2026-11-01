import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

// Reutiliza el patrón de harness de sync_regressions: pool y auth simulados.
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../db/pg", () => ({
  pool: { query: (...args: any[]) => db.query(...args), connect: () => db.connect() },
  nowIso: () => "2026-10-20T10:00:00.000Z",
}));
vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.userId = "user"; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../routes/workdays", () => ({ closeStaleOpenWorkDays: async () => false, invalidateWorkdayCache: vi.fn(), lockWorkDays: async (client: any) => client.query("SELECT pg_advisory_xact_lock(1003, hashtext('workdays:shared'))") }));
vi.mock("../services/dates", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getBoliviaToday: () => "2026-10-20" }));
import { syncRouter } from "../routes/sync";

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

const DELETED_PRODUCT = { id: "server-product", active: false, updated_at: "2026-10-19T10:00:00.000Z" };
const DELETED_CLIENT = { id: "server-client", active: false, updated_at: "2026-10-19T10:00:00.000Z" };

function deletedRow(entity: "product" | "client") {
  return entity === "product" ? DELETED_PRODUCT : DELETED_CLIENT;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockImplementation(async (sql: string, _values: any[] = []) => {
    if (sql.includes("FROM products WHERE id = $1 OR lower(sku)")) return { rows: [DELETED_PRODUCT] };
    if (sql.includes("FROM clients WHERE id = $1 OR client_local_id")) return { rows: [DELETED_CLIENT] };
    return { rows: [] };
  });
});

describe("Conflicto ENTITY_DELETED en /sync/push", () => {
  it("detiene la edición de un producto eliminado y devuelve un conflicto identificable", async () => {
    const result = await request("POST", "/api/sync/push", {
      operations: [{ id: "local-product", entityType: "product", operation: "update", data: { serverId: "server-product", sku: "SKU", name: "Papa" } }],
    });
    expect(result.status).toBe(200);
    expect(result.body.results[0].status).toBe("failed");
    expect(result.body.results[0].conflict).toBe("ENTITY_DELETED");
    expect(result.body.results[0].retryable).toBe(false);
    expect(result.body.results[0].serverId).toBe("server-product");
    expect(result.body.succeeded).toBe(0);
    // No debe haber actualizado ni reactivado el producto.
    const updates = db.query.mock.calls.map((c: any[]) => c[0]).filter((sql: string) => sql.startsWith("UPDATE products"));
    expect(updates).toHaveLength(0);
  });

  it("restaura explícitamente un producto eliminado cuando la operación es restore", async () => {
    const result = await request("POST", "/api/sync/push", {
      operations: [{ id: "local-product", entityType: "product", operation: "restore", data: { serverId: "server-product", sku: "SKU", name: "Papa", productType: "standard" } }],
    });
    expect(result.body.results[0].status).toBe("synced");
    expect(result.body.results[0].conflict).toBeUndefined();
    const updates = db.query.mock.calls.map((c: any[]) => c[0]).filter((sql: string) => sql.startsWith("UPDATE products"));
    expect(updates.length).toBeGreaterThan(0);
  });

  it("detiene la edición de un cliente eliminado y devuelve conflicto", async () => {
    const result = await request("POST", "/api/sync/push", {
      operations: [{ id: "local-client", entityType: "client", operation: "update", data: { serverId: "server-client", businessName: "Tienda" } }],
    });
    expect(result.body.results[0].conflict).toBe("ENTITY_DELETED");
    expect(result.body.results[0].status).toBe("failed");
  });

  it("una alta de categoría con nombre de categoría eliminada no la reactiva", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM categories WHERE id = $1 OR LOWER")) return { rows: [{ id: "server-cat", active: false, updated_at: "2026-10-19T10:00:00.000Z" }] };
      return { rows: [] };
    });
    const result = await request("POST", "/api/sync/push", {
      operations: [{ id: "local-cat", entityType: "category", operation: "create", data: { name: "Bebidas" } }],
    });
    expect(result.body.results[0].conflict).toBe("ENTITY_DELETED");
    expect(result.body.results[0].status).toBe("failed");
  });
});

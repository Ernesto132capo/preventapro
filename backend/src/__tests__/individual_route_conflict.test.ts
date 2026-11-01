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
vi.mock("../routes/sync", () => ({ invalidatePullCache: vi.fn() }));

import { catalogRouter } from "../routes/catalog";
import { clientsRouter } from "../routes/clients";

function request(router: any, method: string, url: string, body: any = {}): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use(router);
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

const DELETED = { id: "server-x", active: false, updated_at: "2026-10-19T10:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM products WHERE id = $1")) return { rows: [DELETED] };
    if (sql.includes("FROM products WHERE sku = $1")) return { rows: [DELETED] };
    if (sql.includes("FROM clients WHERE id = $1")) return { rows: [DELETED] };
    if (sql.includes("FROM categories WHERE id = $1")) return { rows: [DELETED] };
    if (sql.includes("FROM categories WHERE lower(name)")) return { rows: [DELETED] };
    return { rows: [] };
  });
});

const PRODUCT_BODY = { sku: "SKU-1", name: "Papa", presentations: [{ name: "Unidad", unitEquivalence: 1, priceCents: 100 }] };

describe("Rutas individuales devuelven ENTITY_DELETED sin reactivar", () => {
  it("PUT /catalog/products/:id sobre un producto eliminado", async () => {
    const result = await request(catalogRouter, "PUT", "/products/server-x", PRODUCT_BODY);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("ENTITY_DELETED");
    expect(result.body.entityType).toBe("product");
  });

  it("POST /catalog/products con SKU de un producto eliminado", async () => {
    const result = await request(catalogRouter, "POST", "/products", PRODUCT_BODY);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("ENTITY_DELETED");
  });

  it("PUT /catalog/categories/:id sobre una categoría eliminada", async () => {
    const result = await request(catalogRouter, "PUT", "/categories/server-x", { name: "Bebidas" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("ENTITY_DELETED");
  });

  it("POST /catalog/categories con nombre de una categoría eliminada", async () => {
    const result = await request(catalogRouter, "POST", "/categories", { name: "Bebidas" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("ENTITY_DELETED");
  });

  it("PUT /clients/:id sobre un cliente eliminado", async () => {
    const result = await request(clientsRouter, "PUT", "/server-x", { businessName: "Tienda" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("ENTITY_DELETED");
    expect(result.body.entityType).toBe("client");
  });
});

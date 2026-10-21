import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { inflateSync } from "zlib";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn(),
}));
vi.mock("../db/pg", () => ({
  pool: { query: mocks.query, connect: mocks.connect },
  nowIso: () => "2026-10-20T12:00:00.000Z",
}));
vi.mock("../routes/sync", () => ({ invalidatePullCache: vi.fn() }));
vi.mock("../middleware/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../middleware/auth")>(),
  requireAuth: (req: any, _res: any, next: any) => { req.userId = "user-1"; next(); },
}));

import { ordersRouter } from "../routes/orders";
import { clientsRouter } from "../routes/clients";
import { catalogRouter } from "../routes/catalog";
import { workdaysRouter, invalidateWorkdayCache } from "../routes/workdays";
import { authRouter, loginLimiter } from "../routes/auth";
import { createAccessToken, hashPassword } from "../services/auth";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";
import { isDatabaseUnavailable } from "../services/http-errors";

function appFor(router: express.Router) {
  const app = express();
  app.use(router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Error interno" });
  });
  return app;
}

function request(app: express.Express, method: string, url: string, body: unknown = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Petición sin respuesta: ${method} ${url}`)), 1500);
    const finish = (value: { status: number; body: unknown }) => { clearTimeout(timer); resolve(value); };
    const req = {
      method, url, body, headers: { "content-type": "application/json" }, ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" }, connection: { remoteAddress: "127.0.0.1" },
    } as any;
    const res = {
      statusCode: 200, headersSent: false, setHeader: vi.fn(), getHeader: vi.fn(),
      status(code: number) { this.statusCode = code; return this; },
      json(data: unknown) { finish({ status: this.statusCode, body: data }); return this; },
      end() { finish({ status: this.statusCode, body: null }); },
    } as any;
    app(req, res, (err: unknown) => {
      clearTimeout(timer);
      if (err) reject(err); else finish({ status: res.statusCode, body: null });
    });
  });
}

const orderItems = [{ productId: "product-1", presentationId: "presentation-1", quantity: 1 }];
const productBody = { sku: "P1", name: "Papa", presentations: [{ name: "Unidad", unitEquivalence: 1, priceCents: 1000 }] };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.AUTH_TOKEN_SECRET = "audit-secret-at-least-32-characters-long-12345";
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  invalidateWorkdayCache();
  loginLimiter.resetKey("127.0.0.1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Auditoría: conexiones y cancelación", () => {
  it.each(["40001", "40P01", "55P03", "57014"])("clasifica %s como un fallo temporal reintentable", (code) => {
    expect(isDatabaseUnavailable({ code })).toBe(true);
  });

  it.each(["PUT", "POST"])("mantiene el orden de locks compartido al editar/cancelar (%s)", async (method) => {
    await request(appFor(ordersRouter), method, method === "PUT" ? "/missing" : "/missing/cancel", { items: orderItems });
    const queries = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(queries.findIndex((sql) => sql.startsWith("SELECT * FROM orders")));
  });

  it.each([
    ["crear preventa", ordersRouter, "POST", "/", { idempotencyKey: "key-1", workDayId: "wd-1", clientId: "client-1", items: orderItems }],
    ["editar preventa", ordersRouter, "PUT", "/order-1", { items: orderItems }],
    ["cancelar preventa", ordersRouter, "POST", "/order-1/cancel", {}],
    ["crear cliente", clientsRouter, "POST", "/", { businessName: "Tienda" }],
    ["obtener jornada", workdaysRouter, "GET", "/current?fresh=1", {}],
    ["cerrar jornada", workdaysRouter, "POST", "/wd-1/close", { confirmation: "CONFIRMAR" }],
    ["reabrir jornada", workdaysRouter, "POST", "/wd-1/reopen", {}],
    ["borrar jornada", workdaysRouter, "DELETE", "/wd-1", {}],
    ["crear producto", catalogRouter, "POST", "/products", productBody],
  ])("responde 503 al fallar la conexión: %s", async (_name, router, method, url, body) => {
    mocks.connect.mockRejectedValue(new Error("Pool no disponible"));
    const result = await request(appFor(router as express.Router), method as string, url as string, body);
    expect(result.status).toBe(503);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])("captura un rechazo de la consulta previa del catálogo (%s)", async (method) => {
    mocks.query.mockRejectedValue(Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }));
    const result = await request(appFor(catalogRouter), method, method === "POST" ? "/products" : "/products/product-1", productBody);
    expect(result.status).toBe(503);
  });

  it("no trata un fallo temporal durante la transacción de producto como datos inválidos", async () => {
    mocks.clientQuery.mockRejectedValueOnce(Object.assign(new Error("connection closed"), { code: "08006" }));
    expect((await request(appFor(catalogRouter), "POST", "/products", productBody)).status).toBe(503);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("repetir una cancelación devuelve éxito y no vuelve a modificar totales, incluso tras cerrar la jornada", async () => {
    let status = "active";
    let closed = false;
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM orders")) return { rows: [{ id: "order-1", work_day_id: "wd-1", status }] };
      if (sql.startsWith("SELECT * FROM work_days")) return { rows: [{ id: "wd-1", status: closed ? "closed" : "open" }] };
      if (sql.startsWith("UPDATE orders SET status")) status = "cancelled";
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0, total: 0 }] };
      return { rows: [] };
    });
    const app = appFor(ordersRouter);
    expect(await request(app, "POST", "/order-1/cancel")).toEqual({ status: 200, body: { ok: true } });
    closed = true;
    expect(await request(app, "POST", "/order-1/cancel")).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.clientQuery.mock.calls.filter(([sql]) => sql.startsWith("UPDATE orders SET status"))).toHaveLength(1);
    expect(mocks.clientQuery.mock.calls.filter(([sql]) => sql.startsWith("UPDATE work_days"))).toHaveLength(1);
  });

  it("registra tombstone antes de borrar la jornada en la misma transacción", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM work_days") ? [{ id: "wd-1", status: "closed" }] : [] }));
    expect((await request(appFor(workdaysRouter), "DELETE", "/wd-1")).status).toBe(200);
    const queries = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    const tombstone = queries.findIndex((sql) => sql.includes("INSERT INTO sync_tombstones"));
    expect(tombstone).toBeGreaterThan(queries.indexOf("BEGIN"));
    expect(tombstone).toBeLessThan(queries.indexOf("DELETE FROM work_days WHERE id = $1"));
    expect(queries[queries.length - 1]).toBe("COMMIT");
  });

  it("conserva la jornada haciendo rollback si falta la migración de tombstones", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO sync_tombstones")) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      return { rows: sql.startsWith("SELECT * FROM work_days") ? [{ id: "wd-1", status: "closed" }] : [] };
    });
    expect((await request(appFor(workdaysRouter), "DELETE", "/wd-1")).status).toBe(503);
    const queries = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(queries[queries.length - 1]).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(queries).not.toContain("DELETE FROM work_days WHERE id = $1");
  });
});

describe("Auditoría: sesiones existentes", () => {
  it.each([null, false, undefined])("rechaza sesión ausente o revocada (%s)", async (sessionActive) => {
    const { requireAuth } = await vi.importActual<typeof import("../middleware/auth")>("../middleware/auth");
    mocks.query.mockResolvedValue({ rows: [{ active: true, code: "david", session_active: sessionActive }] });
    const req = { headers: { authorization: `Bearer ${createAccessToken("user-1", "session-1")}` } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("admite sesión existente activa y conserva compatibilidad con tokens sin sid", async () => {
    const { requireAuth } = await vi.importActual<typeof import("../middleware/auth")>("../middleware/auth");
    mocks.query.mockResolvedValue({ rows: [{ active: true, code: "david", session_active: true }] });
    for (const sid of ["session-1", undefined]) {
      const req = { headers: { authorization: `Bearer ${createAccessToken("user-1", sid)}` } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();
      await requireAuth(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(req.userId).toBe("user-1");
    }
  });

  it("login no devuelve token si falla la persistencia de la sesión", async () => {
    const passwordHash = await hashPassword("clave-segura");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO user_sessions")) throw new Error("Sesiones no disponibles");
      return { rows: [{ id: "user-1", active: true, code: "david", password_hash: passwordHash, full_name: "David" }] };
    });
    const result = await request(appFor(authRouter), "POST", "/login", { identifier: "david", password: "clave-segura" });
    expect(result.status).toBe(503);
    expect(result.body.accessToken).toBeUndefined();
    expect(result.body.sessionId).toBeUndefined();
  });
});

function receiptRows(count: number, longNames = false) {
  return Array.from({ length: count }, (_, i) => ({
    order_id: "order-1", order_item_id: `item-${i}`, created_at: "2026-10-20T12:00:00.000Z",
    subtotal_cents_order: count * 1025, tax_cents_order: 0, total_cents: count * 1025, receipt_number: 14,
    business_name: "Tienda de prueba", contact_name: null, address: "Calle de prueba",
    product_name_snapshot: longNames ? `Producto ${i} ${"descripción larga ".repeat(12)}` : `Producto ${i}`,
    presentation_name_snapshot: longNames ? "Presentación de prueba con descripción larga" : "Unidad",
    quantity: 1, unit_price_cents_snapshot: 1025, subtotal_cents: 1025,
  }));
}

/** Descomprime streams del PDF real para verificar texto, no solo contar páginas. */
function pdfStreams(buffer: Buffer) {
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  const pattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const end = raw.indexOf("endstream", match.index + match[0].length);
    if (end < 0) break;
    try { streams.push(inflateSync(buffer.subarray(match.index + match[0].length, end)).toString("latin1")); } catch { /* otros streams sin Flate */ }
    pattern.lastIndex = end + 9;
  }
  return streams.flatMap((stream) => Array.from(stream.matchAll(/\[([^\]]*)\]\s*TJ/g), (match) =>
    Array.from(match[1].matchAll(/<([0-9a-f]+)>/gi), (hex) => Buffer.from(hex[1], "hex").toString("latin1")).join("")
  )).join("\n");
}

describe("Auditoría: paginación real de boletas PDF", () => {
  it.each([40, 50])("imprime %s líneas en dos páginas sin páginas fantasma y conserva el total", async (count) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preventapro-pdf-"));
    try {
      mocks.query.mockResolvedValueOnce({ rows: receiptRows(count) }).mockResolvedValueOnce({ rows: [] });
      const file = await generateClientReceiptsPdf("wd-1", path.join(dir, "nuevo"));
      const pdf = await fs.promises.readFile(file);
      const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) || [];
      expect(pages).toHaveLength(2);
      const streams = pdfStreams(pdf);
      expect(streams).toContain("continuación");
      expect(streams).toContain(`TOTAL: Bs. ${(count * 10.25).toFixed(2)}`);
      for (let i = 0; i < count; i++) expect(streams).toContain(`Producto ${i}\n`);
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  });

  it("ajusta nombres largos y combos sin perder filas ni multiplicar páginas", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preventapro-pdf-"));
    try {
      const rows = receiptRows(15, true);
      const selections = Array.from({ length: 30 }, (_, i) => ({ id: `selection-${i}`, order_item_id: "item-0", product_name_snapshot: `Opción ${i}`, presentation_name_snapshot: "Unidad", quantity: 2, sort_order: i }));
      mocks.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: selections });
      const file = await generateClientReceiptsPdf("wd-1", dir);
      const pdf = await fs.promises.readFile(file);
      const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) || [];
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.length).toBeLessThanOrEqual(5);
      expect(pdfStreams(pdf)).toContain("TOTAL: Bs. 153.75");
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  });
});

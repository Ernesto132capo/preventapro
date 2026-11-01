import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../db/pg", () => ({
  pool: { query: (...args: any[]) => db.query(...args), connect: () => db.connect() },
  nowIso: () => "2026-10-24T16:00:00.000Z",
}));
vi.mock("../routes/workdays", () => ({ invalidateWorkdayCache: vi.fn(), lockWorkDays: vi.fn(), closeStaleOpenWorkDays: vi.fn() }));

import { ordersRouter } from "../routes/orders";
import { createAccessToken } from "../services/auth";

let customer: any;
let products: any[];
let presentations: any[];
let definitions: any[];
let options: any[];
let selections: any[];
let historicalOrder = false;

function request(body: any, authenticated = true, url = "/validate") {
  const app = express();
  app.use(ordersRouter);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = {
      method: "POST", url, body, headers: authenticated ? { authorization: `Bearer ${createAccessToken("user")}` } : {},
      socket: {}, connection: {},
    } as any;
    const res = {
      statusCode: 200, setHeader: vi.fn(), getHeader: vi.fn(),
      status(value: number) { this.statusCode = value; return this; },
      json(value: any) { resolve({ status: this.statusCode, body: value }); },
      end() { resolve({ status: this.statusCode, body: null }); },
    } as any;
    app(req, res, (error: unknown) => error ? reject(error) : resolve({ status: res.statusCode, body: null }));
  });
}

const item = (overrides: any = {}) => ({ productId: "p", presentationId: "pres", quantity: 2, unitPriceCents: 1001, ...overrides });
const draft = (overrides: any = {}) => ({ clientId: "customer", items: [item()], ...overrides });

function combo() {
  products[0].product_type = "combo";
  definitions = [{ id: "combo-def", product_id: "p", selection_min: 1, selection_max: 2, active: true }];
  options = [{ id: "option", combo_id: "combo-def", presentation_id: "option-pres", max_quantity: 1 }];
  selections = [{ id: "option-pres", prod_id: "normal-product", prod_name: "Papa", pres_name: "Unidad" }];
  return item({ selections: [{ selectedProductId: "normal-product", selectedPresentationId: "option-pres", quantity: 1 }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_TOKEN_SECRET = "test-draft-secret-at-least-32-characters-12345";
  customer = { id: "customer", business_name: "Tienda", contact_name: "Rosa", name: "Tienda", active: true, updated_at: "2026-10-24T15:59:00.000Z" };
  products = [{ id: "p", name: "Papa", sku: "P1", product_type: "standard", active: true }];
  presentations = [{ id: "pres", product_id: "p", name: "Unidad", unit_equivalence: 1, price_cents: 1001, active: true }];
  definitions = []; options = []; selections = []; historicalOrder = false;
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE")) return { rows: [{ active: true, code: "david", role: "preventista" }] };
    if (sql.includes("FROM clients")) return { rows: customer ? [customer] : [] };
    if (sql.includes("FROM orders WHERE (id = $1 OR idempotency_key")) return { rows: historicalOrder ? [{ id: "historical-order" }] : [] };
    if (sql.includes("FROM products WHERE")) return { rows: products };
    if (sql.includes("FROM product_presentations WHERE")) return { rows: presentations };
    if (sql.includes("FROM combo_definitions")) return { rows: definitions };
    if (sql.includes("FROM combo_options")) return { rows: options };
    if (sql.includes("FROM product_presentations pp JOIN products")) return { rows: selections };
    return { rows: [] };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Preflight autenticado del carrito antes del guardado", () => {
  it("devuelve el catálogo actual sin crear pedidos, modificar precios ni tocar jornadas", async () => {
    products[0].name = "Papa nueva";
    presentations[0].price_cents = 2000;
    const result = await request(draft());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ valid: true, unchecked: false, checkedAt: "2026-10-24T16:00:00.000Z", client: { id: "customer", active: true } });
    expect(result.body.items).toMatchObject([{ lineIndex: 0, productName: "Papa nueva", priceCents: 2000, unchecked: false }]);
    const queries = db.query.mock.calls.map(([sql]) => String(sql));
    expect(queries).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries).toContain("COMMIT");
    expect(queries.some(sql => /\b(?:INSERT|UPDATE|DELETE|work_days|pg_advisory)\b/i.test(sql))).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it.each([false, true])("rechaza el cliente eliminado aunque allowMissingClient=%s", async (allowMissingClient) => {
    customer.active = false;
    const result = await request(draft({ allowMissingClient }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues).toMatchObject([{ entity: "client", code: "CLIENT_UNAVAILABLE" }]);
    expect(result.body.client.active).toBe(false);
  });

  it.each([false, true])("distingue cliente inexistente de alta local pendiente (%s)", async (allowMissingClient) => {
    customer = null;
    const result = await request(draft({ clientId: "local-customer", allowMissingClient }));
    expect(result.body).toMatchObject({ valid: allowMissingClient, unchecked: allowMissingClient, client: null });
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM clients"))?.[1]).toEqual(["local-customer"]);
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM clients"))?.[0]).toContain("client_local_id = $1");
  });

  it("permite conservar el cliente histórico inactivo al editar su preventa existente", async () => {
    customer.active = false;
    historicalOrder = true;
    const result = await request(draft({ editingOrderId: "original-local-id" }));
    expect(result.body.valid).toBe(true);
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM orders WHERE (id"))?.[1]).toEqual(["original-local-id", "customer"]);
  });

  it("un ID de edición no existente no permite usar el cliente eliminado en una nueva venta", async () => {
    customer.active = false;
    const result = await request(draft({ editingOrderId: "nonexistent-order" }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0].code).toBe("CLIENT_UNAVAILABLE");
  });

  it.each([false, true])("rechaza producto inactivo aun con allowMissingProduct=%s", async (allowMissingProduct) => {
    products[0].active = false;
    const result = await request(draft({ items: [item({ allowMissingProduct })] }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues).toMatchObject([{ entity: "product", lineIndex: 0, code: "PRODUCT_UNAVAILABLE" }]);
  });

  it("conserva todas las posiciones y marca productos/presentaciones locales aún no publicados", async () => {
    const result = await request(draft({ items: [
      item(), item({ productId: "local-new-product", presentationId: "local-new-pres", allowMissingProduct: true, allowMissingPresentation: true }),
    ] }));
    // El lookup por conjuntos no inventa filas faltantes; las posiciones siguen siendo las del carrito.
    expect(result.body.valid).toBe(true);
    expect(result.body.unchecked).toBe(true);
    expect(result.body.items).toHaveLength(2);
    expect(result.body.items[1]).toMatchObject({ lineIndex: 1, productName: null, presentationName: null, unchecked: true });
  });

  it.each([false, true])("señala una presentación eliminada aun con allowMissingPresentation=%s", async (allowMissingPresentation) => {
    presentations[0].active = false;
    const result = await request(draft({ items: [item({ allowMissingPresentation })] }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0]).toMatchObject({ entity: "presentation", code: "PRESENTATION_UNAVAILABLE" });
  });

  it("rechaza presentación de otro producto", async () => {
    presentations[0].product_id = "other-product";
    const result = await request(draft());
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0].code).toBe("PRESENTATION_MISMATCH");
  });

  it("devuelve reglas actuales y detecta cambios incompatibles del combo", async () => {
    const line = combo();
    definitions[0].selection_min = 2;
    const result = await request(draft({ items: [line] }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0].code).toBe("COMBO_CHANGED");
    expect(result.body.items[0].comboDefinition).toEqual({ selectionMin: 2, selectionMax: 2, options: [{ presentationId: "option-pres", maxQuantity: 1 }] });
  });

  it("detecta una opción eliminada de un combo", async () => {
    const line = combo();
    selections = [];
    const result = await request(draft({ items: [line] }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0].code).toBe("SELECTION_UNAVAILABLE");
  });

  it("allowMissing no oculta una opción cuya fila existe pero está desactivada", async () => {
    const line = combo();
    line.selections[0].allowMissing = true;
    selections = [];
    const previousQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, values?: any[]) => {
      if (sql.startsWith("SELECT pp.id FROM product_presentations pp")) return { rows: [{ id: "option-pres" }] };
      return previousQuery(sql, values);
    });
    const result = await request(draft({ items: [line] }));
    expect(result.body.valid).toBe(false);
    expect(result.body.issues[0].code).toBe("SELECTION_UNAVAILABLE");
  });

  it("comprueba pertenencia de producto y acumula selecciones duplicadas antes del máximo", async () => {
    const line = combo();
    line.selections.push({ ...line.selections[0] });
    const overLimit = await request(draft({ items: [line] }));
    expect(overLimit.body.valid).toBe(false);
    expect(overLimit.body.issues[0].code).toBe("COMBO_CHANGED");
    line.selections = [{ ...line.selections[0], selectedProductId: "other-product" }];
    const wrongProduct = await request(draft({ items: [line] }));
    expect(wrongProduct.body.issues[0].code).toBe("SELECTION_MISMATCH");
  });

  it("informa un cambio de combo a producto estándar", async () => {
    const line = combo();
    products[0].product_type = "standard";
    const result = await request(draft({ items: [line] }));
    expect(result.body.issues[0].code).toBe("COMBO_CHANGED");
  });

  it("exige autenticación y no consulta el catálogo sin token", async () => {
    const result = await request(draft(), false);
    expect(result.status).toBe(401);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("limita el tamaño de carrito sin abrir una conexión de preflight", async () => {
    const result = await request(draft({ items: Array.from({ length: 101 }, () => item()) }));
    expect(result.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("fallos de red del servidor hacen rollback y mantienen el resultado como temporal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE")) return { rows: [{ active: true, code: "david" }] };
      if (sql.includes("FROM clients")) throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
      return { rows: [] };
    });
    const result = await request(draft());
    expect(result.status).toBe(503);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("la creación vuelve a rechazar una baja producida después del preflight", async () => {
    const result = await request(draft());
    expect(result.body.valid).toBe(true);
    customer.active = false;
    const previousQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, values?: any[]) => {
      if (sql === "SELECT * FROM work_days WHERE id = $1 FOR UPDATE") return { rows: [{ id: "day", status: "open" }] };
      return previousQuery(sql, values);
    });
    const save = await request({
      idempotencyKey: "local-order", workDayId: "day", clientId: "customer", items: [item()],
    }, true, "/");
    expect(save.status).toBe(400);
    expect(save.body.error).toContain("Cliente");
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO orders"))).toBe(false);
  });
});

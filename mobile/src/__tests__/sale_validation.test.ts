import { LOCAL_SCHEMA } from "../db/schema";
import type { CartLine, Client } from "../domain/types";
import { apiFetch, ApiError } from "../services/api";
import { validateSaleDraft } from "../services/saleValidation";

const DatabaseSync = (process as any).getBuiltinModule?.("node:sqlite")?.DatabaseSync;
const sqliteDescribe = DatabaseSync ? describe : describe.skip;
let mockSqlite: any;
let mockInTx = false;
const mockDb = {
  getFirstAsync: async (sql: string, values: any[] = []) => mockSqlite.prepare(sql).get(...values) || null,
  getAllAsync: async (sql: string, values: any[] = []) => mockSqlite.prepare(sql).all(...values),
};
const mockWithTx = jest.fn(async (operation: any) => {
  mockSqlite.exec("BEGIN IMMEDIATE");
  mockInTx = true;
  try {
    const result = await operation(mockDb);
    mockSqlite.exec("COMMIT");
    return result;
  } catch (error) {
    mockSqlite.exec("ROLLBACK");
    throw error;
  } finally { mockInTx = false; }
});
jest.mock("../db/client", () => ({ withTx: (operation: any) => mockWithTx(operation) }));
jest.mock("../services/api", () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
}));

const ts = "2026-10-24T12:00:00.000Z";
const client = { id: "client", server_id: "remote-client" } as Client;
const line: CartLine = {
  productId: "product", presentationId: "presentation", productName: "Papa", sku: "P1",
  presentationName: "Unidad", unitEquivalence: 1, unitPriceCents: 1001, quantity: 2, subtotalCents: 2002,
};
function resultFor(body: any) {
  return {
    valid: true, checkedAt: ts, unchecked: false, issues: [],
    client: { id: body.clientId, businessName: "Tienda", contactName: null, name: "Tienda", active: true, updatedAt: ts },
    items: body.items.map((item: any, lineIndex: number) => ({
      lineIndex, productId: item.productId, presentationId: item.presentationId,
      productName: "Papa", sku: "P1", presentationName: "Unidad", unitEquivalence: 1,
      priceCents: 2001, productType: "standard", comboDefinition: null, selections: [], unchecked: false,
    })),
  };
}
const requestBody = () => (apiFetch as jest.Mock).mock.calls[0][1].body;
const snapshot = () => Object.fromEntries(["clients", "products", "product_presentations", "orders", "outbox", "work_days"].map((table) => [table, mockSqlite.prepare(`SELECT * FROM ${table}`).all()]));

sqliteDescribe("Comprobación previa de preventa: SQLite real y API controlada", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInTx = false;
    mockSqlite = new DatabaseSync(":memory:");
    mockSqlite.exec(LOCAL_SCHEMA);
    mockSqlite.prepare("INSERT INTO clients(id,server_id,business_name,created_at,updated_at) VALUES ('client','remote-client','Tienda',?,?)").run(ts, ts);
    mockSqlite.exec("INSERT INTO products(id,server_id,sku,name) VALUES ('product','remote-product','P1','Papa'),('component','remote-component','P2','Componente')");
    mockSqlite.exec("INSERT INTO product_presentations(id,server_id,product_id,name,unit_equivalence,price_cents) VALUES ('presentation','remote-presentation','product','Unidad',1,1001),('component-pres','remote-component-pres','component','Unidad',1,500)");
    (apiFetch as jest.Mock).mockImplementation(async (_path, options) => {
      expect(mockInTx).toBe(false);
      return resultFor(options.body);
    });
  });
  afterEach(() => { mockSqlite.close(); });

  it("resuelve IDs locales y conserva el orden completo de las líneas sin mutar datos", async () => {
    const before = snapshot();
    const result = await validateSaleDraft(client, [line, { ...line, quantity: 3, subtotalCents: 3003 }], { online: true });
    expect(result).toMatchObject({ status: "verified", valid: true, items: [{ lineIndex: 0 }, { lineIndex: 1 }] });
    expect(requestBody()).toEqual({ clientId: "remote-client", items: [
      { productId: "remote-product", presentationId: "remote-presentation", quantity: 2, unitPriceCents: 1001 },
      { productId: "remote-product", presentationId: "remote-presentation", quantity: 3, unitPriceCents: 1001 },
    ] });
    expect(snapshot()).toEqual(before);
    expect(apiFetch).toHaveBeenCalledWith("/orders/validate", expect.objectContaining({ method: "POST", timeoutMs: 8000 }));
  });

  it("acepta referencias ya remotas y resuelve también los componentes de combos", async () => {
    const cart = [{ ...line, productId: "remote-product", presentationId: "remote-presentation", isCombo: true,
      selections: [{ selectedProductId: "component", selectedPresentationId: "remote-component-pres", productNameSnapshot: "Componente", presentationNameSnapshot: "Unidad", quantity: 3, sortOrder: 2 }] }];
    await validateSaleDraft({ ...client, id: "remote-client" }, cart, { online: true });
    expect(requestBody().items[0].selections).toEqual([
      { selectedProductId: "remote-component", selectedPresentationId: "remote-component-pres", quantity: 3, sortOrder: 2 },
    ]);
  });

  it("omite HTTP y SQLite cuando se conoce que el teléfono está offline", async () => {
    const result = await validateSaleDraft(client, [line], { online: false });
    expect(result).toMatchObject({ status: "unverified", reason: "offline" });
    expect(mockWithTx).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("las altas locales sin mapping se comprueban por UUID sin confundirlas con borrados remotos", async () => {
    mockSqlite.exec("UPDATE clients SET server_id=NULL,sync_status='pending'; UPDATE products SET server_id=NULL,sync_status='pending'; UPDATE product_presentations SET server_id=NULL");
    await validateSaleDraft(client, [line], { online: true });
    expect(requestBody()).toMatchObject({ clientId: "client", allowMissingClient: true, items: [
      { productId: "product", presentationId: "presentation", allowMissingProduct: true, allowMissingPresentation: true },
    ] });
  });

  it("una edición pendiente de una entidad ya publicada no habilita ignorar un borrado remoto", async () => {
    mockSqlite.exec("UPDATE clients SET sync_status='pending'; UPDATE products SET sync_status='pending'");
    await validateSaleDraft(client, [line], { online: true });
    expect(requestBody().allowMissingClient).toBeUndefined();
    expect(requestBody().items[0].allowMissingProduct).toBeUndefined();
    expect(requestBody().items[0].allowMissingPresentation).toBeUndefined();
  });

  it("una presentación nueva de producto existente permite esperar solo esa dependencia", async () => {
    mockSqlite.exec("UPDATE products SET sync_status='pending' WHERE id='product'; UPDATE product_presentations SET server_id=NULL WHERE id='presentation'");
    await validateSaleDraft(client, [line], { online: true });
    expect(requestBody().items[0]).toMatchObject({ productId: "remote-product", presentationId: "presentation", allowMissingPresentation: true });
    expect(requestBody().items[0].allowMissingProduct).toBeUndefined();
  });

  it("usa el ID directo de filas sincronizadas legacy aunque no tengan server_id", async () => {
    mockSqlite.exec("UPDATE clients SET server_id=NULL; UPDATE products SET server_id=NULL; UPDATE product_presentations SET server_id=NULL");
    await validateSaleDraft(client, [line], { online: true });
    expect(requestBody()).toEqual({ clientId: "client", items: [{ productId: "product", presentationId: "presentation", quantity: 2, unitPriceCents: 1001 }] });
  });

  it("una referencia ausente de SQLite no se declara automáticamente un alta local pendiente", async () => {
    mockSqlite.exec("DELETE FROM clients; DELETE FROM products; DELETE FROM product_presentations");
    await validateSaleDraft(client, [line], { online: true });
    expect(requestBody()).toEqual({ clientId: "remote-client", items: [{ productId: "product", presentationId: "presentation", quantity: 2, unitPriceCents: 1001 }] });
  });

  it("los componentes locales pendientes llevan allowMissing sin alterar sus cantidades", async () => {
    mockSqlite.exec("UPDATE products SET server_id=NULL,sync_status='pending' WHERE id='component'; UPDATE product_presentations SET server_id=NULL WHERE id='component-pres'");
    await validateSaleDraft(client, [{ ...line, isCombo: true, selections: [{ selectedProductId: "component", selectedPresentationId: "component-pres", productNameSnapshot: "Componente", presentationNameSnapshot: "Unidad", quantity: 2, sortOrder: 0 }] }], { online: true });
    expect(requestBody().items[0].selections).toEqual([{ selectedProductId: "component", selectedPresentationId: "component-pres", quantity: 2, sortOrder: 0, allowMissing: true }]);
  });

  it.each(["synced", "pending"])("resuelve el ID del pedido editado cuando ya existe en el servidor (%s)", async (status) => {
    mockSqlite.prepare("INSERT INTO orders(id,server_id,work_day_id,client_id,client_name,subtotal_cents,tax_cents,total_cents,item_count,sync_status,created_at,updated_at) VALUES ('order','remote-order','day','client','Tienda',2002,0,2002,2,?,?,?)").run(status, ts, ts);
    await validateSaleDraft(client, [line], { online: true, editingOrderId: "order" });
    expect(requestBody().editingOrderId).toBe("remote-order");
  });

  it("no envía editingOrderId de un pedido local que aún nunca se publicó", async () => {
    mockSqlite.prepare("INSERT INTO orders(id,work_day_id,client_id,client_name,subtotal_cents,tax_cents,total_cents,item_count,sync_status,created_at,updated_at) VALUES ('order','day','client','Tienda',2002,0,2002,2,'pending',?,?)").run(ts, ts);
    await validateSaleDraft(client, [line], { online: true, editingOrderId: "order" });
    expect(requestBody().editingOrderId).toBeUndefined();
  });

  it("devuelve problemas explícitos del servidor sin guardarlos ni tratarlos como offline", async () => {
    (apiFetch as jest.Mock).mockImplementationOnce(async (_path, options) => ({ ...resultFor(options.body), valid: false,
      issues: [{ entity: "client", code: "CLIENT_INACTIVE", message: "El cliente fue eliminado." }, { entity: "product", lineIndex: 0, code: "PRODUCT_INACTIVE", message: "Papa ya no está disponible." }] }));
    const result = await validateSaleDraft(client, [line], { online: true });
    expect(result).toMatchObject({ status: "verified", valid: false, issues: [{ code: "CLIENT_INACTIVE" }, { lineIndex: 0, code: "PRODUCT_INACTIVE" }] });
    expect(mockSqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n).toBe(0);
  });

  it.each([0, 500, 502, 503, 504, 408, 425, 429, 404])("distingue indisponibilidad temporal del catálogo (HTTP %s)", async (status) => {
    (apiFetch as jest.Mock).mockRejectedValueOnce(new ApiError("No disponible", status));
    await expect(validateSaleDraft(client, [line], { online: true })).resolves.toMatchObject({ status: "unverified", reason: status === 0 ? "network" : status === 404 ? "unsupported" : "server" });
  });

  it.each([400, 401, 403, 409, 422])("no oculta una sesión inválida o validación permanente como offline (HTTP %s)", async (status) => {
    const error = new ApiError("Requiere intervención", status);
    (apiFetch as jest.Mock).mockRejectedValueOnce(error);
    await expect(validateSaleDraft(client, [line], { online: true })).rejects.toBe(error);
  });

  it("una respuesta incompatible no se acepta como catálogo verificado", async () => {
    (apiFetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await expect(validateSaleDraft(client, [line], { online: true })).resolves.toMatchObject({ status: "unverified", reason: "unsupported" });
  });

  it("no disfraza fallos de código o SQLite como errores de red", async () => {
    const error = new Error("Fallo interno del cliente HTTP");
    (apiFetch as jest.Mock).mockRejectedValueOnce(error);
    await expect(validateSaleDraft(client, [line], { online: true })).rejects.toBe(error);
  });

  it("normaliza también las opciones no elegidas del snapshot y no las envía en el payload", async () => {
    mockSqlite.exec("INSERT INTO product_presentations(id,server_id,product_id,name,unit_equivalence,price_cents) VALUES ('not-selected','remote-not-selected','component','Extra',1,900)");
    const comboLine: CartLine = { ...line, isCombo: true, comboCatalogSnapshot: { selectionMin: 1, selectionMax: 3, options: [
      { presentationId: 'component-pres', maxQuantity: 2 },
      { presentationId: 'not-selected', maxQuantity: 1 },
      { presentationId: 'remote-existing', maxQuantity: null },
    ] }, selections: [{ selectedProductId: 'component', selectedPresentationId: 'component-pres', productNameSnapshot: 'Componente', presentationNameSnapshot: 'Unidad', quantity: 1, sortOrder: 0 }] };
    const result = await validateSaleDraft(client, [comboLine], { online: true });
    expect(result).toMatchObject({ status: 'verified', items: [{ knownComboDefinition: { selectionMin: 1, selectionMax: 3, options: [
      { presentationId: 'remote-component-pres', maxQuantity: 2 },
      { presentationId: 'remote-not-selected', maxQuantity: 1 },
      { presentationId: 'remote-existing', maxQuantity: null },
    ] } }] });
    expect(requestBody().items[0].comboCatalogSnapshot).toBeUndefined();
    expect(requestBody().items[0].knownComboDefinition).toBeUndefined();
    expect(requestBody().items[0].selections).toHaveLength(1);
    expect(comboLine.comboCatalogSnapshot!.options[1].presentationId).toBe('not-selected');
  });

  it("asocia baseline por lineIndex aunque la respuesta del servidor cambie el orden", async () => {
    const lines: CartLine[] = [
      { ...line, comboCatalogSnapshot: { selectionMin: 1, selectionMax: 2, options: [{ presentationId: 'component-pres', maxQuantity: 2 }] } },
      { ...line, comboCatalogSnapshot: { selectionMin: 3, selectionMax: 4, options: [{ presentationId: 'presentation', maxQuantity: 4 }] } },
    ];
    (apiFetch as jest.Mock).mockImplementationOnce(async (_path, options) => {
      const response = resultFor(options.body);
      response.items.reverse();
      return response;
    });
    const result = await validateSaleDraft(client, lines, { online: true });
    expect(result).toMatchObject({ status: 'verified', items: [
      { lineIndex: 1, knownComboDefinition: { selectionMin: 3, selectionMax: 4, options: [{ presentationId: 'remote-presentation', maxQuantity: 4 }] } },
      { lineIndex: 0, knownComboDefinition: { selectionMin: 1, selectionMax: 2, options: [{ presentationId: 'remote-component-pres', maxQuantity: 2 }] } },
    ] });
  });
});

import { createCategoryLocal, updateCategoryLocal, deleteCategoryLocal, getCategory } from "../db/repositories/categories";
import { createClientLocal, updateClientLocal, deleteClientLocal, getClient } from "../db/repositories/clients";
import {
  createProductLocal,
  updateProductLocal,
  deleteProductLocal,
  getProduct,
  remapProductReferences,
  remapCategoryReferences,
} from "../db/repositories/products";
import { normalizeOutboxErrors } from "../db/outbox";
import { formatClientDisplayName } from "../domain/client-display";
import { getConsolidatedProductsForWorkDay } from "../db/repositories/orders";
import { migrateClientsTableIfNeeded } from "../db/client-migration";

interface MockCategory {
  id: string;
  server_id: string | null;
  name: string;
  active: number;
  sync_status: string;
  updated_at: string;
}

interface MockClient {
  id: string;
  server_id: string | null;
  business_name: string | null;
  name?: string | null;
  contact_name: string | null;
  owner_name?: string | null;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  visit_status: string;
  active: number;
  sync_status: string;
  created_at: string;
  updated_at: string;
}

interface MockProduct {
  id: string;
  server_id: string | null;
  sku: string;
  name: string;
  category_id: string | null;
  base_cost_cents: number;
  base_unit_name: string;
  product_type: string;
  active: number;
  sync_status: string;
}

interface MockPresentation {
  id: string;
  server_id: string | null;
  product_id: string;
  name: string;
  sort_order: number;
  unit_equivalence: number;
  price_cents: number;
  cost_cents: number;
  active: number;
}

interface MockOutbox {
  id: string;
  entity_type: string;
  local_entity_id: string;
  operation: string;
  priority: number;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

const state = {
  categories: [] as MockCategory[],
  clients: [] as MockClient[],
  products: [] as MockProduct[],
  presentations: [] as MockPresentation[],
  outbox: [] as MockOutbox[],
  favorites: [] as string[],
};

function resetState() {
  state.categories = [];
  state.clients = [];
  state.products = [];
  state.presentations = [];
  state.outbox = [];
  state.favorites = [];
}

const mockDb = {
  runAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    // OUTBOX: INSERT
    if (cleanSql.startsWith("INSERT INTO outbox")) {
      const [id, entity_type, local_entity_id, operation, priority, created_at] = params;
      state.outbox.push({
        id,
        entity_type,
        local_entity_id,
        operation,
        priority,
        status: "pending",
        attempts: 0,
        last_error: null,
        created_at,
      });
      return { changes: 1 };
    }

    // CATEGORIES: INSERT
    if (cleanSql.startsWith("INSERT INTO categories")) {
      const [id, name, updated_at] = params;
      state.categories.push({
        id,
        server_id: null,
        name,
        active: 1,
        sync_status: "pending",
        updated_at,
      });
      return { changes: 1 };
    }

    // CATEGORIES: UPDATE active / name
    if (cleanSql.startsWith("UPDATE categories SET active = 1")) {
      const [ts, id] = params;
      const cat = state.categories.find((c) => c.id === id);
      if (cat) {
        cat.active = 1;
        cat.sync_status = "pending";
        cat.updated_at = ts;
      }
      return { changes: 1 };
    }
    if (cleanSql.startsWith("UPDATE categories SET name = ?")) {
      const [name, ts, id] = params;
      const cat = state.categories.find((c) => c.id === id);
      if (cat) {
        cat.name = name;
        cat.sync_status = "pending";
        cat.updated_at = ts;
      }
      return { changes: 1 };
    }
    if (cleanSql.startsWith("UPDATE categories SET active = 0")) {
      const [ts, id] = params;
      const cat = state.categories.find((c) => c.id === id);
      if (cat) {
        cat.active = 0;
        cat.sync_status = "pending";
        cat.updated_at = ts;
      }
      return { changes: 1 };
    }

    // OUTBOX: UPDATE status = 'failed' WHERE status = 'error'
    if (cleanSql.includes("UPDATE outbox SET status = 'failed' WHERE status = 'error'")) {
      let count = 0;
      for (const row of state.outbox) {
        if (row.status === "error") {
          row.status = "failed";
          count++;
        }
      }
      return { changes: count };
    }

    // OUTBOX: UPDATE status = 'done'
    if (cleanSql.includes("UPDATE outbox SET status = 'done'")) {
      const [entityType, localId] = params;
      let count = 0;
      for (const row of state.outbox) {
        if ((!entityType || row.entity_type === entityType) && (!localId || row.local_entity_id === localId)) {
          row.status = "done";
          row.last_error = null;
          count++;
        }
      }
      return { changes: count };
    }

    // PRODUCTS: UPDATE category_id
    if (cleanSql.startsWith("UPDATE products SET category_id = ? WHERE category_id = ?")) {
      const [newCatId, oldCatId] = params;
      let count = 0;
      for (const p of state.products) {
        if (p.category_id === oldCatId) {
          p.category_id = newCatId;
          count++;
        }
      }
      return { changes: count };
    }

    // PRESENTATIONS: UPDATE product_id (remapProductReferences)
    if (cleanSql.startsWith("UPDATE product_presentations SET product_id = ? WHERE product_id = ?")) {
      const [newId, oldId] = params;
      let count = 0;
      for (const pres of state.presentations) {
        if (pres.product_id === oldId) {
          pres.product_id = newId;
          count++;
        }
      }
      return { changes: count };
    }

    // PRODUCTS: UPDATE category_id = NULL
    if (cleanSql.includes("UPDATE products SET category_id = NULL")) {
      if (params.length === 2) {
        const [id1, id2] = params;
        for (const p of state.products) {
          if (p.category_id === id1 || p.category_id === id2) {
            p.category_id = null;
          }
        }
      } else {
        const [id1] = params;
        for (const p of state.products) {
          if (p.category_id === id1) {
            p.category_id = null;
          }
        }
      }
      return { changes: 1 };
    }

    // CLIENTS: INSERT
    if (cleanSql.startsWith("INSERT INTO clients")) {
      let id: string, business_name: string | null, name: string | null, contact_name: string | null, owner_name: string | null;
      let phone: string | null, address: string | null, lat: number | null, lng: number | null, created_at: string, updated_at: string;
      if (params.length === 11) {
        [id, business_name, name, contact_name, owner_name, phone, address, lat, lng, created_at, updated_at] = params;
      } else {
        [id, business_name, contact_name, phone, address, lat, lng, created_at, updated_at] = params;
        name = business_name;
        owner_name = contact_name;
      }
      state.clients.push({
        id,
        server_id: null,
        business_name,
        name,
        contact_name,
        owner_name,
        phone,
        address,
        lat,
        lng,
        visit_status: "pending",
        active: 1,
        sync_status: "pending",
        created_at,
        updated_at,
      });
      return { changes: 1 };
    }

    // CLIENTS: UPDATE
    if (cleanSql.startsWith("UPDATE clients SET business_name = ?") || (cleanSql.startsWith("UPDATE clients SET") && cleanSql.includes("contact_name = ?"))) {
      let business_name: string | null, name: string | null, contact_name: string | null, owner_name: string | null;
      let phone: string | null, address: string | null, lat: number | null, lng: number | null, updated_at: string, id: string;
      if (params.length === 10) {
        [business_name, name, contact_name, owner_name, phone, address, lat, lng, updated_at, id] = params;
      } else {
        [business_name, contact_name, phone, address, lat, lng, updated_at, id] = params;
        name = business_name;
        owner_name = contact_name;
      }
      const c = state.clients.find((cl) => cl.id === id);
      if (c) {
        c.business_name = business_name;
        c.name = name;
        c.contact_name = contact_name;
        c.owner_name = owner_name;
        c.phone = phone;
        c.address = address;
        c.lat = lat;
        c.lng = lng;
        c.sync_status = "pending";
        c.updated_at = updated_at;
      }
      return { changes: 1 };
    }

    // CLIENTS: DELETE (soft)
    if (cleanSql.startsWith("UPDATE clients SET active = 0")) {
      const [ts, id] = params;
      const c = state.clients.find((cl) => cl.id === id);
      if (c) {
        c.active = 0;
        c.sync_status = "pending";
        c.updated_at = ts;
      }
      return { changes: 1 };
    }

    // PRODUCTS: INSERT
    if (cleanSql.startsWith("INSERT INTO products")) {
      const [id, sku, name, category_id, base_cost_cents, product_type] = params;
      state.products.push({
        id,
        server_id: null,
        sku,
        name,
        category_id,
        base_cost_cents,
        base_unit_name: "Unidad",
        product_type,
        active: 1,
        sync_status: "pending",
      });
      return { changes: 1 };
    }

    // PRODUCT PRESENTATIONS: INSERT
    if (cleanSql.startsWith("INSERT INTO product_presentations")) {
      const [id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents] = params;
      state.presentations.push({
        id,
        server_id: null,
        product_id,
        name,
        sort_order,
        unit_equivalence,
        price_cents,
        cost_cents,
        active: 1,
      });
      return { changes: 1 };
    }

    // PRODUCTS: UPDATE
    if (cleanSql.startsWith("UPDATE products SET name = ?")) {
      const [name, category_id, product_type, id] = params;
      const prod = state.products.find((p) => p.id === id);
      if (prod) {
        prod.name = name;
        prod.category_id = category_id;
        prod.product_type = product_type;
        prod.sync_status = "pending";
      }
      return { changes: 1 };
    }

    // PRODUCTS: DELETE (soft)
    if (cleanSql.startsWith("UPDATE products SET active = 0")) {
      const [id] = params;
      const prod = state.products.find((p) => p.id === id || p.server_id === id);
      if (prod) {
        prod.active = 0;
        prod.sync_status = "pending";
      }
      return { changes: 1 };
    }

    return { changes: 0 };
  }),

  getFirstAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.includes("SELECT * FROM categories WHERE lower(name) = lower(?)")) {
      const [name] = params;
      const cat = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      return cat ? { ...cat } : null;
    }

    if (cleanSql.includes("SELECT * FROM categories WHERE id = ? OR server_id = ?")) {
      const [id] = params;
      const cat = state.categories.find((c) => c.id === id || c.server_id === id);
      return cat ? { ...cat } : null;
    }

    if (cleanSql.includes("SELECT id, server_id FROM categories WHERE id = ? OR server_id = ?")) {
      const [id] = params;
      const cat = state.categories.find((c) => c.id === id || c.server_id === id);
      return cat ? { id: cat.id, server_id: cat.server_id } : null;
    }

    if (cleanSql.includes("SELECT * FROM clients WHERE id = ?")) {
      const [id] = params;
      const c = state.clients.find((cl) => cl.id === id);
      return c ? { ...c } : null;
    }

    if (cleanSql.includes("FROM work_days WHERE id = ?")) {
      return { id: params[0], server_id: "srv-wd-1", user_id: "usr-1" };
    }

    if (cleanSql.includes("SELECT * FROM products WHERE id = ? OR server_id = ?")) {
      const [id] = params;
      const p = state.products.find((pr) => pr.id === id || pr.server_id === id);
      return p ? { ...p } : null;
    }

    if (cleanSql.includes("SELECT id, server_id FROM products WHERE id = ? OR server_id = ?")) {
      const [id] = params;
      const p = state.products.find((pr) => pr.id === id || pr.server_id === id);
      return p ? { id: p.id, server_id: p.server_id } : null;
    }

    if (cleanSql.includes("SELECT id FROM products WHERE id = ? OR server_id = ?")) {
      const [id] = params;
      const p = state.products.find((pr) => pr.id === id || pr.server_id === id);
      return p ? { id: p.id } : null;
    }

    return null;
  }),

  getAllAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.includes("SELECT * FROM categories WHERE active = 1")) {
      return state.categories.filter((c) => c.active === 1);
    }

    if (cleanSql.includes("SELECT product_id FROM product_favorites")) {
      return state.favorites.map((fid) => ({ product_id: fid }));
    }

    if (cleanSql.includes("SELECT id, server_id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active FROM product_presentations")) {
      return state.presentations.filter((pr) => pr.active === 1 && params.includes(pr.product_id));
    }

    if (cleanSql.includes("SELECT id FROM product_presentations WHERE")) {
      return state.presentations.filter((pr) => pr.active === 1 && params.includes(pr.product_id)).map((pr) => ({ id: pr.id }));
    }

    if (cleanSql.includes("JOIN order_items oi")) {
      return [
        {
          id: "item-papas",
          product_name_snapshot: "Papas en tira",
          presentation_name_snapshot: "Bolsa 500g",
          unit_price_cents_snapshot: 2800,
          quantity: 10,
          subtotal_cents: 28000,
        },
        {
          id: "item-bombon",
          product_name_snapshot: "Bombón",
          presentation_name_snapshot: "Caja x24",
          unit_price_cents_snapshot: 6000,
          quantity: 10,
          subtotal_cents: 60000,
        },
      ];
    }

    return [];
  }),

  execAsync: jest.fn(async (_sql: string) => {}),
};

const mockWithTx = jest.fn(async (cb: (db: any) => Promise<any>) => cb(mockDb));

jest.mock("../db/client", () => ({
  getDb: jest.fn(async () => mockDb),
  nowIso: jest.fn(() => "2026-10-16T12:00:00.000Z"),
  withTx: (cb: any) => mockWithTx(cb),
}));

describe("Repositories & Outbox Atomicity", () => {
  beforeEach(() => {
    resetState();
    jest.clearAllMocks();
  });

  describe("Categories Repository", () => {
    it("crea categoría y encola en outbox de manera atómica con transacción", async () => {
      const cat = await createCategoryLocal("Bebidas");
      expect(mockWithTx).toHaveBeenCalled();
      expect(cat.name).toBe("Bebidas");
      expect(cat.active).toBe(1);

      const outboxRow = state.outbox.find((o) => o.local_entity_id === cat.id);
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.entity_type).toBe("category");
      expect(outboxRow?.operation).toBe("create");
    });

    it("actualiza categoría y encola 'update' dentro de la transacción", async () => {
      const created = await createCategoryLocal("Lácteos");
      jest.clearAllMocks();

      const updated = await updateCategoryLocal(created.id, "Lácteos y Derivados");
      expect(mockWithTx).toHaveBeenCalled();
      expect(updated.name).toBe("Lácteos y Derivados");

      const outboxRow = state.outbox.find((o) => o.local_entity_id === created.id && o.operation === "update");
      expect(outboxRow).toBeDefined();
    });

    it("elimina categoría y desasocia productos vinculados estableciendo category_id = NULL", async () => {
      const cat = await createCategoryLocal("Snacks");
      state.categories[0].server_id = "srv-snacks";

      // Crear productos asociados a la categoría (tanto por id local como por server_id)
      state.products.push({
        id: "prod-1",
        server_id: "srv-prod-1",
        sku: "SNK-01",
        name: "Papas Fritas",
        category_id: cat.id,
        base_cost_cents: 100,
        base_unit_name: "Unidad",
        product_type: "standard",
        active: 1,
        sync_status: "synced",
      });
      state.products.push({
        id: "prod-2",
        server_id: "srv-prod-2",
        sku: "SNK-02",
        name: "Nachos",
        category_id: "srv-snacks",
        base_cost_cents: 120,
        base_unit_name: "Unidad",
        product_type: "standard",
        active: 1,
        sync_status: "synced",
      });

      jest.clearAllMocks();
      await deleteCategoryLocal(cat.id);

      expect(mockWithTx).toHaveBeenCalled();

      // La categoría queda inactiva
      const deletedCat = state.categories.find((c) => c.id === cat.id);
      expect(deletedCat?.active).toBe(0);

      // Los productos asociados tienen su category_id en null para no romper consultas
      const prod1 = state.products.find((p) => p.id === "prod-1");
      const prod2 = state.products.find((p) => p.id === "prod-2");
      expect(prod1?.category_id).toBeNull();
      expect(prod2?.category_id).toBeNull();

      // Operación encolada en Outbox
      const outboxRow = state.outbox.find((o) => o.local_entity_id === cat.id && o.operation === "delete");
      expect(outboxRow).toBeDefined();
    });
  });

  describe("Clients Repository", () => {
    it("crea cliente y encola en outbox dentro de la transacción", async () => {
      const client = await createClientLocal({
        businessName: "Abarrotes Don Pepe",
        contactName: "Pepe Pérez",
        phone: "70012345",
      });

      expect(mockWithTx).toHaveBeenCalled();
      expect(client.business_name).toBe("Abarrotes Don Pepe");

      const outboxRow = state.outbox.find((o) => o.local_entity_id === client.id);
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.entity_type).toBe("client");
      expect(outboxRow?.operation).toBe("create");
    });

    it("edita cliente y encola evento en outbox atómicamente", async () => {
      const client = await createClientLocal({ businessName: "Tienda Original" });
      jest.clearAllMocks();

      const updated = await updateClientLocal(client.id, {
        businessName: "Tienda Renombrada",
        phone: "77788899",
      });

      expect(mockWithTx).toHaveBeenCalled();
      expect(updated.business_name).toBe("Tienda Renombrada");

      const outboxRow = state.outbox.find((o) => o.local_entity_id === client.id && o.operation === "update");
      expect(outboxRow).toBeDefined();
    });

    it("soft-delete de cliente y outbox delete atómico cuando tiene server_id", async () => {
      const client = await createClientLocal({ businessName: "Cliente A Borrar" });
      const dbClient = state.clients.find((c) => c.id === client.id)!;
      dbClient.server_id = "srv-cl-to-delete";
      jest.clearAllMocks();

      await deleteClientLocal(client.id);

      expect(mockWithTx).toHaveBeenCalled();
      const local = state.clients.find((c) => c.id === client.id);
      expect(local?.active).toBe(0);

      const outboxRow = state.outbox.find((o) => o.local_entity_id === client.id && o.operation === "delete");
      expect(outboxRow).toBeDefined();

      const createRow = state.outbox.find((o) => o.local_entity_id === client.id && o.operation === "create");
      expect(createRow?.status).toBe("done");
    });

    it("soft-delete de cliente puramente local purga outbox y NO encola delete remoto", async () => {
      const client = await createClientLocal({ businessName: "Cliente Solo Local" });
      jest.clearAllMocks();

      await deleteClientLocal(client.id);

      expect(mockWithTx).toHaveBeenCalled();
      const local = state.clients.find((c) => c.id === client.id);
      expect(local?.active).toBe(0);

      const deleteRow = state.outbox.find((o) => o.local_entity_id === client.id && o.operation === "delete");
      expect(deleteRow).toBeUndefined();

      const createRow = state.outbox.find((o) => o.local_entity_id === client.id && o.operation === "create");
      expect(createRow?.status).toBe("done");
    });

    it("[Objetivo 2] permite crear cliente solo con tienda o solo con propietario, pero rechaza si ambos están vacíos", async () => {
      // Solo con propietario (contactName)
      const clientOwnerOnly = await createClientLocal({ contactName: "Don Pedro" });
      expect(clientOwnerOnly.contact_name).toBe("Don Pedro");
      expect(clientOwnerOnly.owner_name).toBe("Don Pedro");
      expect(clientOwnerOnly.business_name || "").toBe("");

      // Solo con propietario usando alias ownerName
      const clientOwnerAlias = await createClientLocal({ ownerName: "Doña Julia" });
      expect(clientOwnerAlias.contact_name).toBe("Doña Julia");
      expect(clientOwnerAlias.owner_name).toBe("Doña Julia");
      expect(clientOwnerAlias.business_name || "").toBe("");

      // Solo con tienda
      const clientStoreOnly = await createClientLocal({ businessName: "Almacén Central" });
      expect(clientStoreOnly.business_name).toBe("Almacén Central");
      expect(clientStoreOnly.contact_name).toBeNull();

      // Ambos vacíos -> debe lanzar error
      await expect(createClientLocal({})).rejects.toThrow(
        "Debes ingresar al menos el nombre del negocio o el nombre del propietario."
      );
      await expect(createClientLocal({ businessName: "   ", contactName: "  " })).rejects.toThrow(
        "Debes ingresar al menos el nombre del negocio o el nombre del propietario."
      );
    });

    it("migra tabla clients legacy con business_name NOT NULL a tabla con columnas nullable y owner_name", async () => {
      const executedSql: string[] = [];
      const fakeDb: any = {
        getAllAsync: jest.fn(async (query: string) => {
          if (query.includes("PRAGMA table_info(clients)")) {
            return [
              { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
              { cid: 1, name: "server_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
              { cid: 2, name: "business_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 }, // legacy NOT NULL
              { cid: 3, name: "contact_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
            ];
          }
          return [];
        }),
        execAsync: jest.fn(async (sql: string) => {
          executedSql.push(sql);
        }),
      };

      await migrateClientsTableIfNeeded(fakeDb);

      expect(executedSql.some((s) => s.includes("PRAGMA foreign_keys = OFF;"))).toBe(true);
      expect(executedSql.some((s) => s.includes("CREATE TABLE clients_new"))).toBe(true);
      expect(executedSql.some((s) => s.includes("INSERT INTO clients_new"))).toBe(true);
      expect(executedSql.some((s) => s.includes("DROP TABLE clients;"))).toBe(true);
      expect(executedSql.some((s) => s.includes("ALTER TABLE clients_new RENAME TO clients;"))).toBe(true);
      expect(executedSql.some((s) => s.includes("PRAGMA foreign_keys = ON;"))).toBe(true);
      expect(executedSql.some((s) => s.includes("UPDATE clients SET"))).toBe(true);
    });

    it("no recrea la tabla si clients ya tiene las columnas necesarias y business_name es nullable", async () => {
      const executedSql: string[] = [];
      const fakeDb: any = {
        getAllAsync: jest.fn(async (query: string) => {
          if (query.includes("PRAGMA table_info(clients)")) {
            return [
              { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
              { cid: 1, name: "server_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
              { cid: 2, name: "business_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
              { cid: 3, name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
              { cid: 4, name: "contact_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
              { cid: 5, name: "owner_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
            ];
          }
          return [];
        }),
        execAsync: jest.fn(async (sql: string) => {
          executedSql.push(sql);
        }),
      };

      await migrateClientsTableIfNeeded(fakeDb);

      expect(executedSql.some((s) => s.includes("DROP TABLE clients;"))).toBe(false);
      expect(executedSql.some((s) => s.includes("UPDATE clients SET"))).toBe(true);
    });

    it("[Objetivo 2] formatClientDisplayName formatea según Casos A, B y C de PreventaPro", () => {
      // Caso A: Ambos
      const a = formatClientDisplayName({ business_name: "Tienda Rosita", contact_name: "Rosa Flores" });
      expect(a.primary).toBe("Tienda Rosita");
      expect(a.secondary).toBe("Rosa Flores");
      expect(a.fullTitle).toBe("Tienda Rosita\nRosa Flores");

      // Caso B: Solo Propietario
      const b = formatClientDisplayName({ business_name: "", contact_name: "Rosa Flores" });
      expect(b.primary).toBe("Rosa Flores");
      expect(b.secondary).toBeNull();
      expect(b.fullTitle).toBe("Rosa Flores");

      // Caso B con owner_name / ownerName
      const b2 = formatClientDisplayName({ owner_name: "Rosa Flores" });
      expect(b2.primary).toBe("Rosa Flores");
      expect(b2.secondary).toBeNull();
      expect(b2.fullTitle).toBe("Rosa Flores");

      // Caso C: Solo Tienda
      const c = formatClientDisplayName({ business_name: "Tienda Rosita", contact_name: "" });
      expect(c.primary).toBe("Tienda Rosita");
      expect(c.secondary).toBeNull();
      expect(c.fullTitle).toBe("Tienda Rosita");

      // Caso C con name
      const c2 = formatClientDisplayName({ name: "Tienda Rosita" });
      expect(c2.primary).toBe("Tienda Rosita");
      expect(c2.secondary).toBeNull();
      expect(c2.fullTitle).toBe("Tienda Rosita");

      // Fallback
      const fallback = formatClientDisplayName(null);
      expect(fallback.primary).toBe("Cliente");
      expect(fallback.secondary).toBeNull();
    });

    it("[Objetivo 1] getConsolidatedProductsForWorkDay consolida productos en 4 columnas y calcula totales generales", async () => {
      const result = await getConsolidatedProductsForWorkDay("wd-local-1");
      expect(result.items).toHaveLength(2);

      // Producto 1
      expect(result.items[0].productName).toBe("Papas en tira (Bolsa 500g)");
      expect(result.items[0].unitPriceCents).toBe(2800);
      expect(result.items[0].totalSubtotalCents).toBe(28000);
      expect(result.items[0].totalUnits).toBe(10);

      // Producto 2
      expect(result.items[1].productName).toBe("Bombón (Caja x24)");
      expect(result.items[1].unitPriceCents).toBe(6000);
      expect(result.items[1].totalSubtotalCents).toBe(60000);
      expect(result.items[1].totalUnits).toBe(10);

      // Totales generales
      expect(result.grandTotalCents).toBe(88000);
      expect(result.grandTotalUnits).toBe(20);
    });
  });

  describe("Products Repository", () => {
    it("crea producto estándar y encola en outbox dentro de la misma transacción", async () => {
      const product = await createProductLocal({
        name: "Aceite 1L",
        presentations: [{ name: "Unidad", unitEquivalence: 1, priceCents: 1500, costCents: 1200 }],
      });

      expect(mockWithTx).toHaveBeenCalled();
      expect(product.name).toBe("Aceite 1L");

      const outboxRow = state.outbox.find((o) => o.local_entity_id === product.id);
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.entity_type).toBe("product");
      expect(outboxRow?.operation).toBe("create");
    });

    it("elimina producto y encola evento delete dentro de la transacción", async () => {
      const product = await createProductLocal({
        name: "Producto A Borrar",
        presentations: [{ name: "Unidad", unitEquivalence: 1, priceCents: 1000, costCents: 800 }],
      });
      jest.clearAllMocks();

      await deleteProductLocal(product.id);

      expect(mockWithTx).toHaveBeenCalled();
      const local = state.products.find((p) => p.id === product.id);
      expect(local?.active).toBe(0);

      const outboxRow = state.outbox.find((o) => o.local_entity_id === product.id && o.operation === "delete");
      expect(outboxRow).toBeDefined();
    });

    it("crea producto combo reconociendo combo_items y opciones alternativas", async () => {
      const combo = await createProductLocal({
        name: "Super Pack Escolar",
        productType: "combo",
        presentations: [{ name: "Pack", unitEquivalence: 1, priceCents: 5000, costCents: 3500 }],
        combo_items: [
          { presentationId: "pres-1", maxQuantity: 2, sortOrder: 0 },
          { presentationId: "pres-2", maxQuantity: 1, sortOrder: 1 },
        ],
        selection_min: 1,
        selection_max: 2,
      });

      expect(combo.name).toBe("Super Pack Escolar");
      expect(combo.product_type).toBe("combo");
      const outboxRow = state.outbox.find((o) => o.local_entity_id === combo.id);
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.operation).toBe("create");
    });

    it("remapCategoryReferences actualiza en cascada el category_id de los productos locales", async () => {
      const prod = await createProductLocal({
        name: "Galletas",
        categoryId: "cat-local-1",
        presentations: [{ name: "Paquete", unitEquivalence: 1, priceCents: 300, costCents: 200 }],
      });

      expect(prod.category_id).toBe("cat-local-1");
      await remapCategoryReferences("cat-local-1", "cat-srv-canonical-999");

      const localProd = state.products.find((p) => p.id === prod.id);
      expect(localProd?.category_id).toBe("cat-srv-canonical-999");
    });

    it("remapProductReferences actualiza en cascada el product_id en presentaciones locales", async () => {
      const prod = await createProductLocal({
        name: "Refresco",
        presentations: [{ name: "Botella 2L", unitEquivalence: 1, priceCents: 800, costCents: 500 }],
      });

      await remapProductReferences(prod.id, "prod-srv-canonical-888", false);
      const localPres = state.presentations.find((p) => p.product_id === "prod-srv-canonical-888");
      expect(localPres).toBeDefined();
    });
  });

  describe("Outbox Normalization (C-08)", () => {
    it("normalizeOutboxErrors convierte filas con status='error' a 'failed' para rescate", async () => {
      state.outbox.push({
        id: "out-err-1",
        entity_type: "order",
        local_entity_id: "order-123",
        operation: "create",
        priority: 3,
        status: "error",
        attempts: 1,
        last_error: "Jornada no disponible",
        created_at: new Date().toISOString(),
      });

      const updated = await normalizeOutboxErrors();
      expect(updated).toBe(1);
      const row = state.outbox.find((o) => o.id === "out-err-1");
      expect(row?.status).toBe("failed");
    });
  });
});


import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";

process.env.AUTH_TOKEN_SECRET = "test-secret-at-least-32-characters-long-12345";

// ─── Mocks para la base de datos PostgreSQL ─────────────────────────────────
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  connect: vi.fn(async () => mockClient),
  query: vi.fn((...args: any[]) => mockClient.query(...args)),
};

vi.mock("../db/pg", () => ({
  pool: {
    connect: async () => mockClient,
    query: (...args: any[]) => mockPool.query(...args),
  },
  nowIso: () => "2026-10-16T04:00:00.000Z",
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = req.userId || "usr-test-1";
    req.userRole = req.userRole || (req.headers && req.headers["x-role"]) || "admin";
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireReportDownloadAuth: (_req: any, _res: any, next: any) => next(),
}));

import { syncRouter } from "../routes/sync";
import { workdaysRouter, closeStaleOpenWorkDays } from "../routes/workdays";
import { reportsRouter } from "../routes/reports";
import { clientsRouter } from "../routes/clients";
import { formatClientDisplayName } from "../services/client-display";
import {
  generateClientReceiptsExcel,
  generateClientSummaryExcel,
  generateProductListExcel,
  getUniqueSheetName,
} from "../services/excel";
import { generateClientReceiptsPdf, sanitizePdfText } from "../services/receipts-pdf";
import { formatBoliviaDate, formatBoliviaDateTime, getBoliviaToday } from "../services/dates";
import ExcelJS from "exceljs";

let runSpecificMigration: any;

function makeRequest(
  app: express.Express,
  options: { method: string; url: string; body?: any; userId?: string; userRole?: string }
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = {
      method: options.method,
      url: options.url,
      headers: { "content-type": "application/json" },
      body: options.body || {},
      userId: options.userId || "usr-test-1",
      userRole: options.userRole,
    } as any;

    const fakeRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      getHeader: vi.fn(),
      status(code: number) {
        fakeRes.statusCode = code;
        return fakeRes;
      },
      json(data: any) {
        resolve({ status: fakeRes.statusCode, body: data });
      },
      send(data: any) {
        resolve({ status: fakeRes.statusCode, body: data });
      },
      end() {
        resolve({ status: fakeRes.statusCode, body: null });
      },
    } as any;

    app(req, fakeRes, (err: any) => {
      if (err) reject(err);
      else resolve({ status: fakeRes.statusCode, body: null });
    });
  });
}

describe("Suite Unificada: Sincronización, Jornadas y Reportes (sync_and_reports)", () => {
  let tempDir: string;
  let syncApp: express.Express;
  let workdaysApp: express.Express;
  let reportsApp: express.Express;

  beforeAll(async () => {
    const mod = await vi.importActual<any>("../../scripts/migrate");
    runSpecificMigration = mod.runSpecificMigration;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "preventapro-backend-tests-"));

    syncApp = express();
    syncApp.use(express.json());
    syncApp.use("/api/sync", syncRouter);

    workdaysApp = express();
    workdaysApp.use(express.json());
    workdaysApp.use("/workdays", workdaysRouter);

    reportsApp = express();
    reportsApp.use(express.json());
    reportsApp.use("/api/reports", reportsRouter);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn("No se pudo limpiar tempDir:", err);
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. SINCRONIZACIÓN: Idempotencia, Ordenamiento y Aislamiento de Fallos
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Sincronización (/api/sync)", () => {
    it("Idempotencia: no reinserta un pedido con idempotencyKey ya existente", async () => {
      mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };

        // Idempotency check: simular que ya existe
        if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) {
          return { rows: [{ id: "srv-order-already-exists", user_id: "usr-test-1" }] };
        }
        return { rows: [] };
      });

      const payload = {
        operations: [
          {
            id: "local-ord-1",
            entityType: "order",
            data: {
              idempotencyKey: "idem-dup-key-123",
              workDayId: "wd-1",
              clientId: "cli-1",
              items: [{ productId: "p-1", presentationId: "pres-1", quantity: 2 }],
            },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.succeeded).toBe(1);

      const opResult = res.body.results.find((r: any) => r.id === "local-ord-1");
      expect(opResult.status).toBe("synced");
      expect(opResult.serverId).toBe("srv-order-already-exists");
      expect(opResult.deduped).toBe(true);

      // Verificar que NO se ejecutó un INSERT INTO orders duplicado
      const insertCalls = mockClient.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO orders")
      );
      expect(insertCalls.length).toBe(0);
    });

    it("Ordenamiento: procesa clientes y categorías antes que pedidos aunque vengan desordenados", async () => {
      const executedEntities: string[] = [];

      mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };

        // Simular ejecución de cliente
        if (clean.includes("INSERT INTO clients") || clean.includes("UPDATE clients SET")) {
          executedEntities.push("client");
          return { rows: [{ id: "srv-client-10" }] };
        }
        if (clean.includes("SELECT id FROM clients WHERE")) {
          return { rows: [] };
        }

        // Simular ejecución de pedido
        if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) {
          return { rows: [] };
        }
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-1", user_id: "usr-test-1", status: "open" }] };
        }
        if (clean.includes("SELECT id, active FROM clients WHERE id = $1")) {
          return { rows: [{ id: "srv-client-10", active: true }] };
        }
        if (clean.includes("SELECT id, name, sku, product_type, active FROM products WHERE id = $1")) {
          return { rows: [{ id: "prod-1", name: "P1", sku: "SKU1", product_type: "standard", active: true }] };
        }
        if (clean.includes("SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE id = $1")) {
          return { rows: [{ id: "pres-1", product_id: "prod-1", name: "U", unit_equivalence: 1, price_cents: 500, active: true }] };
        }
        if (clean.includes("INSERT INTO orders")) {
          executedEntities.push("order");
          return { rows: [] };
        }
        if (clean.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders")) {
          return { rows: [{ count: 1, total: 500 }] };
        }

        return { rows: [] };
      });

      // Payload con pedido PRIMERO y cliente DESPUÉS
      const payload = {
        operations: [
          {
            id: "ord-op-1",
            entityType: "order",
            data: {
              workDayId: "wd-1",
              clientId: "srv-client-10",
              items: [{ productId: "prod-1", presentationId: "pres-1", quantity: 1 }],
            },
          },
          {
            id: "cli-op-1",
            entityType: "client",
            data: {
              businessName: "Abarrotes El Porvenir",
            },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);

      // Verificamos que cliente (prioridad 1) se procesó antes de orden (prioridad 2)
      expect(executedEntities[0]).toBe("client");
      expect(executedEntities[1]).toBe("order");
    });

    it("Aislamiento de fallos y pedidos offline en jornada cerrada", async () => {
      mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };

        if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) return { rows: [] };

        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return {
            rows: [
              {
                id: "wd-closed-1",
                user_id: "usr-test-1",
                work_date: "2026-10-15",
                status: "closed",
                closed_at: "2026-10-15T20:00:00.000Z", // Cerrada a las 20:00
              },
            ],
          };
        }
        if (clean.includes("SELECT id, active FROM clients WHERE id = $1")) return { rows: [{ id: "cli-1", active: true }] };
        if (clean.includes("SELECT id, name, sku, product_type, active FROM products WHERE id = $1")) {
          return { rows: [{ id: "prod-1", name: "Producto 1", sku: "P1", product_type: "standard", active: true }] };
        }
        if (clean.includes("SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE id = $1")) {
          return { rows: [{ id: "pres-1", product_id: "prod-1", name: "Unidad", unit_equivalence: 1, price_cents: 1000, active: true }] };
        }
        if (clean.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders")) {
          return { rows: [{ count: 1, total: 1000 }] };
        }

        return { rows: [] };
      });

      const payload = {
        operations: [
          {
            id: "ord-offline-legit",
            entityType: "order",
            data: {
              workDayId: "wd-closed-1",
              clientId: "cli-1",
              createdAt: "2026-10-15T19:45:00.000Z", // Creado antes del cierre (legítimo)
              items: [{ productId: "prod-1", presentationId: "pres-1", quantity: 1 }],
            },
          },
          {
            id: "ord-offline-post-close",
            entityType: "order",
            data: {
              workDayId: "wd-closed-1",
              clientId: "cli-1",
              createdAt: "2026-10-15T22:30:00.000Z", // Creado después del cierre (rechazado)
              items: [{ productId: "prod-1", presentationId: "pres-1", quantity: 1 }],
            },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed).toBe(1);

      const legitResult = res.body.results.find((r: any) => r.id === "ord-offline-legit");
      expect(legitResult.status).toBe("synced");

      const postCloseResult = res.body.results.find((r: any) => r.id === "ord-offline-post-close");
      expect(postCloseResult.status).toBe("failed");
      expect(postCloseResult.error).toContain("concluida");
    });

    it("M-01: Cancelación en sync rechaza cancelar un pedido de jornada cerrada", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE")) {
          return { rows: [{ id: "order-to-cancel", work_day_id: "wd-closed-99", user_id: "usr-test-1", status: "active" }] };
        }
        if (clean.includes("SELECT status FROM work_days WHERE id = $1")) {
          return { rows: [{ status: "closed" }] };
        }
        return { rows: [] };
      });

      const payload = {
        operations: [
          {
            id: "op-cancel-1",
            entityType: "order",
            action: "cancel",
            data: { serverId: "order-to-cancel" },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);
      expect(res.body.failed).toBe(1);
      expect(res.body.results[0].status).toBe("failed");
      expect(res.body.results[0].error).toContain("La jornada está cerrada");
    });

    it("M-07 y A-06: Búsqueda insensible de categorías y guardado de neighborhood_id en clientes", async () => {
      let executedCategoryUpdate = false;
      let insertedNeighborhoodId: string | null = null;

      mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("SELECT id FROM categories WHERE id = $1 OR LOWER(TRIM(name)) = LOWER(TRIM($2))")) {
          return { rows: [{ id: "cat-existente" }] };
        }
        if (clean.includes("UPDATE categories SET name = $1")) {
          executedCategoryUpdate = true;
          return { rows: [] };
        }
        if (clean.includes("SELECT id FROM clients WHERE")) {
          return { rows: [] };
        }
        if (clean.includes("INSERT INTO clients")) {
          insertedNeighborhoodId = params[8]; // $9 is neighborhood_id (index 8)
          return { rows: [] };
        }
        return { rows: [] };
      });

      const payload = {
        categories: [{ name: "gaseosas" }],
        clients: [{ businessName: "Tienda San Juan", neighborhoodId: "neigh-123" }],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);
      expect(executedCategoryUpdate).toBe(true);
      expect(insertedNeighborhoodId).toBe("neigh-123");
    });

    it("C-03: processProductSync guarda combo_definitions y combo_options para combos", async () => {
      let insertedComboDef = false;
      let insertedComboOptsCount = 0;

      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("SELECT id FROM products WHERE")) return { rows: [] };
        if (clean.includes("INSERT INTO products")) return { rows: [] };
        if (clean.includes("INSERT INTO product_presentations")) return { rows: [] };
        if (clean.includes("DELETE FROM combo_options WHERE combo_id IN")) return { rows: [] };
        if (clean.includes("DELETE FROM combo_definitions WHERE product_id = $1")) return { rows: [] };
        if (clean.includes("INSERT INTO combo_definitions")) {
          insertedComboDef = true;
          return { rows: [] };
        }
        if (clean.includes("INSERT INTO combo_options")) {
          insertedComboOptsCount++;
          return { rows: [] };
        }
        return { rows: [] };
      });

      const payload = {
        operations: [
          {
            id: "prod-combo-op",
            entityType: "product",
            data: {
              sku: "CMB-999",
              name: "Combo Super",
              productType: "combo",
              presentations: [{ name: "Pack", priceCents: 1000 }],
              comboDefinition: {
                selectionMin: 2,
                selectionMax: 4,
                options: [
                  { presentationId: "pres-a", maxQuantity: 2, sortOrder: 0 },
                  { presentationId: "pres-b", maxQuantity: 2, sortOrder: 1 },
                ],
              },
            },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(1);
      expect(insertedComboDef).toBe(true);
      expect(insertedComboOptsCount).toBe(2);
    });

    it("A-12: Agrega selecciones duplicadas de combo antes de validar cantidades máximas", async () => {
      let insertedSelections = 0;

      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) return { rows: [] };
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-open-1", user_id: "usr-test-1", status: "open" }] };
        }
        if (clean.includes("SELECT id, active FROM clients WHERE")) return { rows: [{ id: "cli-1", active: true }] };
        if (clean.includes("SELECT id, name, sku, product_type, active FROM products WHERE id = $1")) {
          return { rows: [{ id: "p-combo", name: "Combo Cereal", sku: "CMB-1", product_type: "combo", active: true }] };
        }
        if (clean.includes("SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE id = $1")) {
          return { rows: [{ id: "pres-combo", product_id: "p-combo", name: "Pack", unit_equivalence: 1, price_cents: 2000, active: true }] };
        }
        if (clean.includes("SELECT * FROM combo_definitions WHERE product_id = $1 AND active = true")) {
          return { rows: [{ id: "cdef-1", product_id: "p-combo", selection_min: 2, selection_max: 2, active: true }] };
        }
        if (clean.includes("SELECT * FROM combo_options WHERE combo_id = $1 AND active = true")) {
          return { rows: [{ id: "copt-1", combo_id: "cdef-1", presentation_id: "pres-choc", max_quantity: 2, active: true }] };
        }
        if (clean.includes("SELECT pp.name as pres_name, p.name as prod_name, p.id as prod_id FROM product_presentations pp")) {
          return { rows: [{ prod_id: "p-choc", prod_name: "Choc", pres_name: "Unidad" }] };
        }
        if (clean.includes("INSERT INTO order_item_selections")) {
          insertedSelections++;
          return { rows: [] };
        }
        if (clean.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders")) {
          return { rows: [{ count: 1, total: 2000 }] };
        }
        return { rows: [] };
      });

      const payload = {
        operations: [
          {
            id: "ord-combo-dup-sel",
            entityType: "order",
            data: {
              workDayId: "wd-open-1",
              clientId: "cli-1",
              items: [
                {
                  productId: "p-combo",
                  presentationId: "pres-combo",
                  quantity: 1,
                  selections: [
                    { selectedPresentationId: "pres-choc", quantity: 1 },
                    { selectedPresentationId: "pres-choc", quantity: 1 },
                  ],
                },
              ],
            },
          },
        ],
      };

      const res = await makeRequest(syncApp, { method: "POST", url: "/api/sync/push", body: payload });
      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(1);
      // Las 2 selecciones duplicadas de 1 se agregaron en 1 selección consolidada de cantidad 2
      expect(insertedSelections).toBe(1);
    });

    it("B-03: getBoliviaToday devuelve fecha 'YYYY-MM-DD' válida", () => {
      const today = getBoliviaToday();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. JORNADAS: Validaciones de Cierre, Reapertura y Cierre Automático
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Jornadas Laborales (workdays)", () => {
    it("POST /workdays/:id/close exige confirmación textual 'CONFIRMAR'", async () => {
      const resBad = await makeRequest(workdaysApp, {
        method: "POST",
        url: "/workdays/wd-100/close",
        body: { confirmation: "SI" },
      });
      expect(resBad.status).toBe(400);
      expect(resBad.body.error).toContain('Debes escribir exactamente "CONFIRMAR"');
    });

    it("POST /workdays/:id/close rechaza con 409 si la jornada ya está cerrada", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-100", user_id: "usr-test-1", status: "closed" }] };
        }
        return { rows: [] };
      });

      const res = await makeRequest(workdaysApp, {
        method: "POST",
        url: "/workdays/wd-100/close",
        body: { confirmation: "CONFIRMAR" },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("La jornada ya está cerrada");
    });

    it("POST /workdays/:id/close cierra la jornada y consolida totales activos", async () => {
      mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-100", user_id: "usr-test-1", status: "open", work_date: "2026-10-15" }] };
        }
        if (clean.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders")) {
          return { rows: [{ count: 3, total: 9500 }] };
        }
        if (clean.includes("UPDATE work_days SET status = 'closed'")) {
          return {
            rows: [
              {
                id: "wd-100",
                user_id: "usr-test-1",
                work_date: "2026-10-15",
                status: "closed",
                order_count: 3,
                total_cents: 9500,
                closed_at: "2026-10-16T04:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      });

      const res = await makeRequest(workdaysApp, {
        method: "POST",
        url: "/workdays/wd-100/close",
        body: { confirmation: "CONFIRMAR" },
      });
      expect(res.status).toBe(200);
      expect(res.body.workDay.status).toBe("closed");
      expect(res.body.workDay.order_count).toBe(3);
      expect(res.body.workDay.total_cents).toBe(9500);
    });

    it("POST /workdays/:id/reopen rechaza si ya existe otra jornada abierta", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-past", user_id: "usr-test-1", status: "closed" }] };
        }
        if (clean.includes("SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND id != $2")) {
          return { rows: [{ id: "wd-another-open" }] }; // Otra jornada abierta
        }
        return { rows: [] };
      });

      const res = await makeRequest(workdaysApp, {
        method: "POST",
        url: "/workdays/wd-past/reopen",
        body: {},
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Ya existe otra jornada abierta");
    });

    it("POST /workdays/:id/reopen reabre la jornada si no hay conflictos", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
        if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (clean.includes("SELECT * FROM work_days WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: "wd-past", user_id: "usr-test-1", status: "closed", work_date: "2026-10-15" }] };
        }
        if (clean.includes("SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND id != $2")) {
          return { rows: [] }; // Ninguna otra abierta
        }
        if (clean.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders")) {
          return { rows: [{ count: 2, total: 4000 }] };
        }
        if (clean.includes("UPDATE work_days SET status = 'open'")) {
          return {
            rows: [
              {
                id: "wd-past",
                user_id: "usr-test-1",
                work_date: "2026-10-15",
                status: "open",
                order_count: 2,
                total_cents: 4000,
                closed_at: null,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const res = await makeRequest(workdaysApp, {
        method: "POST",
        url: "/workdays/wd-past/reopen",
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.body.workDay.status).toBe("open");
      expect(res.body.workDay.closed_at).toBeNull();
    });

    it("closeStaleOpenWorkDays cierra jornadas antiguas automáticamente con pedidos activos", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean.includes("SELECT id FROM work_days WHERE user_id = $1 AND status = 'open' AND work_date < $2")) {
          return { rows: [{ id: "stale-wd-1" }] };
        }
        if (clean.includes("UPDATE work_days wd SET status = 'closed'")) {
          return { rows: [{ id: "stale-wd-1" }] };
        }
        return { rows: [] };
      });

      const closed = await closeStaleOpenWorkDays("2026-10-16", "usr-test-1", mockClient as any);
      expect(closed).toBe(true);

      const updateCall = mockClient.query.mock.calls.find((call) =>
        String(call[0]).includes("auto_closed = true")
      );
      expect(updateCall).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. REPORTES: Exclusión de pedidos cancelados, combos y fechas seguras
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Reportes Excel y PDF (excel.ts & receipts-pdf.ts)", () => {
    const workDayId = "wd-report-test";

    it("formatBoliviaDate y formatBoliviaDateTime evitan desfase por zona horaria", () => {
      expect(formatBoliviaDate("2026-10-15")).toBe("15/10/2026");
      expect(formatBoliviaDateTime("2026-10-16T02:30:00.000Z")).toContain("15/10/2026");
      expect(formatBoliviaDateTime("2026-10-16T02:30:00.000Z")).toContain("22:30");
    });

    it("generateClientSummaryExcel excluye pedidos cancelados de los totales", async () => {
      mockPool.query.mockImplementation(async (sql: string) => {
        expect(sql).toContain("o.status = 'active'");
        expect(sql).not.toContain("o.status != 'cancelled'");
        return {
          rows: [
            { business_name: "Cliente A", total_cents: "4000" },
            { business_name: "Cliente B", total_cents: "6000" },
          ],
        };
      });

      const filePath = await generateClientSummaryExcel(workDayId, tempDir);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.basename(filePath)).toBe("resumen_clientes.xlsx");
    });

    it("generateProductListExcel desglosa opciones de combos sin duplicar montos", async () => {
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM orders o")) {
          expect(sql).toContain("o.status = 'active'");
          return {
            rows: [
              {
                order_item_id: "item-combo-1",
                business_name: "Cliente Combo",
                address: "Av. Principal 123",
                product_name_snapshot: "Combo Desayuno",
                presentation_name_snapshot: "Pack Familiar",
                quantity: 1,
                unit_price_cents_snapshot: 3500,
                subtotal_cents: 3500,
                order_id: "ord-combo-1",
                order_subtotal_cents: 3500,
                order_tax_cents: 0,
                order_total_cents: 3500,
                created_at: "2026-10-15T14:00:00.000Z",
                receipt_number: 101,
              },
            ],
          };
        }
        if (sql.includes("FROM order_item_selections")) {
          return {
            rows: [
              {
                id: "sel-1",
                order_item_id: "item-combo-1",
                product_name_snapshot: "Cereal Chocolate",
                presentation_name_snapshot: "Caja 300g",
                quantity: 2,
                sort_order: 0,
              },
              {
                id: "sel-2",
                order_item_id: "item-combo-1",
                product_name_snapshot: "Cereal Miel",
                presentation_name_snapshot: "Caja 300g",
                quantity: 2,
                sort_order: 1,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const filePath = await generateProductListExcel(workDayId, tempDir);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.basename(filePath)).toBe("lista_de_productos.xlsx");
    });

    it("generateClientReceiptsExcel formatea boletas de clientes activas", async () => {
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM orders o")) {
          expect(sql).toContain("o.status = 'active'");
          return {
            rows: [
              {
                order_item_id: "item-1",
                business_name: "Cliente Activo",
                address: null,
                product_name_snapshot: "Producto Regular",
                presentation_name_snapshot: "Caja",
                quantity: 1,
                unit_price_cents_snapshot: 1500,
                subtotal_cents: 1500,
                order_id: "ord-1",
                order_subtotal_cents: 1500,
                order_tax_cents: 0,
                order_total_cents: 1500,
                created_at: "2026-10-15T18:00:00.000Z",
                receipt_number: 1,
              },
            ],
          };
        }
        if (sql.includes("FROM order_item_selections")) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const filePath = await generateClientReceiptsExcel(workDayId, tempDir);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.basename(filePath)).toBe("boletas_clientes.xlsx");
    });

    it("generateClientReceiptsPdf filtra pedidos cancelados y genera boletas PDF válidas", async () => {
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM orders o")) {
          expect(sql).toContain("o.status = 'active'");
          return {
            rows: [
              {
                order_id: "ord-pdf-1",
                order_item_id: "item-pdf-1",
                created_at: "2026-10-16T02:00:00.000Z",
                total_cents: 2500,
                subtotal_cents_order: 2500,
                tax_cents_order: 0,
                receipt_number: 99,
                business_name: "Distribuidora San José",
                address: "Calle Los Pinos 456",
                product_name_snapshot: "Combo Familiar",
                presentation_name_snapshot: "Pack x4",
                quantity: 1,
                unit_price_cents_snapshot: 2500,
                subtotal_cents: 2500,
              },
            ],
          };
        }
        if (sql.includes("FROM order_item_selections")) {
          return {
            rows: [
              {
                id: "sel-pdf-1",
                order_item_id: "item-pdf-1",
                product_name_snapshot: "Galletas Dulces",
                presentation_name_snapshot: "Paquete",
                quantity: 2,
                sort_order: 0,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const pdfPath = await generateClientReceiptsPdf(workDayId, tempDir);
      expect(fs.existsSync(pdfPath)).toBe(true);
      expect(path.basename(pdfPath)).toBe("boletas_clientes.pdf");

      const stats = fs.statSync(pdfPath);
      expect(stats.size).toBeGreaterThan(500); // Archivo PDF binario estructurado
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. MIGRACIONES UNIFICADAS (Delegación a scripts/migrate.ts)
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Delegación de Migraciones", () => {
    it("runSpecificMigration registra en _migrations al completar con éxito", async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        const clean = sql.replace(/\s+/g, " ").trim();
        if (clean.includes("CREATE TABLE IF NOT EXISTS _migrations")) return { rows: [] };
        if (clean.includes("SELECT name FROM _migrations WHERE name = $1")) return { rows: [] };
        return { rows: [] };
      });

      await runSpecificMigration("002_auth");

      const insertCall = mockClient.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO _migrations (name, executed_at) VALUES ($1, now())")
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toEqual(["002_auth"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. AUDITORÍA Y ENDURECIMIENTO (C-01, C-02, A-02, A-12, M-02, M-03, M-04)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Auditoría y Endurecimiento (C-01, C-02, A-02, A-12, M-02, M-03, M-04)", () => {
    describe("[C-01] Prevención IDOR en descarga de reportes", () => {
      it("rechaza con 403 Forbidden si un preventista intenta obtener token de descarga de otra jornada", async () => {
        mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes("FROM work_days WHERE id = $1")) {
            return {
              rows: [{ id: params[0], user_id: "usr-preventista-original" }],
            };
          }
          return { rows: [] };
        });

        const res = await makeRequest(reportsApp, {
          method: "POST",
          url: "/api/reports/wd-otro-usuario/download-token",
          userId: "usr-preventista-atacante",
          userRole: "preventista",
        });

        expect(res.status).toBe(403);
        expect(res.body.error).toContain("Acceso denegado a reportes de otra jornada.");
      });

      it("permite a un usuario con rol 'admin' obtener token de descarga para cualquier jornada", async () => {
        mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes("FROM work_days WHERE id = $1")) {
            return {
              rows: [{ id: params[0], user_id: "usr-preventista-original" }],
            };
          }
          return { rows: [] };
        });

        const res = await makeRequest(reportsApp, {
          method: "POST",
          url: "/api/reports/wd-otro-usuario/download-token",
          userId: "usr-admin-1",
          userRole: "admin",
        });

        expect(res.status).toBe(200);
        expect(res.body.downloadToken).toBeDefined();
      });
    });

    describe("[C-02] Cursor delta updated_at asignado por el servidor (ignora reloj cliente)", () => {
      it("asigna updated_at con la hora del servidor (NOW()) e ignora timestamp enviado por cliente en orden", async () => {
        let insertedUpdatedAt: string | null = null;
        mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
          const clean = sql.replace(/\s+/g, " ").trim();
          if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
          if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) return { rows: [] };
          if (clean.includes("FROM work_days")) {
            return { rows: [{ id: "wd-test-1", active: true, status: "open", user_id: "usr-test-1" }] };
          }
          if (clean.includes("FROM clients")) {
            return { rows: [{ id: "client-1", active: true, business_name: "Cliente 1" }] };
          }
          if (clean.includes("SELECT id, name, sku, product_type, active FROM products")) {
            return { rows: [{ id: "prod-1", name: "P1", sku: "SKU1", product_type: "standard", active: true }] };
          }
          if (clean.includes("SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations")) {
            return { rows: [{ id: "pres-1", product_id: "prod-1", name: "Unidad", unit_equivalence: 1, price_cents: 1000, active: true }] };
          }
          if (clean.includes("INSERT INTO orders")) {
            // $13 is updated_at
            insertedUpdatedAt = params[12];
            return { rows: [] };
          }
          if (clean.includes("FROM orders WHERE work_day_id = $1")) {
            return { rows: [{ count: 1, total: 1000 }] };
          }
          if (clean.includes("UPDATE work_days SET order_count = $1")) {
            return { rows: [] };
          }
          return { rows: [] };
        });

        const arbitraryClientTime = "2099-01-01T00:00:00.000Z";
        const res = await makeRequest(syncApp, {
          method: "POST",
          url: "/api/sync/push",
          body: {
            items: [
              {
                entityType: "order",
                operation: "create",
                data: {
                  localId: "ord-clock-skew",
                  idempotencyKey: "idem-clock-skew-1",
                  workDayId: "wd-test-1",
                  clientId: "client-1",
                  updated_at: arbitraryClientTime,
                  createdAt: "2026-10-16T12:00:00.000Z",
                  items: [{ productId: "prod-1", presentationId: "pres-1", quantity: 1 }],
                },
              },
            ],
          },
        });

        expect(res.status).toBe(200);
        expect(insertedUpdatedAt).toBeDefined();
        // El servidor asignó su timestamp actual, NO el año 2099 del cliente
        expect(insertedUpdatedAt).not.toBe(arbitraryClientTime);
        expect(new Date(insertedUpdatedAt!).getFullYear()).toBe(2026);
      });

      it("devuelve cursor delta generado por el servidor en la respuesta de pull", async () => {
        mockPool.query.mockImplementation(async (sql: string) => {
          if (sql.includes("SELECT * FROM clients")) return { rows: [] };
          if (sql.includes("SELECT * FROM products")) return { rows: [] };
          if (sql.includes("SELECT * FROM categories")) return { rows: [] };
          if (sql.includes("SELECT * FROM neighborhoods")) return { rows: [] };
          if (sql.includes("SELECT * FROM work_days")) return { rows: [] };
          if (sql.includes("SELECT * FROM combo_definitions")) return { rows: [] };
          if (sql.includes("SELECT * FROM combo_options")) return { rows: [] };
          if (sql.includes("SELECT id, product_id, name")) return { rows: [] };
          if (sql.includes("SELECT o.*")) return { rows: [] };
          return { rows: [] };
        });

        const res = await makeRequest(syncApp, {
          method: "GET",
          url: "/api/sync/pull?since=2026-10-15T00:00:00.000Z",
        });

        expect(res.status).toBe(200);
        expect(res.body.cursor).toBeDefined();
        expect(typeof res.body.cursor).toBe("string");
        expect(new Date(res.body.cursor).getFullYear()).toBe(2026);
      });
    });

    describe("[A-02] Fallo de BD en requireAuth responde 503 y nunca 401", () => {
      it("responde 503 Service Unavailable ante fallo de conexión de BD", async () => {
        const { requireAuth: realRequireAuth } = await vi.importActual<any>("../middleware/auth");
        const { createAccessToken } = await vi.importActual<any>("../services/auth");

        const validToken = createAccessToken("usr-valid-token");

        // Simular fallo de base de datos en pool.query
        mockPool.query.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

        const fakeReq = {
          headers: { authorization: `Bearer ${validToken}` },
        } as any;

        let statusCode = 0;
        let responseJson: any = null;
        const fakeRes = {
          status(code: number) {
            statusCode = code;
            return fakeRes;
          },
          json(data: any) {
            responseJson = data;
            return fakeRes;
          },
        } as any;

        const next = vi.fn();

        await realRequireAuth(fakeReq, fakeRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(statusCode).not.toBe(401);
        expect(statusCode).toBe(503);
        expect(responseJson.error).toContain("Error de conexión con la base de datos");
      });
    });

    describe("[A-12] Validación de combos agrega presentaciones repetidas", () => {
      it("rechaza la preventa si opciones repetidas con la misma presentación superan max_quantity sumadas", async () => {
        mockClient.query.mockImplementation(async (sql: string) => {
          const clean = sql.replace(/\s+/g, " ").trim();
          if (clean === "BEGIN" || clean === "COMMIT" || clean === "ROLLBACK") return { rows: [] };
          if (clean.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (clean.includes("SELECT id, user_id FROM orders WHERE idempotency_key = $1")) return { rows: [] };
          if (clean.includes("FROM work_days")) {
            return { rows: [{ id: "wd-test-1", active: true, status: "open", user_id: "usr-test-1" }] };
          }
          if (clean.includes("FROM clients")) {
            return { rows: [{ id: "client-1", active: true, business_name: "Cliente 1" }] };
          }
          if (clean.includes("SELECT id, name, sku, product_type, active FROM products")) {
            return { rows: [{ id: "prod-combo-1", name: "Combo Pack", sku: "CB01", product_type: "combo", active: true }] };
          }
          if (clean.includes("SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE id = $1")) {
            return { rows: [{ id: "pres-combo-main", product_id: "prod-combo-1", name: "Pack", unit_equivalence: 1, price_cents: 3000, active: true }] };
          }
          if (clean.includes("SELECT * FROM combo_definitions")) {
            return { rows: [{ id: "combo-def-1", product_id: "prod-combo-1", selection_min: 1, selection_max: 5, active: true }] };
          }
          if (clean.includes("SELECT * FROM combo_options")) {
            // max_quantity = 2 para la presentación pres-opt-1
            return { rows: [{ id: "opt-1", combo_id: "combo-def-1", presentation_id: "pres-opt-1", max_quantity: 2, active: true }] };
          }
          return { rows: [] };
        });

        // Enviar dos selecciones para la misma presentación pres-opt-1 con cantidades 2 y 1 (suman 3 > max 2)
        const res = await makeRequest(syncApp, {
          method: "POST",
          url: "/api/sync/push",
          body: {
            items: [
              {
                entityType: "order",
                operation: "create",
                data: {
                  localId: "ord-combo-dup",
                  idempotencyKey: "idem-combo-dup-1",
                  workDayId: "wd-test-1",
                  clientId: "client-1",
                  items: [
                    {
                      productId: "prod-combo-1",
                      presentationId: "pres-combo-main",
                      quantity: 1,
                      selections: [
                        { selectedPresentationId: "pres-opt-1", quantity: 2 },
                        { selectedPresentationId: "pres-opt-1", quantity: 1 },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });

        expect(res.status).toBe(200);
        expect(res.body.results).toBeDefined();
        const orderResult = res.body.results[0];
        expect(orderResult.status).toBe("failed");
        expect(orderResult.error).toContain("excede el límite de 2");
      });
    });

    describe("[M-02 / M-03 / M-04] Robustez en Excel y Sanitización de PDF", () => {
      it("[M-02] generateClientSummaryExcel agrupa por c.id y c.business_name para no fusionar clientes homónimos", async () => {
        let sqlExecuted = "";
        mockPool.query.mockImplementation(async (sql: string) => {
          sqlExecuted = sql;
          return {
            rows: [
              { client_id: "c-1", business_name: "Tienda Doña Rosa", total_cents: "1500" },
              { client_id: "c-2", business_name: "Tienda Doña Rosa", total_cents: "3000" },
            ],
          };
        });

        const summaryPath = await generateClientSummaryExcel("wd-test-1", tempDir);
        expect(fs.existsSync(summaryPath)).toBe(true);
        expect(sqlExecuted).toContain("GROUP BY c.id, c.business_name");
      });

      it("[M-03] getUniqueSheetName evita colisiones en hojas duplicadas y caracteres inválidos", () => {
        const wb = new ExcelJS.Workbook();
        const clean1 = getUniqueSheetName(wb, "Boleta [001] / Especial *");
        expect(clean1).not.toMatch(/[*?:\\/\[\]]/);

        wb.addWorksheet(clean1);
        const clean2 = getUniqueSheetName(wb, "Boleta [001] / Especial *");
        expect(clean2).toBe(`${clean1} (2)`);
      });

      it("[M-04] sanitizePdfText normaliza texto y remueve emojis fuera del rango WinAnsi", () => {
        const raw = "Preventista José 😊 ➔ Promoción ‘Especial’ — 100% 👍";
        const sanitized = sanitizePdfText(raw);
        expect(sanitized).not.toContain("😊");
        expect(sanitized).not.toContain("👍");
        expect(sanitized).toContain("José");
        expect(sanitized).toContain("->");
        expect(sanitized).toContain("-");
      });
    });

    describe("[Objetivo 1 y 2] Lista consolidada de productos y Flexibilidad de Nombres de Cliente", () => {
      it("[Objetivo 2] formatClientDisplayName maneja correctamente Casos A, B y C sin nulls ni líneas vacías", () => {
        // Caso A: Ambos
        const casoA = formatClientDisplayName({ business_name: "Tienda Doña Rosa", contact_name: "Rosa Flores" });
        expect(casoA.primary).toBe("Tienda Doña Rosa");
        expect(casoA.secondary).toBe("Rosa Flores");
        expect(casoA.fullTitle).toBe("Tienda Doña Rosa\nRosa Flores");

        // Caso B: Solo Propietario (sin Tienda)
        const casoB = formatClientDisplayName({ business_name: "", contact_name: "Carlos Gómez" });
        expect(casoB.primary).toBe("Carlos Gómez");
        expect(casoB.secondary).toBeNull();
        expect(casoB.fullTitle).toBe("Carlos Gómez");

        // Caso C: Solo Tienda (sin Propietario)
        const casoC = formatClientDisplayName({ business_name: "Minimarket Central", contact_name: "" });
        expect(casoC.primary).toBe("Minimarket Central");
        expect(casoC.secondary).toBeNull();
        expect(casoC.fullTitle).toBe("Minimarket Central");

        // Fallback sin datos
        const fallback = formatClientDisplayName({});
        expect(fallback.primary).toBe("Cliente");
        expect(fallback.secondary).toBeNull();
      });

      it("[Objetivo 2] clientsRouter valida que al menos un nombre esté presente al crear cliente", async () => {
        const app = express();
        app.use(express.json());
        app.use("/clients", clientsRouter);

        // Intento con ambos vacíos -> Rechazo 400
        const resEmpty = await makeRequest(app, {
          method: "POST",
          url: "/clients",
          body: { businessName: "", contactName: "" },
        });
        expect(resEmpty.status).toBe(400);
        expect(resEmpty.body.error).toContain("Debes ingresar al menos el nombre del negocio o el nombre del propietario");

        // Configuración de mock para INSERTs exitosos
        mockClient.query.mockImplementation(async (sql: string, params: any[]) => {
          if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
          if (sql.includes("INSERT INTO clients")) {
            return {
              rows: [{
                id: params?.[0] || "c-created-1",
                business_name: params?.[1] || null,
                contact_name: params?.[2] || null,
                phone: params?.[3] || null,
                address: null,
                active: true,
              }],
            };
          }
          return { rows: [] };
        });

        // Creación con solo nombre de propietario -> 201 Exitoso
        const resOwner = await makeRequest(app, {
          method: "POST",
          url: "/clients",
          body: { contact_name: "Don Pedro", phone: "70012345" },
        });
        expect(resOwner.status).toBe(201);
        expect(resOwner.body.client.contact_name).toBe("Don Pedro");

        // Creación con solo nombre de negocio -> 201 Exitoso
        const resStore = await makeRequest(app, {
          method: "POST",
          url: "/clients",
          body: { business_name: "Pulpería El Carmen" },
        });
        expect(resStore.status).toBe(201);
        expect(resStore.body.client.business_name).toBe("Pulpería El Carmen");
      });

      it("[Objetivo 1] generateProductListExcel genera exactamente las 4 columnas requeridas y fila TOTAL GENERAL", async () => {
        mockPool.query.mockImplementation(async (sql: string) => {
          if (sql.includes("FROM work_days")) {
            return { rows: [{ id: "wd-prod-test", work_date: "2026-10-16", user_id: "usr-1", status: "closed" }] };
          }
          if (sql.includes("JOIN order_items oi") || sql.includes("FROM order_items oi")) {
            return {
              rows: [
                {
                  order_item_id: "oi-1",
                  client_id: "c-1",
                  business_name: "Tienda 1",
                  contact_name: "Dueño 1",
                  product_name_snapshot: "Papas en tira",
                  presentation_name_snapshot: "Bolsa 500g",
                  unit_price_cents_snapshot: 2800,
                  quantity: 10,
                  subtotal_cents: 28000,
                  order_id: "o-1",
                  created_at: "2026-10-16T10:00:00Z",
                  receipt_number: "001",
                },
                {
                  order_item_id: "oi-2",
                  client_id: "c-1",
                  business_name: "Tienda 1",
                  contact_name: "Dueño 1",
                  product_name_snapshot: "Bombón",
                  presentation_name_snapshot: "Caja x24",
                  unit_price_cents_snapshot: 6000,
                  quantity: 10,
                  subtotal_cents: 60000,
                  order_id: "o-1",
                  created_at: "2026-10-16T10:00:00Z",
                  receipt_number: "001",
                },
              ],
            };
          }
          if (sql.includes("FROM order_item_selections")) {
            return { rows: [] };
          }
          return { rows: [] };
        });

        const filePath = await generateProductListExcel("wd-prod-test", tempDir);
        expect(fs.existsSync(filePath)).toBe(true);

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(filePath);
        const ws = wb.getWorksheet("Lista de Productos");
        expect(ws).toBeDefined();

        // Verificar encabezados de las 4 columnas (fila 3)
        const headerRow = ws!.getRow(3);
        expect(headerRow.getCell(1).value).toBe("Producto");
        expect(headerRow.getCell(2).value).toBe("Precio Unitario");
        expect(headerRow.getCell(3).value).toBe("Precio Total");
        expect(headerRow.getCell(4).value).toBe("Total de Unidades Pedidas");

        // Fila 4: Papas en tira
        const r1 = ws!.getRow(4);
        expect(r1.getCell(1).value).toBe("Papas en tira (Bolsa 500g)");
        expect(r1.getCell(2).value).toBe(28); // Bs 28
        expect(r1.getCell(3).value).toBe(280); // Bs 280
        expect(r1.getCell(4).value).toBe(10); // 10 unidades

        // Fila 5: Bombón
        const r2 = ws!.getRow(5);
        expect(r2.getCell(1).value).toBe("Bombón (Caja x24)");
        expect(r2.getCell(2).value).toBe(60); // Bs 60
        expect(r2.getCell(3).value).toBe(600); // Bs 600
        expect(r2.getCell(4).value).toBe(10); // 10 unidades

        // Fila 7: TOTAL GENERAL (fila 6 es separador)
        const totalRow = ws!.getRow(7);
        expect(totalRow.getCell(1).value).toBe("TOTAL GENERAL");
        expect(totalRow.getCell(3).value).toBe(880); // 280 + 600 = 880
        expect(totalRow.getCell(4).value).toBe(20); // 10 + 10 = 20
      });
    });
  });
});

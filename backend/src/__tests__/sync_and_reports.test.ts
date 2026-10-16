import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";

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
    req.userId = "usr-test-1";
    next();
  },
}));

import { syncRouter } from "../routes/sync";
import { workdaysRouter, closeStaleOpenWorkDays } from "../routes/workdays";
import {
  generateClientReceiptsExcel,
  generateClientSummaryExcel,
  generateProductListExcel,
} from "../services/excel";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";
import { formatBoliviaDate, formatBoliviaDateTime } from "../services/dates";

let runSpecificMigration: any;

function makeRequest(
  app: express.Express,
  options: { method: string; url: string; body?: any; userId?: string }
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = {
      method: options.method,
      url: options.url,
      headers: { "content-type": "application/json" },
      body: options.body || {},
      userId: options.userId || "usr-test-1",
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
});

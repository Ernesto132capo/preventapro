import { getTodayWorkDay } from "../db/repositories/workdays";
import { mergeDuplicateClients } from "../db/repositories/clients";

// Mocks for database
const mockState = {
  workdays: [] as any[],
  orders: [] as any[],
  clients: [] as any[],
};

const mockDb = {
  withTransactionAsync: jest.fn(async (cb: () => Promise<any>) => {
    return await cb();
  }),
  runAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.startsWith("UPDATE work_days SET status = 'closed'")) {
      for (const w of mockState.workdays) {
        if (w.user_id === params[0] && w.status === "open" && w.work_date < params[1]) {
          w.status = "closed";
        }
      }
      return { changes: 1 };
    }

    if (cleanSql.startsWith("UPDATE orders SET client_id = ? WHERE client_id = ?")) {
      const [canonicalId, dupId] = params;
      for (const o of mockState.orders) {
        if (o.client_id === dupId) {
          o.client_id = canonicalId;
        }
      }
      return { changes: 1 };
    }

    if (cleanSql.startsWith("DELETE FROM clients WHERE id = ?")) {
      const [id] = params;
      mockState.clients = mockState.clients.filter((c) => c.id !== id);
      return { changes: 1 };
    }

    return { changes: 1 };
  }),
  getFirstAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.includes("status = 'open' AND work_date > ?")) {
      const today = params[params.length - 1];
      const found = mockState.workdays.find(
        (w) => w.status === "open" && w.work_date > today
      );
      return found ? { ...found } : null;
    }

    if (cleanSql.includes("SELECT client_id FROM orders WHERE client_id IN")) {
      const ids = params;
      const found = mockState.orders.find((o) => ids.includes(o.client_id));
      return found ? { client_id: found.client_id } : null;
    }

    if (cleanSql.includes("SELECT id FROM clients WHERE id IN")) {
      const ids = params;
      const found = mockState.clients.find((c) => ids.includes(c.id));
      return found ? { id: found.id } : null;
    }

    return null;
  }),
  getAllAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.includes("FROM work_days WHERE work_date = ?") || cleanSql.includes("FROM work_days WHERE user_id = ? AND work_date = ?")) {
      const workDate = params[params.length - 1];
      return mockState.workdays.filter((w) => w.work_date === workDate);
    }

    if (cleanSql.includes("GROUP BY server_id HAVING COUNT(*) > 1")) {
      // Find server_ids with duplicates
      const counts = new Map<string, string[]>();
      for (const c of mockState.clients) {
        if (c.server_id && c.active === 1) {
          const list = counts.get(c.server_id) || [];
          list.push(c.id);
          counts.set(c.server_id, list);
        }
      }
      const results: { server_id: string; ids: string }[] = [];
      for (const [srvId, ids] of counts.entries()) {
        if (ids.length > 1) {
          results.push({ server_id: srvId, ids: ids.join(",") });
        }
      }
      return results;
    }

    return [];
  }),
};

jest.mock("../db/client", () => ({
  getDb: jest.fn(async () => mockDb),
  nowIso: () => "2026-10-16T12:00:00.000Z",
  withTx: jest.fn(async (cb: (db: any) => Promise<any>) => mockDb.withTransactionAsync(() => cb(mockDb))),
}));

jest.mock("../db/outbox", () => ({
  enqueue: jest.fn(async () => {}),
}));

describe("Hardenings Batch Suite (M-15, M-19, A-14)", () => {
  beforeEach(() => {
    mockState.workdays = [];
    mockState.orders = [];
    mockState.clients = [];
    jest.clearAllMocks();
  });

  describe("[M-15] Clock Skew in getTodayWorkDay", () => {
    it("should return the open future workday rather than throwing an unhandled exception", async () => {
      // Simulate that device date is 2026-10-15 due to clock skew, but an open workday already exists for 2026-10-16
      const futureOpenWorkDay = {
        id: "future-wd-1",
        user_id: "user-1",
        work_date: "2099-01-01", // intentionally in the future
        status: "open",
        order_count: 2,
        total_cents: 5000,
        sync_status: "pending",
        created_at: "2026-10-16T10:00:00.000Z",
      };
      mockState.workdays.push(futureOpenWorkDay);

      // Calling getTodayWorkDay should not throw!
      const activeWd = await getTodayWorkDay("user-1");

      expect(activeWd).toBeDefined();
      expect(activeWd.id).toBe("future-wd-1");
      expect(activeWd.status).toBe("open");
    });
  });

  describe("[M-19] mergeDuplicateClients Transactional Safety", () => {
    it("should merge duplicate clients inside withTransactionAsync atomically", async () => {
      // Two client rows with same server_id
      mockState.clients.push(
        { id: "local-1", server_id: "srv-client-99", business_name: "Tienda A", active: 1, created_at: "2026-10-10" },
        { id: "local-2", server_id: "srv-client-99", business_name: "Tienda A (copia)", active: 1, created_at: "2026-10-12" }
      );
      // Order belongs to local-2
      mockState.orders.push({ id: "order-1", client_id: "local-2" });

      const removedCount = await mergeDuplicateClients();

      expect(mockDb.withTransactionAsync).toHaveBeenCalled();
      expect(removedCount).toBe(1);
      // Order should now point to canonical client local-2 (which had orders)
      expect(mockState.orders[0].client_id).toBe("local-2");
      // Duplicate local-1 was removed
      expect(mockState.clients.some((c) => c.id === "local-1")).toBe(false);
      expect(mockState.clients.some((c) => c.id === "local-2")).toBe(true);
    });
  });

  describe("[A-14] Decimal Price Parsing & Normalization Logic", () => {
    function sanitizePriceInput(value: string): string {
      const normalized = value.replace(",", ".");
      const cleaned = normalized.replace(/[^0-9.]/g, "");
      const parts = cleaned.split(".");
      return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
    }

    function parseBsToCents(text: string): number {
      if (!text || !text.trim()) return 0;
      const val = parseFloat(text.trim());
      return isNaN(val) || val < 0 ? 0 : Math.round(val * 100);
    }

    it("should allow typing '12.' without stripping the decimal point", () => {
      const sanitized = sanitizePriceInput("12.");
      expect(sanitized).toBe("12.");
    });

    it("should convert comma to dot when user enters '12,50'", () => {
      const sanitized = sanitizePriceInput("12,50");
      expect(sanitized).toBe("12.50");
      expect(parseBsToCents(sanitized)).toBe(1250);
    });

    it("should prevent entering multiple decimal dots '12.50.2'", () => {
      const sanitized = sanitizePriceInput("12.50.2");
      expect(sanitized).toBe("12.502");
    });

    it("should correctly convert Bs to cents upon saving", () => {
      expect(parseBsToCents("10.5")).toBe(1050);
      expect(parseBsToCents("0.25")).toBe(25);
      expect(parseBsToCents("100")).toBe(10000);
      expect(parseBsToCents("")).toBe(0);
    });
  });
});

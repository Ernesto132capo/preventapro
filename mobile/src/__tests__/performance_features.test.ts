import { useDebounce } from "../utils/useDebounce";
import {
  enqueue,
  listPending,
  markDone,
  markFailed,
  markPermanentError,
  markSyncing,
  deferForDependency,
  deferForRetry,
  countPending,
  countUnresolvedOutboxItems,
  getFailedErrors,
  discardFailed,
  OutboxRow,
} from "../db/outbox";
import {
  getTodayWorkDay,
  markWorkDayClosed,
  reopenWorkDayLocal,
  listClosedWorkDays,
  deleteClosedWorkDayLocal,
  upsertServerWorkDay,
} from "../db/repositories/workdays";
import { upsertOrderFromServer, listOrdersForWorkDay } from "../db/repositories/orders";
import { pullCatalog, SYNC_PROTOCOL_VERSION } from "../services/sync";
import { apiFetch } from "../services/api";

// Simulación en memoria de la base de datos SQLite local para pruebas unitarias
interface MockOutboxRow {
  id: string;
  entity_type: string;
  local_entity_id: string;
  operation: string;
  priority: number;
  status: "pending" | "syncing" | "failed" | "error" | "done";
  attempts: number;
  last_error: string | null;
  created_at: string;
}

interface MockWorkDayRow {
  id: string;
  server_id: string | null;
  user_id: string;
  work_date: string;
  status: "open" | "closed";
  order_count: number;
  total_cents: number;
  sync_status: string;
  created_at: string;
}

interface MockOrderRow {
  id: string;
  server_id?: string | null;
  work_day_id: string;
  client_id?: string;
  client_name?: string;
  payment_condition?: string;
  status: "active" | "cancelled";
  sync_status?: string;
  total_cents: number;
  item_count?: number;
  created_at?: string;
  updated_at?: string;
}

const mockMetaState = new Map<string, string>();

const mockDbState = {
  outbox: [] as MockOutboxRow[],
  workDays: [] as MockWorkDayRow[],
  orders: [] as MockOrderRow[],
};

export function resetMockDb() {
  mockDbState.outbox = [];
  mockDbState.workDays = [];
  mockDbState.orders = [];
  mockMetaState.clear();
}

const mockDb = {
  runAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.startsWith("DELETE FROM orders WHERE work_day_id IN (")) {
      mockDbState.orders = mockDbState.orders.filter(order => !params.includes(order.work_day_id));
      return { changes: 1 };
    }
    if (cleanSql.startsWith("DELETE FROM work_days WHERE id IN (")) {
      mockDbState.workDays = mockDbState.workDays.filter(day => !params.includes(day.id) || day.status !== "closed");
      return { changes: 1 };
    }

    // OUTBOX: INSERT
    if (cleanSql.startsWith("INSERT INTO outbox")) {
      const [id, entity_type, local_entity_id, operation, priority, created_at] = params;
      mockDbState.outbox.push({
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

    // OUTBOX: markDone con deduplicación y resolución de errores antiguos
    if (cleanSql.startsWith("UPDATE outbox SET status = 'done'") && cleanSql.includes("WHERE id = ? OR (")) {
      const [targetId] = params;
      const target = mockDbState.outbox.find((r) => r.id === targetId);
      if (target) {
        target.status = "done";
        target.last_error = null;
        for (const row of mockDbState.outbox) {
          if (
            (row.status === "failed" || row.status === "error") &&
            row.entity_type === target.entity_type &&
            row.local_entity_id === target.local_entity_id
          ) {
            row.status = "done";
            row.last_error = null;
          }
        }
      }
      return { changes: 1 };
    }

    // OUTBOX: markFailed
    if (cleanSql.startsWith("UPDATE outbox SET status = 'failed'")) {
      const [error, id] = params;
      const row = mockDbState.outbox.find((r) => r.id === id);
      if (row) {
        row.status = "failed";
        row.attempts += 1;
        row.last_error = error;
      }
      return { changes: 1 };
    }

    // OUTBOX: markPermanentError
    if (cleanSql.startsWith("UPDATE outbox SET status = 'error'")) {
      const [error, id] = params;
      const row = mockDbState.outbox.find((r) => r.id === id);
      if (row) {
        row.status = "error";
        row.attempts += 1;
        row.last_error = error;
      }
      return { changes: 1 };
    }

    // OUTBOX: markSyncing
    if (cleanSql.startsWith("UPDATE outbox SET status = 'syncing'")) {
      const [id] = params;
      const row = mockDbState.outbox.find((r) => r.id === id);
      if (row) row.status = "syncing";
      return { changes: 1 };
    }

    // OUTBOX: deferForDependency
    if (cleanSql.startsWith("UPDATE outbox SET status = 'pending', next_retry_at = NULL WHERE id = ?")) {
      const [id] = params;
      const row = mockDbState.outbox.find((r) => r.id === id);
      if (row) row.status = "pending";
      return { changes: 1 };
    }

    // OUTBOX: deferForRetry
    if (cleanSql.startsWith("UPDATE outbox SET status = 'pending', attempts = attempts + 1")) {
      const [error, _nextRetryAt, id] = params;
      const row = mockDbState.outbox.find((r) => r.id === id);
      if (row) {
        row.status = "pending";
        row.attempts += 1;
        row.last_error = error;
      }
      return { changes: 1 };
    }

    // OUTBOX: discardFailed
    if (cleanSql.includes("UPDATE outbox SET status = 'done', last_error = NULL WHERE status = 'error'") ||
        cleanSql.includes("UPDATE outbox SET status = 'done', last_error = NULL WHERE status IN ('failed', 'error')")) {
      let changes = 0;
      for (const row of mockDbState.outbox) {
        if (row.status === "error") {
          row.status = "done";
          row.last_error = null;
          changes++;
        }
      }
      return { changes };
    }

    // WORKDAYS: UPDATE stale workdays < today
    if (cleanSql.includes("UPDATE work_days") && cleanSql.includes("work_date < ?")) {
      const today = params[params.length - 1];
      for (const wd of mockDbState.workDays) {
        if (wd.status === "open" && wd.work_date < today) {
          wd.status = "closed";
          const activeOrders = mockDbState.orders.filter((o) => o.work_day_id === wd.id && o.status === "active");
          wd.order_count = activeOrders.length;
          wd.total_cents = activeOrders.reduce((sum, o) => sum + o.total_cents, 0);
        }
      }
      return { changes: 1 };
    }

    // WORKDAYS: Reasignar órdenes en caso de duplicados
    if (cleanSql.startsWith("UPDATE orders SET work_day_id = ? WHERE work_day_id = ?")) {
      const [newId, oldId] = params;
      for (const o of mockDbState.orders) {
        if (o.work_day_id === oldId) o.work_day_id = newId;
      }
      return { changes: 1 };
    }

    // WORKDAYS: Borrar duplicado
    if (cleanSql.startsWith("DELETE FROM work_days WHERE id = ?") && !cleanSql.includes("status = 'closed'")) {
      const [id] = params;
      mockDbState.workDays = mockDbState.workDays.filter((wd) => wd.id !== id);
      return { changes: 1 };
    }

    // WORKDAYS: UPDATE status consolidado
    if (cleanSql.startsWith("UPDATE work_days SET status = ?") && cleanSql.includes("WHERE id = ?")) {
      const [status, _c1, _c2, id] = params;
      const wd = mockDbState.workDays.find((w) => w.id === id);
      if (wd) wd.status = status;
      return { changes: 1 };
    }

    // WORKDAYS: INSERT
    if (cleanSql.startsWith("INSERT INTO work_days")) {
      const [id, userId, work_date, created_at] = params;
      mockDbState.workDays.push({
        id,
        server_id: null,
        user_id: userId,
        work_date,
        status: "open",
        order_count: 0,
        total_cents: 0,
        sync_status: "pending",
        created_at,
      });
      return { changes: 1 };
    }

    // WORKDAYS: markWorkDayClosed
    if (cleanSql.startsWith("UPDATE work_days SET status = 'closed', order_count = ?, total_cents = ?")) {
      const [oc, tc, localId] = params;
      const wd = mockDbState.workDays.find((w) => w.id === localId || (w.server_id && w.server_id === localId));
      if (wd) {
        wd.status = "closed";
        wd.order_count = oc;
        wd.total_cents = tc;
      }
      return { changes: 1 };
    }

    // WORKDAYS: reopenWorkDayLocal
    if (cleanSql.startsWith("UPDATE work_days SET status = 'open'")) {
      const [localId] = params;
      const wd = mockDbState.workDays.find((w) => w.id === localId);
      if (wd) wd.status = "open";
      return { changes: 1 };
    }

    // WORKDAYS: upsertServerWorkDay
    if (cleanSql.startsWith("UPDATE work_days SET server_id = ?, status = ?")) {
      const [serverId, status, order_count, total_cents, localId] = params;
      const wd = mockDbState.workDays.find((w) => w.id === localId || w.server_id === serverId);
      if (wd) {
        wd.server_id = serverId;
        wd.status = status;
        wd.order_count = order_count;
        wd.total_cents = total_cents;
        wd.sync_status = "synced";
      }
      return { changes: 1 };
    }

    // WORKDAYS: delete cascade
    if (cleanSql.includes("DELETE FROM order_item_selections")) return { changes: 1 };
    if (cleanSql.includes("DELETE FROM order_items")) return { changes: 1 };
    if (cleanSql.startsWith("DELETE FROM orders WHERE work_day_id = ?")) {
      const [wdId] = params;
      mockDbState.orders = mockDbState.orders.filter((o) => o.work_day_id !== wdId);
      return { changes: 1 };
    }
    if (cleanSql.startsWith("DELETE FROM work_days WHERE id = ? AND status = 'closed'")) {
      const [id] = params;
      mockDbState.workDays = mockDbState.workDays.filter((wd) => wd.id !== id);
      return { changes: 1 };
    }

    // ORDERS: upsertOrderFromServer
    if (cleanSql === "UPDATE orders SET server_id = ?, work_day_id = ? WHERE id = ?") {
      const [serverId, workDayId, id] = params;
      const order = mockDbState.orders.find((o) => o.id === id);
      if (order) { order.server_id = serverId; order.work_day_id = workDayId; }
      return { changes: order ? 1 : 0 };
    }
    if (cleanSql.startsWith("INSERT INTO orders") && cleanSql.includes("ON CONFLICT(id) DO UPDATE SET")) {
      const [
        targetOrderId,
        serverId,
        workDayLocalId,
        clientLocalId,
        clientName,
        paymentCondition,
        _subtotalCents,
        _taxCents,
        totalCents,
        itemCount,
        status,
        createdAt,
        updatedAt,
      ] = params;
      const existing = mockDbState.orders.find((o) => o.id === targetOrderId || (serverId && o.server_id === serverId));
      if (existing) {
        existing.server_id = serverId;
        existing.work_day_id = workDayLocalId;
        existing.client_id = clientLocalId;
        existing.client_name = clientName;
        existing.payment_condition = paymentCondition;
        existing.total_cents = totalCents;
        existing.item_count = itemCount;
        existing.status = status;
        existing.sync_status = "synced";
        existing.updated_at = updatedAt;
      } else {
        mockDbState.orders.push({
          id: targetOrderId,
          server_id: serverId,
          work_day_id: workDayLocalId,
          client_id: clientLocalId,
          client_name: clientName,
          payment_condition: paymentCondition,
          status,
          sync_status: "synced",
          total_cents: totalCents,
          item_count: itemCount,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return { changes: 1 };
    }
    if (cleanSql.includes("INSERT INTO order_items")) return { changes: 1 };

    // ORDERS: update to cancelled (tombstone)
    if (cleanSql.includes("UPDATE orders SET") && cleanSql.includes("status = 'cancelled'")) {
      const [serverId, updatedAt, targetId] = params;
      const order = mockDbState.orders.find((o) => o.id === targetId || (serverId && o.server_id === serverId));
      if (order) {
        order.status = "cancelled";
        order.sync_status = "synced";
        order.updated_at = updatedAt;
        if (!order.server_id && serverId) order.server_id = serverId;
      }
      return { changes: 1 };
    }

    // OUTBOX: mark done for cancelled order
    if (cleanSql.includes("UPDATE outbox SET status = 'done'") && cleanSql.includes("entity_type = 'order'")) {
      const [targetOrderId, serverOrderId] = params;
      for (const row of mockDbState.outbox) {
        if (
          row.entity_type === "order" &&
          (row.local_entity_id === targetOrderId || row.local_entity_id === serverOrderId) &&
          ["pending", "syncing", "failed"].includes(row.status)
        ) {
          row.status = "done";
          row.last_error = null;
        }
      }
      return { changes: 1 };
    }

    // WORKDAYS: refresh totals from orders
    if (cleanSql.includes("UPDATE work_days SET") && cleanSql.includes("status = 'active'")) {
      const targetWdId = params[params.length - 1];
      const wd = mockDbState.workDays.find((w) => w.id === targetWdId || w.server_id === targetWdId);
      if (wd) {
        const activeOrders = mockDbState.orders.filter(
          (o) =>
            (o.work_day_id === wd.id || (wd.server_id && o.work_day_id === wd.server_id)) &&
            o.status === "active"
        );
        wd.order_count = activeOrders.length;
        wd.total_cents = activeOrders.reduce((sum, o) => sum + (o.total_cents || 0), 0);
      }
      return { changes: 1 };
    }

    return { changes: 0 };
  }),

  getAllAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.startsWith("SELECT id, status FROM work_days WHERE")) {
      return mockDbState.workDays.filter(day => day.id === params[0] || (params[1] && day.server_id === params[2]));
    }

    if (cleanSql.includes("FROM orders WHERE server_id = ? OR id = ? OR id = ?")) {
      const [serverId, id, originalId] = params;
      return mockDbState.orders
        .filter((o) => o.server_id === serverId || o.id === id || o.id === originalId)
        .sort((a, b) => Number(b.id === originalId) - Number(a.id === originalId))
        .map((o) => ({ ...o, server_id: o.server_id ?? null, sync_status: o.sync_status || "synced" }));
    }

    // OUTBOX: listPending
    if (cleanSql.includes("SELECT * FROM outbox WHERE status IN ('pending','syncing','failed')")) {
      return [...mockDbState.outbox]
        .filter((r) => ["pending", "syncing", "failed"].includes(r.status))
        .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    }

    // OUTBOX: getFailedErrors
    if (cleanSql.includes("SELECT entity_type, last_error FROM outbox WHERE status IN ('failed', 'error')")) {
      return [...mockDbState.outbox]
        .filter((r) => ["failed", "error"].includes(r.status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
        .map((r) => ({ entity_type: r.entity_type as any, last_error: r.last_error }));
    }

    // WORKDAYS: workdays of today
    if (cleanSql.includes("FROM work_days WHERE work_date = ?") || cleanSql.includes("FROM work_days WHERE user_id = ? AND work_date = ?")) {
      const workDate = params[params.length - 1];
      return [...mockDbState.workDays]
        .filter((w) => w.work_date === workDate)
        .sort((a, b) => {
          const aClosed = a.status === "closed" ? 0 : 1;
          const bClosed = b.status === "closed" ? 0 : 1;
          if (aClosed !== bClosed) return aClosed - bClosed;
          return b.created_at.localeCompare(a.created_at);
        });
    }

    // WORKDAYS: listClosedWorkDays
    if (cleanSql.includes("FROM work_days WHERE status = 'closed'") || cleanSql.includes("FROM work_days WHERE user_id = ? AND status = 'closed'")) {
      return [...mockDbState.workDays]
        .filter((w) => w.status === "closed")
        .sort((a, b) => b.work_date.localeCompare(a.work_date));
    }

    // ORDERS: listOrdersForWorkDay
    if (cleanSql.includes("FROM orders") && cleanSql.includes("status = 'active'")) {
      const wdId = params[0];
      return mockDbState.orders.filter(
        (o) => (o.work_day_id === wdId || o.work_day_id === params[1] || (params[2] && o.work_day_id === params[2])) && o.status === "active"
      );
    }

    return [];
  }),

  getFirstAsync: jest.fn(async (sql: string, params: any[] = []) => {
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    if (cleanSql.startsWith("SELECT id, server_id, status FROM work_days WHERE")) {
      return mockDbState.workDays.find(day => day.id === params[0] || day.server_id === params[1]) || null;
    }
    if (cleanSql.startsWith("SELECT o.id FROM orders o WHERE o.work_day_id IN (")) {
      return mockDbState.orders.find(order => params.includes(order.work_day_id) &&
        ((order.sync_status && order.sync_status !== "synced") || mockDbState.outbox.some(event =>
          event.entity_type === "order" && event.local_entity_id === order.id && event.status !== "done"))) || null;
    }

    if (cleanSql.startsWith("SELECT attempts FROM outbox WHERE id = ?")) {
      const row = mockDbState.outbox.find((r) => r.id === params[0]);
      return row ? { attempts: row.attempts } : null;
    }

    // OUTBOX: countPending
    if (cleanSql.includes("SELECT COUNT(*) as n FROM outbox WHERE status IN ('pending','syncing','failed')")) {
      const count = mockDbState.outbox.filter((r) => ["pending", "syncing", "failed"].includes(r.status)).length;
      return { n: count };
    }

    // OUTBOX: countUnresolvedOutboxItems
    if (cleanSql.includes("SELECT COUNT(*) as n FROM outbox WHERE status <> 'done'")) {
      const count = mockDbState.outbox.filter((r) => r.status !== "done").length;
      return { n: count };
    }

    // WORKDAYS: check future open
    if (cleanSql.includes("status = 'open' AND work_date > ?")) {
      const today = params[params.length - 1];
      const found = mockDbState.workDays.find((w) => w.status === "open" && w.work_date > today);
      return found ? { ...found } : null;
    }

    // WORKDAYS: find by id
    if (cleanSql.startsWith("SELECT * FROM work_days WHERE id = ?")) {
      const [id] = params;
      const found = mockDbState.workDays.find((w) => w.id === id);
      return found ? { ...found } : null;
    }

    // WORKDAYS: user_id & server_id
    if (cleanSql.startsWith("SELECT user_id, server_id FROM work_days WHERE id = ?") || cleanSql.startsWith("SELECT id, server_id, user_id FROM work_days WHERE id = ?")) {
      const [id] = params;
      const found = mockDbState.workDays.find((w) => w.id === id);
      return found ? { id: found.id, user_id: found.user_id, server_id: found.server_id } : null;
    }

    // WORKDAYS: check other open on reopen
    if (cleanSql.includes("status = 'open' AND id != ?")) {
      const localId = params[0];
      const found = mockDbState.workDays.find((w) => w.status === "open" && w.id !== localId);
      return found ? { id: found.id } : null;
    }

    // ORDERS aggregate
    if (cleanSql.includes("SELECT COUNT(*) AS order_count, COALESCE(SUM(total_cents), 0) AS total_cents FROM orders")) {
      const [localId] = params;
      const orders = mockDbState.orders.filter((o) => o.work_day_id === localId && o.status === "active");
      const total_cents = orders.reduce((sum, o) => sum + o.total_cents, 0);
      return { order_count: orders.length, total_cents };
    }

    // ORDERS: find for upsert
    if (cleanSql.includes("FROM orders WHERE server_id = ? OR id = ?")) {
      const [serverId, id] = params;
      const found = mockDbState.orders.find((o) => (serverId && o.server_id === serverId) || o.id === id);
      return found
        ? {
            id: found.id,
            server_id: found.server_id ?? null,
            work_day_id: found.work_day_id,
            sync_status: found.sync_status || "synced",
          }
        : null;
    }

    // CLIENTS: find for order upsert
    if (cleanSql.includes("FROM clients WHERE server_id = ? OR id = ?")) {
      const [serverId, id] = params;
      return { id: serverId || id, business_name: "Cliente Test" };
    }

    // WORKDAYS: find for order upsert
    if (cleanSql.startsWith("SELECT id FROM work_days WHERE") && !cleanSql.includes("id != ?") && !cleanSql.includes("work_date > ?")) {
      const found = mockDbState.workDays.find((w) => w.id === params[0] || w.server_id === params[0] || w.status === "open");
      return found ? { id: found.id } : { id: "wd-test" };
    }

    // PRODUCTS: find for order items upsert
    if (cleanSql.includes("FROM products WHERE server_id = ? OR id = ?")) {
      return { id: params[0] || params[1] };
    }
    if (cleanSql.includes("FROM product_presentations WHERE server_id = ? OR id = ?")) {
      return { id: params[0] || params[1] };
    }

    return null;
  }),

  execAsync: jest.fn(async () => {}),
};

const mockWithTx = jest.fn(async (cb: (db: any) => Promise<any>) => cb(mockDb));

jest.mock("../db/client", () => ({
  getDb: jest.fn(async () => mockDb),
  nowIso: jest.fn(() => new Date().toISOString()),
  withTx: (cb: any) => mockWithTx(cb),
  getMeta: jest.fn(async (key: string) => mockMetaState.get(key) || null),
  setMeta: jest.fn(async (key: string, value: string) => {
    mockMetaState.set(key, value);
  }),
}));

jest.mock("../services/api", () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

describe("Performance utilities & enhancements", () => {
  it("useDebounce está definido como hook", () => {
    expect(typeof useDebounce).toBe("function");
  });
});

describe("Outbox deduplication and sorting logic", () => {
  beforeEach(() => {
    resetMockDb();
    jest.clearAllMocks();
  });

  it("prioriza entidades maestras (prioridad 1) sobre órdenes (prioridad 2)", async () => {
    // Insertamos en desorden cronológico y de prioridad
    await enqueue("order", "order-1", 2, "create");
    await enqueue("client", "client-1", 1, "create");
    await enqueue("product", "product-1", 1, "create");
    await enqueue("order", "order-2", 2, "create");

    const pending = await listPending();
    expect(pending).toHaveLength(4);

    // Los dos primeros deben ser prioridad 1 (maestros: clientes/productos)
    expect(pending[0].entity_type).toBe("client");
    expect(pending[0].priority).toBe(1);

    expect(pending[1].entity_type).toBe("product");
    expect(pending[1].priority).toBe(1);

    // Los siguientes deben ser prioridad 2 (órdenes)
    expect(pending[2].entity_type).toBe("order");
    expect(pending[2].local_entity_id).toBe("order-1");

    expect(pending[3].entity_type).toBe("order");
    expect(pending[3].local_entity_id).toBe("order-2");
  });

  it("filtra correctamente por estado en listPending y conteos", async () => {
    await enqueue("client", "c-1", 1, "create"); // pending
    await enqueue("client", "c-2", 1, "create"); // pending -> syncing
    await enqueue("client", "c-3", 1, "create"); // pending -> failed
    await enqueue("client", "c-4", 1, "create"); // pending -> error
    await enqueue("client", "c-5", 1, "create"); // pending -> done

    const pendingListBefore = await listPending();
    const idMap = new Map(pendingListBefore.map((r) => [r.local_entity_id, r.id]));

    await markSyncing(idMap.get("c-2")!);
    await markFailed(idMap.get("c-3")!, "Network timeout");
    await markPermanentError(idMap.get("c-4")!, "Validation 400");
    await markDone(idMap.get("c-5")!);

    // listPending incluye ('pending', 'syncing', 'failed'), pero NO 'error' ni 'done'
    const pendingList = await listPending();
    expect(pendingList.map((r) => r.local_entity_id)).toEqual(["c-1", "c-2", "c-3"]);

    // countPending cuenta ('pending', 'syncing', 'failed')
    const pendingCount = await countPending();
    expect(pendingCount).toBe(3);

    // countUnresolvedOutboxItems cuenta todo lo no resuelto (incluye 'error')
    const unresolvedCount = await countUnresolvedOutboxItems();
    expect(unresolvedCount).toBe(4); // c-1, c-2, c-3, c-4
  });

  it("markDone resuelve automáticamente errores antiguos obsoletos de la misma entidad (deduplicación)", async () => {
    // 1. Un intento previo de actualizar el cliente c-1 falló y quedó con error
    await enqueue("client", "c-1", 1, "create");
    const [failedRow] = await listPending();
    await markPermanentError(failedRow.id, "Error previo del servidor");

    // 2. Se encola un nuevo intento de sincronización del mismo cliente
    await enqueue("client", "c-1", 1, "update");
    const pendingList = await listPending();
    expect(pendingList).toHaveLength(1); // El error permanente no sale en pending, solo el nuevo intento
    const newRowId = pendingList[0].id;

    // 3. Otro cliente diferente también tiene un error
    await enqueue("client", "c-other", 1, "create");
    const pendingOther = (await listPending()).find((r) => r.local_entity_id === "c-other")!;
    await markFailed(pendingOther.id, "Error de otro cliente");

    // 4. El nuevo intento de c-1 tiene éxito
    await markDone(newRowId);

    // Verificamos el estado en el mock:
    // El intento nuevo está en 'done'
    const updatedNewRow = mockDbState.outbox.find((r) => r.id === newRowId);
    expect(updatedNewRow?.status).toBe("done");

    // El error viejo de c-1 también fue resuelto y marcado como 'done' sin error
    const oldFailedRow = mockDbState.outbox.find((r) => r.id === failedRow.id);
    expect(oldFailedRow?.status).toBe("done");
    expect(oldFailedRow?.last_error).toBeNull();

    // El error de c-other NO fue afectado
    const otherRow = mockDbState.outbox.find((r) => r.id === pendingOther.id);
    expect(otherRow?.status).toBe("failed");
    expect(otherRow?.last_error).toBe("Error de otro cliente");
  });

  it("gestiona reintentos temporales y descarte de fallidos", async () => {
    await enqueue("order", "ord-retry", 2, "create");
    const [row] = await listPending();

    // deferForRetry incrementa intentos y guarda el error, manteniendo status pending
    await deferForRetry(row.id, "Conexión interrumpida");
    let current = mockDbState.outbox.find((r) => r.id === row.id);
    expect(current?.status).toBe("pending");
    expect(current?.attempts).toBe(1);
    expect(current?.last_error).toBe("Conexión interrumpida");

    // deferForDependency deja en pending sin incrementar attempts
    await deferForDependency(row.id);
    current = mockDbState.outbox.find((r) => r.id === row.id);
    expect(current?.attempts).toBe(1);

    // markFailed y getFailedErrors
    await markFailed(row.id, "Error 500");
    const failedErrors = await getFailedErrors();
    expect(failedErrors.length).toBeGreaterThanOrEqual(1);
    expect(failedErrors[0].last_error).toBe("Error 500");

    // discardFailed NO descarta errores reintentables transitorios ('failed')
    const notDiscarded = await discardFailed();
    expect(notDiscarded).toBe(0);
    expect(mockDbState.outbox.find((r) => r.id === row.id)?.status).toBe("failed");

    // markPermanentError marca error permanente ('error') y discardFailed lo descarta
    await markPermanentError(row.id, "Error 400 Bad Request");
    const discarded = await discardFailed();
    expect(discarded).toBe(1);
    expect(mockDbState.outbox.find((r) => r.id === row.id)?.status).toBe("done");
  });

  it("[C-08] recupera ítems con status 'failed' en listPending() para que sean reintentados consistentemente", async () => {
    await enqueue("order", "ord-fail-1", 2, "create");
    const [row] = await listPending();

    // Simulamos fallo transitorio (red o 500)
    await markFailed(row.id, "500 Internal Server Error");

    const failed = mockDbState.outbox.find((r) => r.id === row.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_error).toBe("500 Internal Server Error");

    // listPending DEBE incluir ítems 'failed' para la siguiente pasada de sincronización
    const pendingForNextPass = await listPending();
    expect(pendingForNextPass.some((r) => r.id === row.id)).toBe(true);

    // Reintento: pasa a syncing
    await markSyncing(row.id);
    expect(mockDbState.outbox.find((r) => r.id === row.id)?.status).toBe("syncing");

    // Si se aplaza con deferForRetry, status vuelve a pending incrementando attempts
    await deferForRetry(row.id, "Connection reset by peer");
    const retried = mockDbState.outbox.find((r) => r.id === row.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.attempts).toBe(2);
    expect(retried?.last_error).toBe("Connection reset by peer");

    // Éxito final: markDone lo pasa a done y limpia el error
    await markDone(row.id);
    expect(mockDbState.outbox.find((r) => r.id === row.id)?.status).toBe("done");
    expect(mockDbState.outbox.find((r) => r.id === row.id)?.last_error).toBeNull();

    // Ya no figura en pendientes
    const finalList = await listPending();
    expect(finalList.some((r) => r.id === row.id)).toBe(false);
  });

  it("[A-16] encola una ejecución inmediata de pushSync si se invoca durante una sincronización activa", async () => {
    jest.useFakeTimers();
    try {
      // Caso legacy; el Provider real se prueba en sync_context_orchestration.test.ts.
      const executionLog: string[] = [];
      let syncing = false;
      let pendingPush = false;

      async function simulatedPushSync() {
        if (syncing) {
          pendingPush = true;
          return;
        }
        syncing = true;
        executionLog.push("start-push");
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          executionLog.push("complete-push");
        } finally {
          syncing = false;
          if (pendingPush) {
            pendingPush = false;
            setTimeout(() => { void simulatedPushSync(); }, 10);
          }
        }
      }

      const firstSyncPromise = simulatedPushSync();
      expect(syncing).toBe(true);

      await simulatedPushSync();
      expect(pendingPush).toBe(true);
      expect(executionLog.filter((x) => x === "start-push")).toHaveLength(1);

      await jest.runAllTimersAsync();
      await firstSyncPromise;

      expect(executionLog).toEqual(["start-push", "complete-push", "start-push", "complete-push"]);
      expect(syncing).toBe(false);
      expect(pendingPush).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("[C-05] upsertOrderFromServer realiza upsert incremental sin purgar órdenes locales previas", async () => {
    // 1. Existen tres órdenes locales:
    // - ord-1: sincronizada previamente (no incluida en este delta)
    // - ord-2: sincronizada previamente (viene actualizada en el delta)
    // - ord-3: pendiente offline (no debe tocarse ni sobreescribirse)
    mockDbState.orders.push(
      { id: "ord-1", server_id: "srv-1", work_day_id: "wd-test", status: "active", sync_status: "synced", total_cents: 1000 },
      { id: "ord-2", server_id: "srv-2", work_day_id: "wd-test", status: "active", sync_status: "synced", total_cents: 2000 },
      { id: "ord-3", server_id: null, work_day_id: "wd-test", status: "active", sync_status: "pending", total_cents: 3000 }
    );

    // 2. Llega delta con ord-2 actualizada (total 2500) y nueva srv-4 (total 4000)
    const deltaOrders = [
      { id: "srv-2", work_day_id: "wd-test", client_id: "cli-1", total_cents: 2500, status: "active", items: [] },
      { id: "srv-4", work_day_id: "wd-test", client_id: "cli-1", total_cents: 4000, status: "active", items: [] },
    ];

    for (const srvOrder of deltaOrders) {
      await upsertOrderFromServer(srvOrder);
    }

    // Verificamos que ord-1 sigue intacta (no fue borrada a pesar de no venir en el delta)
    const ord1 = mockDbState.orders.find((o) => o.id === "ord-1");
    expect(ord1).toBeDefined();
    expect(ord1?.total_cents).toBe(1000);

    // Verificamos que ord-3 (pendiente local) sigue intacta
    const ord3 = mockDbState.orders.find((o) => o.id === "ord-3");
    expect(ord3).toBeDefined();
    expect(ord3?.sync_status).toBe("pending");
    expect(ord3?.total_cents).toBe(3000);

    // Verificamos que ord-2 fue actualizada con el valor del servidor
    const ord2 = mockDbState.orders.find((o) => o.id === "ord-2");
    expect(ord2).toBeDefined();
    expect(ord2?.total_cents).toBe(2500);

    // Verificamos que srv-4 fue agregada
    const ord4 = mockDbState.orders.find((o) => o.server_id === "srv-4");
    expect(ord4).toBeDefined();
    expect(ord4?.total_cents).toBe(4000);

    // Total de órdenes en BD = 4 (ninguna orden local previa fue purgada)
    expect(mockDbState.orders).toHaveLength(4);
  });
});

describe("Tombstone propagation and protocol upgrade", () => {
  beforeEach(() => {
    resetMockDb();
    jest.clearAllMocks();
  });

  it("aplica tombstone remoto de preventa anulada, borra líneas y actualiza totales locales de la jornada", async () => {
    mockDbState.workDays.push({
      id: "wd-test-1",
      server_id: "srv-wd-1",
      user_id: "usr-1",
      work_date: "2026-10-16",
      status: "open",
      order_count: 1,
      total_cents: 2000,
      sync_status: "synced",
      created_at: "2026-10-16T08:00:00.000Z",
    });

    mockDbState.orders.push({
      id: "ord-local-1",
      server_id: "srv-ord-1",
      work_day_id: "wd-test-1",
      client_id: "cli-1",
      status: "active",
      sync_status: "synced",
      total_cents: 2000,
      item_count: 1,
    });

    // Llega tombstone remoto para srv-ord-1 con status = 'cancelled'
    await upsertOrderFromServer({
      id: "srv-ord-1",
      work_day_id: "srv-wd-1",
      client_id: "cli-1",
      status: "cancelled",
      total_cents: 2000,
      items: [],
      updated_at: "2026-10-16T14:00:00.000Z",
    });

    const localOrder = mockDbState.orders.find((o) => o.id === "ord-local-1");
    expect(localOrder).toBeDefined();
    expect(localOrder?.status).toBe("cancelled");
    expect(localOrder?.sync_status).toBe("synced");

    // Los totales de la jornada bajaron inmediatamente
    const wd = mockDbState.workDays.find((w) => w.id === "wd-test-1");
    expect(wd?.order_count).toBe(0);
    expect(wd?.total_cents).toBe(0);

    // La lista de preventas activas no la muestra
    const activeOrders = await listOrdersForWorkDay("wd-test-1");
    expect(activeOrders).toHaveLength(0);
  });

  it("la anulación remota gana sobre cambios locales pendientes si la orden tiene server_id y marca outbox como done", async () => {
    mockDbState.workDays.push({
      id: "wd-test-2",
      server_id: "srv-wd-2",
      user_id: "usr-1",
      work_date: "2026-10-16",
      status: "open",
      order_count: 1,
      total_cents: 1500,
      sync_status: "synced",
      created_at: "2026-10-16T08:00:00.000Z",
    });

    mockDbState.orders.push({
      id: "ord-local-2",
      server_id: "srv-ord-2",
      work_day_id: "wd-test-2",
      client_id: "cli-1",
      status: "active",
      sync_status: "pending", // Cambio local pendiente
      total_cents: 1500,
      item_count: 1,
    });

    // Encolada operación pendiente en outbox
    await enqueue("order", "ord-local-2", 2, "update");
    expect(mockDbState.outbox.some((r) => r.local_entity_id === "ord-local-2" && r.status === "pending")).toBe(true);

    // Llega tombstone remoto con status = 'cancelled'
    await upsertOrderFromServer({
      id: "srv-ord-2",
      work_day_id: "srv-wd-2",
      client_id: "cli-1",
      status: "cancelled",
      total_cents: 1500,
      items: [],
      updated_at: "2026-10-16T15:00:00.000Z",
    });

    const localOrder = mockDbState.orders.find((o) => o.id === "ord-local-2");
    expect(localOrder?.status).toBe("cancelled");
    expect(localOrder?.sync_status).toBe("synced");

    // Operación pendiente de outbox resuelta a 'done'
    const outboxItem = mockDbState.outbox.find((r) => r.local_entity_id === "ord-local-2");
    expect(outboxItem?.status).toBe("done");

    // Totales de jornada reducidos
    const wd = mockDbState.workDays.find((w) => w.id === "wd-test-2");
    expect(wd?.order_count).toBe(0);
    expect(wd?.total_cents).toBe(0);
  });

  it("no altera preventas puramente locales sin server_id ante tombstones", async () => {
    mockDbState.orders.push({
      id: "ord-purely-local",
      server_id: null, // Sin server_id (creada offline)
      work_day_id: "wd-test-3",
      client_id: "cli-1",
      status: "active",
      sync_status: "pending",
      total_cents: 3000,
      item_count: 2,
    });

    // Intento de tombstone con el id local sin que tenga server_id
    await upsertOrderFromServer({
      id: "ord-purely-local",
      work_day_id: "wd-test-3",
      status: "cancelled",
      total_cents: 3000,
      items: [],
    });

    const localOrder = mockDbState.orders.find((o) => o.id === "ord-purely-local");
    expect(localOrder?.status).toBe("active");
    expect(localOrder?.sync_status).toBe("pending");
    expect(localOrder?.total_cents).toBe(3000);
  });

  it("reconciliación de protocolo: fuerza since=1970 si protocol_version no está en meta y lo guarda tras el éxito", async () => {
    const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;
    mockedApiFetch.mockResolvedValue({
      cursor: "2026-10-17T21:00:00.000Z",
      clients: [],
      products: [],
      orders: [],
    });

    // Simulamos un dispositivo existente que ya sincronizó antes (tiene cursor) pero no la versión de protocolo
    mockMetaState.set("last_pull_at", "2026-10-17T20:00:00.000Z");

    await pullCatalog("user-test-1");

    // Primera vez: debió pedir since 1970 por falta de versión de protocolo
    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("since=1970-01-01T00%3A00%3A00.000Z")
    );
    // Y guardó la versión de protocolo en meta
    expect(mockMetaState.get("protocol_version")).toBe(SYNC_PROTOCOL_VERSION);

    // Segunda vez: ahora sí usa el cursor incremental (no 1970)
    mockedApiFetch.mockClear();
    mockedApiFetch.mockResolvedValue({
      cursor: "2026-10-17T21:30:00.000Z",
      clients: [],
      products: [],
      orders: [],
    });

    await pullCatalog("user-test-1");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.not.stringContaining("since=1970-01-01T00%3A00%3A00.000Z")
    );
  });
});

describe("Workday invariants and lifecycle", () => {
  const userId = "preventista-001";

  beforeEach(() => {
    resetMockDb();
    jest.clearAllMocks();
  });

  it("crea una jornada abierta si no existe para la fecha de hoy y es idempotente", async () => {
    const wd1 = await getTodayWorkDay(userId);
    expect(wd1).toBeDefined();
    expect(wd1.user_id).toBe(userId);
    expect(wd1.status).toBe("open");
    expect(wd1.order_count).toBe(0);

    // Segunda llamada debe retornar la misma jornada sin duplicarla
    const wd2 = await getTodayWorkDay(userId);
    expect(wd2.id).toBe(wd1.id);
    expect(mockDbState.workDays).toHaveLength(1);
  });

  it("cierra la jornada correctamente y no la reabre al volver a consultar getTodayWorkDay", async () => {
    const wd = await getTodayWorkDay(userId);
    expect(wd.status).toBe("open");

    // Añadimos pedidos simulados activos
    mockDbState.orders.push(
      { id: "o-1", work_day_id: wd.id, status: "active", total_cents: 1500 },
      { id: "o-2", work_day_id: wd.id, status: "active", total_cents: 2500 }
    );

    // Concluimos la jornada
    await markWorkDayClosed(wd.id);

    // Al consultar nuevamente hoy, debe permanecer en estado 'closed' con los totales calculados
    const closedWd = await getTodayWorkDay(userId);
    expect(closedWd.id).toBe(wd.id);
    expect(closedWd.status).toBe("closed");
    expect(closedWd.order_count).toBe(2);
    expect(closedWd.total_cents).toBe(4000);
  });

  it("mantiene la invariante de una sola jornada abierta al intentar reabrir", async () => {
    // 1. Creamos y cerramos la jornada 1
    const wd1 = await getTodayWorkDay(userId);
    await markWorkDayClosed(wd1.id, 0, 0);

    // 2. Si no hay otra abierta, reabrirla tiene éxito
    await reopenWorkDayLocal(wd1.id);
    expect(mockDbState.workDays.find((w) => w.id === wd1.id)?.status).toBe("open");

    // Cerramos wd1 nuevamente
    await markWorkDayClosed(wd1.id, 0, 0);

    // 3. Creamos otra jornada abierta en la base de datos (ej. otra fecha)
    mockDbState.workDays.push({
      id: "wd-other-open",
      server_id: null,
      user_id: userId,
      work_date: "2026-10-16",
      status: "open",
      order_count: 0,
      total_cents: 0,
      sync_status: "pending",
      created_at: new Date().toISOString(),
    });

    // 4. Intentar reabrir wd1 debe lanzar error porque ya existe otra jornada abierta
    await expect(reopenWorkDayLocal(wd1.id)).rejects.toThrow(
      "Ya existe otra jornada abierta. Ciérrala antes de reabrir esta jornada."
    );
  });

  it("cierra automáticamente jornadas pasadas abiertas que quedaron abiertas al cambiar de fecha", async () => {
    // Jornada vieja de ayer que quedó olvidada en estado 'open'
    const pastWdId = "past-wd-1";
    mockDbState.workDays.push({
      id: pastWdId,
      server_id: null,
      user_id: userId,
      work_date: "2020-01-01", // Fecha en el pasado
      status: "open",
      order_count: 0,
      total_cents: 0,
      sync_status: "pending",
      created_at: "2020-01-01T08:00:00.000Z",
    });

    mockDbState.orders.push({
      id: "ord-past",
      work_day_id: pastWdId,
      status: "active",
      total_cents: 3500,
    });

    // Al solicitar la jornada de hoy, la jornada pasada debe ser cerrada y calculada
    const todayWd = await getTodayWorkDay(userId);
    expect(todayWd.status).toBe("open");
    expect(todayWd.id).not.toBe(pastWdId);

    const pastWd = mockDbState.workDays.find((w) => w.id === pastWdId);
    expect(pastWd?.status).toBe("closed");
    expect(pastWd?.order_count).toBe(1);
    expect(pastWd?.total_cents).toBe(3500);
  });

  it("lista jornadas cerradas y permite eliminación local limpia con órdenes asociadas", async () => {
    const closedId = "closed-wd-to-delete";
    mockDbState.workDays.push({
      id: closedId,
      server_id: "srv-closed-1",
      user_id: userId,
      work_date: "2026-10-10",
      status: "closed",
      order_count: 1,
      total_cents: 2000,
      sync_status: "synced",
      created_at: "2026-10-10T08:00:00.000Z",
    });

    mockDbState.orders.push({
      id: "ord-to-delete",
      work_day_id: closedId,
      status: "active",
      total_cents: 2000,
    });

    const closedList = await listClosedWorkDays(userId);
    expect(closedList.some((w) => w.id === closedId)).toBe(true);

    // Eliminación local tras confirmación de sincronización
    await deleteClosedWorkDayLocal(closedId);

    expect(mockDbState.workDays.some((w) => w.id === closedId)).toBe(false);
    expect(mockDbState.orders.some((o) => o.work_day_id === closedId)).toBe(false);
  });
});

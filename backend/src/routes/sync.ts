import { Router } from "express";
import { v4 as uuid } from "uuid";
import { PoolClient } from "pg";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { calculateLineSubtotalCents, calculateTaxCents } from "../services/pricing";
import { closeStaleOpenWorkDays, invalidateWorkdayCache, lockWorkDays } from "./workdays";
import { isLegitimateOfflineOrder } from "../services/workday-policy";
import { insertOrderItems, loadOrderCatalog } from "../services/order-storage";
import { getBoliviaDate, getBoliviaToday } from "../services/dates";
import { resolveCategoryId, UUID_REGEX, syncProductPresentations } from "./catalog";

export const syncRouter = Router();
syncRouter.use(requireAuth);

function client(row: any) {
  const bName = row.business_name ?? row.name ?? "";
  const oName = row.contact_name ?? row.owner_name ?? null;
  return {
    id: row.id,
    client_local_id: row.client_local_id ?? null,
    business_name: bName,
    name: bName,
    contact_name: oName,
    owner_name: oName,
    phone: row.phone ?? null,
    neighborhood_id: row.neighborhood_id ?? null,
    address: row.address ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    visit_status: row.visit_status ?? "pending",
    active: row.active === false ? 0 : 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function product(row: any) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category_id: row.category_id ?? null,
    photo_url: row.photo_url ?? null,
    base_cost_cents: row.base_cost_cents ?? 0,
    base_unit_name: row.base_unit_name ?? "Unidad",
    product_type: row.product_type || "standard",
    active: row.active === false ? 0 : 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentation(row: any) {
  return {
    id: row.id,
    product_id: row.product_id ?? null,
    name: row.name,
    sort_order: row.sort_order ?? 0,
    unit_equivalence: row.unit_equivalence ?? 1,
    price_cents: row.price_cents ?? 0,
    cost_cents: row.cost_cents ?? 0,
    active: row.active === false ? 0 : 1,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || new Date().toISOString(),
  };
}

// ─── Caché de pulls incrementales ─────────────────────────────────────────────
interface PullCache {
  etag: string;
  payload: string;
}
const pullCache = new Map<string, PullCache>();
const MAX_PULL_CACHE_ENTRIES = 25;
type PullDomain = "all" | "clients" | "products" | "orders" | "workdays";

const clientQueryCache = new Map<string, any[]>();
const productQueryCache = new Map<string, any[]>();
const presentationQueryCache = new Map<string, any[]>();
const comboDefQueryCache = new Map<string, any[]>();
const comboOptionQueryCache = new Map<string, any[]>();
const categoryQueryCache = new Map<string, any[]>();
const neighborhoodQueryCache = new Map<string, any[]>();
const workdayQueryCache = new Map<string, any[]>();
const orderQueryCache = new Map<string, any[]>();
const orderItemQueryCache = new Map<string, any[]>();
const clientNameCache = new Map<string, string>();
const sourceReadsInFlight = new Map<string, Promise<any[]>>();
const forcedPullsInFlight = new Map<string, Promise<PullCache>>();
const MAX_SOURCE_CACHE_ENTRIES = 25;
const MAX_CLIENT_NAME_CACHE_ENTRIES = 1000;

function setBoundedCacheEntry<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number) {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

async function cachedRows(
  domain: string,
  cache: Map<string, any[]>,
  key: string,
  load: () => Promise<any[]>,
  force = false
): Promise<any[]> {
  if (!force && cache.has(key)) return cache.get(key)!;
  const flightKey = `${domain}:${key}`;
  const inFlight = sourceReadsInFlight.get(flightKey);
  if (inFlight) return inFlight;
  const task = load().then((rows) => {
    setBoundedCacheEntry(cache, key, rows, MAX_SOURCE_CACHE_ENTRIES);
    return rows;
  });
  sourceReadsInFlight.set(flightKey, task);
  try {
    return await task;
  } finally {
    sourceReadsInFlight.delete(flightKey);
  }
}

export function invalidatePullCache(domain: PullDomain = "all") {
  pullCache.clear();
  if (domain === "all" || domain === "clients") {
    clientQueryCache.clear();
    clientNameCache.clear();
  }
  if (domain === "all" || domain === "products") {
    productQueryCache.clear();
    presentationQueryCache.clear();
    comboDefQueryCache.clear();
    comboOptionQueryCache.clear();
    categoryQueryCache.clear();
    neighborhoodQueryCache.clear();
  }
  if (domain === "all" || domain === "orders" || domain === "workdays") {
    workdayQueryCache.clear();
    orderQueryCache.clear();
    orderItemQueryCache.clear();
  }
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const FORCE_TTL_MS = Number(process.env.SYNC_FORCE_TTL_MS) || 45_000;
const lastRealForceFetchByUser = new Map<string, number>();

async function recalcWorkDayTotals(client: PoolClient, workDayId: string): Promise<void> {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders WHERE work_day_id = $1 AND status = 'active'",
    [workDayId]
  );
  await client.query(
    "UPDATE work_days SET order_count = $2, total_cents = $3, updated_at = $4 WHERE id = $1",
    [workDayId, rows[0].count, rows[0].total, nowIso()]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sync/pull — Sincronización descendente incremental
// ─────────────────────────────────────────────────────────────────────────────

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  let rejectForcedPull: ((reason?: unknown) => void) | undefined;
  let resolveForcedPull: ((value: PullCache) => void) | undefined;
  let forcedKey: string | undefined;
  try {
    const requestedForce = req.query.force === "1";
    let since = (requestedForce || !req.query.since) ? "1970-01-01T00:00:00.000Z" : String(req.query.since);
    if (!since.startsWith("1970")) {
      const sinceMs = Date.parse(since);
      if (!isNaN(sinceMs)) {
        since = new Date(Math.max(0, sinceMs - 120_000)).toISOString();
      }
    }
    const pullKey = `${req.userId}:${since}`;
    const isInitial = !req.query.since || since.startsWith("1970");

    const now = Date.now();
    const userLastForce = lastRealForceFetchByUser.get(req.userId!) || 0;
    const forceThrottled = requestedForce && now - userLastForce < FORCE_TTL_MS;
    const force = requestedForce && !forceThrottled;
    if (force) lastRealForceFetchByUser.set(req.userId!, now);
    // Clean old entries
    if (lastRealForceFetchByUser.size > 200) {
      const cutoff = now - FORCE_TTL_MS * 2;
      for (const [uid, ts] of lastRealForceFetchByUser) {
        if (ts < cutoff) lastRealForceFetchByUser.delete(uid);
      }
    }

    const cached = !force && !isInitial ? pullCache.get(pullKey) : undefined;
    if (cached) {
      const clientEtag = req.headers["if-none-match"];
      if (clientEtag === cached.etag) {
        return res.status(304).end();
      }
      res.setHeader("ETag", cached.etag);
      return res.json(JSON.parse(cached.payload));
    }

    if (force) {
      const inFlight = forcedPullsInFlight.get(pullKey);
      if (inFlight) {
        const shared = await inFlight;
        res.setHeader("ETag", shared.etag);
        return res.json(JSON.parse(shared.payload));
      }
      forcedKey = pullKey;
      const resolvableTask = new Promise<PullCache>((resolve, reject) => {
        resolveForcedPull = resolve;
        rejectForcedPull = reject;
      });
      forcedPullsInFlight.set(forcedKey, resolvableTask);
    }

    const todayDate = getBoliviaToday();

    // Auto-cerrar jornadas pasadas abiertas para mantener consistencia con workdays.ts
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("BEGIN");
      await lockWorkDays(cleanupClient);
      const closedStale = await closeStaleOpenWorkDays(todayDate, req.userId!, cleanupClient);
      await cleanupClient.query("COMMIT");
      if (closedStale) {
        invalidatePullCache("workdays");
        invalidateWorkdayCache();
      }
    } catch (error) {
      try { await cleanupClient.query("ROLLBACK"); } catch { /* conexión perdida */ }
      throw error;
    } finally {
      cleanupClient.release();
    }

    const cursorKey = isInitial ? "__initial__" : since;
    const [clientRows, productRows, categoryRows, neighborhoodRows, workDayRows, comboDefRows, comboOptionRows] =
      await Promise.all([
        cachedRows(
          "clients",
          clientQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM clients")).rows
              : (await pool.query("SELECT * FROM clients WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "products",
          productQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM products")).rows
              : (await pool.query("SELECT * FROM products WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "categories",
          categoryQueryCache,
          cursorKey,
          async () => (isInitial
            ? (await pool.query("SELECT * FROM categories ORDER BY name")).rows
            : (await pool.query("SELECT * FROM categories WHERE updated_at > $1 ORDER BY name", [since])).rows),
          force
        ),
        cachedRows(
          "neighborhoods",
          neighborhoodQueryCache,
          cursorKey,
          async () => (isInitial ? (await pool.query("SELECT * FROM neighborhoods WHERE active = true")).rows : []),
          force
        ),
        cachedRows(
          "workdays",
          workdayQueryCache,
          `shared:${cursorKey}`,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM work_days ORDER BY work_date DESC LIMIT 30")).rows
              : (await pool.query("SELECT * FROM work_days WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "combo_definitions",
          comboDefQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM combo_definitions")).rows
              : (await pool.query("SELECT * FROM combo_definitions WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "combo_options",
          comboOptionQueryCache,
          cursorKey,
          // Es un snapshot completo: opciones eliminadas físicamente también
          // deben desaparecer del catálogo local del otro teléfono.
          async () => (await pool.query("SELECT * FROM combo_options ORDER BY sort_order")).rows,
          force
        ),
      ]);

    const rawPresentationRows = await cachedRows(
      "presentations",
      presentationQueryCache,
      cursorKey,
      async () =>
        isInitial
          ? (
              await pool.query(
                "SELECT id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at FROM product_presentations"
              )
            ).rows
          : (
              await pool.query(
                "SELECT id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at FROM product_presentations WHERE updated_at > $1",
                [since]
              )
            ).rows,
      force
    );

    const presentations = rawPresentationRows.map((row: any) => presentation(row));

    const sortedWorkDayRows = [...workDayRows].sort((a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
    );
    const todayWorkDayRow = sortedWorkDayRows.find((w) => w.work_date === todayDate) || sortedWorkDayRows[0] || null;

    let orders: any[] = [];
    if (workDayRows.length > 0) {
      // La respuesta mantiene su propia copia; la expulsión de entradas de
      // caché nunca debe recortar una descarga con más jornadas/pedidos.
      const ordersByWorkDay = new Map<string, any[]>();
      if (!force) {
        for (const wd of workDayRows) {
          const cachedOrders = orderQueryCache.get(wd.id);
          if (cachedOrders) ordersByWorkDay.set(wd.id, cachedOrders);
        }
      }
      const missingWdIds = force
        ? workDayRows.map((w) => w.id)
        : workDayRows.filter((w) => !orderQueryCache.has(w.id)).map((w) => w.id);

      if (missingWdIds.length > 0) {
        const { rows: fetchedOrders } = await pool.query(
          "SELECT * FROM orders WHERE work_day_id = ANY($1)",
          [missingWdIds]
        );
        const ordersByWd = new Map<string, any[]>();
        for (const wid of missingWdIds) ordersByWd.set(wid, []);
        for (const ord of fetchedOrders) {
          const list = ordersByWd.get(ord.work_day_id) || [];
          list.push(ord);
          ordersByWd.set(ord.work_day_id, list);
        }
        for (const [wid, ords] of ordersByWd.entries()) {
          ordersByWorkDay.set(wid, ords);
          setBoundedCacheEntry(orderQueryCache, wid, ords, MAX_SOURCE_CACHE_ENTRIES);
        }
      }
      const allOrderRows: any[] = [];
      for (const wd of workDayRows) {
        allOrderRows.push(...(ordersByWorkDay.get(wd.id) || []));
      }

      const activeOrders = allOrderRows.filter((row) => row.status === "active");
      const cancelledOrders = allOrderRows.filter((row) => row.status === "cancelled");

      if (activeOrders.length > 0 || cancelledOrders.length > 0) {
        let itemsResults: any[][] = [];
        const selectionsByItem = new Map<string, any[]>();

        if (activeOrders.length > 0) {
          const itemsByOrder = new Map<string, any[]>();
          if (!force) {
            for (const order of activeOrders) {
              const cachedItems = orderItemQueryCache.get(order.id);
              if (cachedItems) itemsByOrder.set(order.id, cachedItems);
            }
          }
          const missingOrderIds = force
            ? activeOrders.map((o) => o.id)
            : activeOrders.filter((o) => !orderItemQueryCache.has(o.id)).map((o) => o.id);

          if (missingOrderIds.length > 0) {
            const { rows: fetchedItems } = await pool.query(
              "SELECT * FROM order_items WHERE order_id = ANY($1)",
              [missingOrderIds]
            );
            const itemsByOrd = new Map<string, any[]>();
            for (const oid of missingOrderIds) itemsByOrd.set(oid, []);
            for (const it of fetchedItems) {
              const list = itemsByOrd.get(it.order_id) || [];
              list.push(it);
              itemsByOrd.set(it.order_id, list);
            }
            for (const [oid, its] of itemsByOrd.entries()) {
              itemsByOrder.set(oid, its);
              setBoundedCacheEntry(orderItemQueryCache, oid, its, MAX_SOURCE_CACHE_ENTRIES);
            }
          }

          itemsResults = activeOrders.map((row) => itemsByOrder.get(row.id) || []);

          const allItemIds = itemsResults.flat().map((it: any) => it.id);
          if (allItemIds.length > 0) {
            const { rows: allSelections } = await pool.query(
              "SELECT * FROM order_item_selections WHERE order_item_id = ANY($1) ORDER BY sort_order",
              [allItemIds]
            );
            for (const sel of allSelections) {
              const list = selectionsByItem.get(sel.order_item_id) || [];
              list.push({
                id: sel.id,
                order_item_id: sel.order_item_id,
                selected_product_id: sel.selected_product_id,
                selected_presentation_id: sel.selected_presentation_id,
                product_name_snapshot: sel.product_name_snapshot,
                presentation_name_snapshot: sel.presentation_name_snapshot,
                quantity: Number(sel.quantity),
                sort_order: Number(sel.sort_order ?? 0),
              });
              selectionsByItem.set(sel.order_item_id, list);
            }
          }
        }

        const clientIds = [
          ...new Set([...activeOrders, ...cancelledOrders].map((row) => row.client_id).filter(Boolean)),
        ];

        const clientMap = new Map<string, string>();
        for (const row of clientRows) {
          const name = row.business_name || row.name || row.contact_name || row.owner_name || "Cliente";
          clientMap.set(row.id, name);
          setBoundedCacheEntry(clientNameCache, row.id, name, MAX_CLIENT_NAME_CACHE_ENTRIES);
        }
        const missingClientIds = clientIds.filter((cid) => !clientMap.has(cid));
        if (missingClientIds.length > 0) {
          for (const cid of missingClientIds) {
            const cachedName = clientNameCache.get(cid);
            if (cachedName) clientMap.set(cid, cachedName);
          }
          const uncachedIds = missingClientIds.filter((cid) => !clientMap.has(cid));
          if (uncachedIds.length > 0) {
            const { rows: fetchedClients } = await pool.query(
              "SELECT id, business_name, contact_name FROM clients WHERE id = ANY($1)",
              [uncachedIds]
            );
            for (const c of fetchedClients) {
              clientMap.set(c.id, c.business_name || c.contact_name || "Cliente");
              setBoundedCacheEntry(clientNameCache, c.id, c.business_name || c.contact_name || "Cliente", MAX_CLIENT_NAME_CACHE_ENTRIES);
            }
          }
          for (const cid of missingClientIds) {
            if (!clientMap.has(cid)) clientMap.set(cid, clientNameCache.get(cid) || "Cliente");
          }
        }

        const mappedActiveOrders = activeOrders.map((row, i) => ({
          id: row.id,
          idempotency_key: row.idempotency_key,
          work_day_id: row.work_day_id,
          user_id: row.user_id,
          client_id: row.client_id,
          client_name: clientMap.get(row.client_id) || "Cliente",
          payment_condition: row.payment_condition || "Contado 48h",
          subtotal_cents: Number(row.subtotal_cents ?? 0),
          tax_cents: Number(row.tax_cents ?? 0),
          total_cents: Number(row.total_cents ?? 0),
          item_count: Number(row.item_count ?? 0),
          status: row.status || "active",
          receipt_number: row.receipt_number ?? null,
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: itemsResults[i].map((it: any) => ({
            ...it,
            quantity: Number(it.quantity),
            unit_price_cents_snapshot: Number(it.unit_price_cents_snapshot),
            subtotal_cents: Number(it.subtotal_cents),
            selections: selectionsByItem.get(it.id) || [],
          })),
        }));

        const mappedCancelledOrders = cancelledOrders.map((row) => ({
          id: row.id,
          idempotency_key: row.idempotency_key,
          work_day_id: row.work_day_id,
          user_id: row.user_id,
          client_id: row.client_id,
          client_name: clientMap.get(row.client_id) || "Cliente",
          payment_condition: row.payment_condition || "Contado 48h",
          subtotal_cents: Number(row.subtotal_cents ?? 0),
          tax_cents: Number(row.tax_cents ?? 0),
          total_cents: Number(row.total_cents ?? 0),
          item_count: Number(row.item_count ?? 0),
          status: "cancelled",
          receipt_number: row.receipt_number ?? null,
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: [],
        }));

        orders = [...mappedActiveOrders, ...mappedCancelledOrders];
      }
    }

    const workDayData = todayWorkDayRow
      ? {
          id: todayWorkDayRow.id,
          server_id: todayWorkDayRow.id,
          user_id: todayWorkDayRow.user_id,
          work_date: todayWorkDayRow.work_date,
          status: todayWorkDayRow.status,
          order_count: Number(todayWorkDayRow.order_count ?? 0),
          total_cents: Number(todayWorkDayRow.total_cents ?? 0),
          created_at: todayWorkDayRow.created_at,
          closed_at: todayWorkDayRow.closed_at ?? null,
          auto_closed: todayWorkDayRow.auto_closed === true,
        }
      : null;

    const workDaysData = workDayRows.map((wd: any) => ({
      id: wd.id,
      server_id: wd.id,
      user_id: wd.user_id,
      work_date: wd.work_date,
      status: wd.status,
      order_count: Number(wd.order_count ?? 0),
      total_cents: Number(wd.total_cents ?? 0),
      created_at: wd.created_at,
      closed_at: wd.closed_at ?? null,
      auto_closed: wd.auto_closed === true,
    }));

    const { rows: deletedWorkDays } = await pool.query(
      "SELECT entity_id FROM sync_tombstones WHERE entity_type = 'workday' AND deleted_at > $1",
      [since]
    );

    const hasChanges =
      isInitial ||
      deletedWorkDays.length > 0 ||
      clientRows.length > 0 ||
      productRows.length > 0 ||
      presentations.length > 0 ||
      categoryRows.length > 0 ||
      comboDefRows.length > 0 ||
      comboOptionRows.length > 0 ||
      neighborhoodRows.length > 0 ||
      workDayRows.some((wd: any) => String(wd.updated_at || wd.created_at || "") > since) ||
      orders.some((order) => String(order.updated_at || order.created_at || "") > since);

    const nowIsoStr = new Date().toISOString();
    const responseBody = {
      serverTime: nowIsoStr,
      cursor: nowIsoStr,
      hasChanges,
      refreshThrottled: forceThrottled,
      workDay: workDayData,
      workDays: workDaysData,
      deletedWorkDayIds: deletedWorkDays.map((row: any) => row.entity_id),
      clients: clientRows.map((row: any) => client(row)),
      products: productRows.map((row: any) => product(row)),
      presentations,
      comboDefinitions: comboDefRows.map((row: any) => ({
        id: row.id,
        product_id: row.product_id,
        selection_min: Number(row.selection_min),
        selection_max: Number(row.selection_max),
        active: row.active === false ? 0 : 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      comboOptions: comboOptionRows.map((row: any) => ({
        id: row.id,
        combo_id: row.combo_id,
        presentation_id: row.presentation_id,
        max_quantity: row.max_quantity != null ? Number(row.max_quantity) : null,
        sort_order: Number(row.sort_order ?? 0),
        active: row.active === false ? 0 : 1,
      })),
      comboOptionsComplete: true,
      orders,
      categories: categoryRows.map((row: any) => ({
        id: row.id,
        name: row.name,
        active: row.active === false ? 0 : 1,
        updated_at: row.updated_at,
      })),
      neighborhoods: neighborhoodRows.map((row: any) => ({ ...row, active: 1 })),
    };

    const payload = JSON.stringify(responseBody);
    const etag = `"${simpleHash(payload)}"`;
    if (force) {
      resolveForcedPull?.({ etag, payload });
      forcedPullsInFlight.delete(forcedKey!);
      res.setHeader("ETag", etag);
    } else if (!isInitial) {
      if (pullCache.size >= MAX_PULL_CACHE_ENTRIES) pullCache.delete(pullCache.keys().next().value!);
      pullCache.set(pullKey, { etag, payload });
      res.setHeader("ETag", etag);
    }

    res.json(responseBody);
  } catch (error: any) {
    rejectForcedPull?.(error);
    if (forcedKey) forcedPullsInFlight.delete(forcedKey);
    console.error("Error en sync /pull:", error);
    res.status(500).json({ error: error.message || "Error al sincronizar datos." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Procesador transaccional individual para operaciones de sincronización en lote
// ─────────────────────────────────────────────────────────────────────────────

interface SyncOperationItem {
  id?: string;
  localId?: string;
  local_entity_id?: string;
  entityType?: "client" | "category" | "product" | "order" | "workday";
  entity_type?: "client" | "category" | "product" | "order" | "workday";
  type?: "client" | "category" | "product" | "order" | "workday";
  operation?: "create" | "update" | "cancel" | "delete" | "close" | "reopen";
  action?: "create" | "update" | "cancel" | "delete" | "close" | "reopen";
  data?: any;
  [key: string]: any;
}

interface SyncOperationResult {
  id: string;
  entityType: string;
  status: "synced" | "failed";
  serverId?: string;
  deduped?: boolean;
  action?: string;
  error?: string;
  httpStatus?: number;
  retryable?: boolean;
  workDayId?: string;
  workDay?: Record<string, unknown>;
}

class SyncValidationError extends Error {}

function syncFailureStatus(error: any): number {
  if (error instanceof SyncValidationError || error?.name === "PricingError" || String(error?.code || "").startsWith("23")) return 400;
  return 503;
}

async function syncedOrderResult(client: PoolClient, localId: string, serverId: string, deduped = false): Promise<SyncOperationResult> {
  const { rows } = await client.query(
    "SELECT wd.* FROM work_days wd JOIN orders o ON o.work_day_id = wd.id WHERE o.id = $1",
    [serverId]
  );
  const wd = rows[0];
  return {
    id: localId, serverId, entityType: "order", status: "synced", ...(deduped ? { deduped: true } : {}),
    ...(wd ? { workDayId: wd.id, workDay: {
      id: wd.id, server_id: wd.id, user_id: wd.user_id, work_date: wd.work_date,
      status: wd.status, order_count: Number(wd.order_count ?? 0), total_cents: Number(wd.total_cents ?? 0),
      created_at: wd.created_at, closed_at: wd.closed_at ?? null, auto_closed: wd.auto_closed === true,
    } } : {}),
  };
}

function offlineWorkDate(data: any): string {
  const explicitDate = data.work_date || data.workDate;
  if (explicitDate) {
    const value = String(explicitDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new SyncValidationError("La fecha de la jornada no es válida.");
    }
    return value;
  }
  const capturedAt = data.createdAt || data.created_at;
  if (!capturedAt) return getBoliviaToday();
  const capturedDate = new Date(capturedAt);
  if (!Number.isFinite(capturedDate.getTime())) throw new SyncValidationError("La fecha de captura de la preventa no es válida.");
  return getBoliviaDate(capturedDate);
}

async function processOrderSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  const idempotencyKey = data.idempotencyKey || data.idempotency_key || localId;
  await client.query("SELECT pg_advisory_xact_lock(1003, hashtext($1))", ["workdays:shared"]);
  await client.query("SELECT pg_advisory_xact_lock(1002, hashtext($1))", [idempotencyKey]);
  const action = op.operation || op.action || data.operation || (data.status === "cancelled" ? "cancel" : "create");

  if (action === "cancel" || action === "delete") {
    const targetOrderId = data.serverId || data.server_id || data.id || localId;
    const { rows: existing } = await client.query(
      "SELECT * FROM orders WHERE id = $1 OR idempotency_key = $2 LIMIT 1 FOR UPDATE",
      [targetOrderId, idempotencyKey]
    );
    if (existing.length > 0) {
      const order = existing[0];
      if (order.status === "cancelled") {
        return { id: localId, serverId: order.id, entityType: "order", status: "synced", action: "cancelled", deduped: true };
      }
      // Validate workday is not closed
      const { rows: wdRows } = await client.query("SELECT status FROM work_days WHERE id = $1", [order.work_day_id]);
      if (wdRows.length > 0 && wdRows[0].status === 'closed') {
        throw new SyncValidationError('La jornada está cerrada. No se puede cancelar un pedido de una jornada concluida.');
      }
      await client.query("UPDATE orders SET status = 'cancelled', updated_at = $2 WHERE id = $1", [order.id, nowIso()]);
      await recalcWorkDayTotals(client, order.work_day_id);
      return { id: localId, serverId: order.id, entityType: "order", status: "synced", action: "cancelled" };
    }
    return { id: localId, entityType: "order", status: "synced", action: "cancelled" };
  }

  let orderToUpdate: any = null;
  if (action === "update") {
    const targetOrderId = data.serverId || data.server_id || data.id || localId;
    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = $1 OR idempotency_key = $2 LIMIT 1 FOR UPDATE",
      [targetOrderId, idempotencyKey]
    );
    orderToUpdate = rows[0];
    if (!orderToUpdate) throw new SyncValidationError("Preventa no encontrada.");
    if (orderToUpdate.status !== "active") throw new SyncValidationError("Solo se pueden editar preventas activas.");
  } else {
    const existingOrder = await client.query(
      "SELECT id, user_id FROM orders WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    if (existingOrder.rows.length > 0) {
      return syncedOrderResult(client, localId, existingOrder.rows[0].id, true);
    }
  }

  // Resolver jornada
  const workDayId = orderToUpdate?.work_day_id || data.workDayId || data.work_day_id;
  let wd: any = null;
  if (workDayId) {
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [workDayId]);
    wd = rows[0];
    if (!wd) {
      const deleted = await client.query(
        "SELECT entity_id FROM sync_tombstones WHERE entity_type = 'workday' AND entity_id = $1",
        [workDayId]
      );
      if (deleted.rows.length > 0) throw new SyncValidationError("La jornada fue eliminada. Conserva la preventa pendiente para resolverla antes de sincronizar.");
    }
  }
  if (!wd) {
    if (orderToUpdate) throw new SyncValidationError("Jornada no encontrada.");
    // Intentar resolver por fecha para la jornada compartida del negocio
    const orderDate = offlineWorkDate(data);
    if (orderDate > getBoliviaToday()) throw new SyncValidationError("La jornada tiene una fecha futura. Revisa la fecha del teléfono antes de sincronizar.");
    const { rows } = await client.query(
      "SELECT * FROM work_days WHERE work_date = $1 ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 1 FOR UPDATE",
      [orderDate]
    );
    wd = rows[0];
  }
  if (!wd) {
    // Si no existe ninguna jornada en el servidor para esa fecha, crearla
    const orderDate = offlineWorkDate(data);
    const newWdId = uuid();
    const ts = nowIso();
    const historical = orderDate < getBoliviaToday();
    const { rows: createdWd } = await client.query(
      `INSERT INTO work_days (id, user_id, work_date, status, order_count, total_cents, created_at, updated_at, closed_at, auto_closed)
       VALUES ($1, $2, $3, $5, 0, 0, $4, $4, $6, $7)
       RETURNING *`,
      [newWdId, userId, orderDate, ts, historical ? "closed" : "open", historical ? ts : null, historical]
    );
    wd = createdWd[0];
  }

  // La captura offline debe ser anterior al cierre, con la tolerancia compartida.
  if (wd.status === "closed") {
    if (orderToUpdate) throw new SyncValidationError("La jornada está concluida. Para editar preventas debes reabrir la jornada.");
    const orderCreatedAt = data.createdAt || data.created_at;
    if (!isLegitimateOfflineOrder(wd, orderCreatedAt)) {
      throw new SyncValidationError("La jornada está concluida. Para registrar nuevas preventas debes reabrir la jornada.");
    }
  }

  if (!orderToUpdate && wd.status !== "closed") {
    const otherOpen = await client.query("SELECT id FROM work_days WHERE status = 'open' AND id != $1 LIMIT 1", [wd.id]);
    if (otherOpen.rows.length > 0) throw new SyncValidationError("Hay otra jornada abierta. Resuelve esa jornada antes de registrar preventas.");
  }

  // Resolver cliente
  const clientId = orderToUpdate?.client_id || data.clientId || data.client_id;
  const { rows: clRows } = await client.query(
    "SELECT id, active FROM clients WHERE id = $1 OR client_local_id = $1 LIMIT 1",
    [clientId]
  );
  const clientRow = clRows[0];
  if (!clientRow || (!orderToUpdate && clientRow.active === false)) {
    throw new SyncValidationError("Cliente inválido o inactivo.");
  }

  const rawItems = data.items || [];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
    throw new SyncValidationError("La preventa debe contener entre 1 y 100 productos.");
  }
  if (rawItems.some((rawItem: any) => !rawItem || typeof rawItem !== "object" || Array.isArray(rawItem) ||
      typeof (rawItem.productId || rawItem.product_id) !== "string" ||
      typeof (rawItem.presentationId || rawItem.presentation_id) !== "string")) {
    throw new SyncValidationError("Cada producto debe indicar su producto y presentación.");
  }
  const catalog = await loadOrderCatalog(client, rawItems.map((rawItem: any) => ({
    productId: rawItem.productId || rawItem.product_id,
    presentationId: rawItem.presentationId || rawItem.presentation_id,
    selections: Array.isArray(rawItem.selections) ? rawItem.selections.map((selection: any) => ({
      selectedPresentationId: selection?.selectedPresentationId || selection?.selected_presentation_id,
    })) : [],
  })));

  const processedItems: any[] = [];
  for (const rawItem of rawItems) {
    const prodId = rawItem.productId || rawItem.product_id;
    const presId = rawItem.presentationId || rawItem.presentation_id;
    const qty = Number(rawItem.quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1_000_000) {
      throw new SyncValidationError("La cantidad de cada producto debe ser un entero entre 1 y 1000000.");
    }

    const p = catalog.products.get(prodId), q = catalog.presentations.get(presId);
    if (!p || p.active === false || !q || q.active === false) {
      throw new SyncValidationError(`Producto o presentación no disponibles o inactivos.`);
    }
    if (q.product_id !== prodId) throw new SyncValidationError("La presentación no pertenece a este producto.");

    const selectionsSnapshot: any[] = [];
    if (p.product_type === "combo") {
      const rawSelections = rawItem.selections || [];
      if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
        throw new SyncValidationError(`El producto combo "${p.name}" requiere selecciones.`);
      }
      if (rawSelections.some((selection: any) => !selection || !Number.isSafeInteger(Number(selection.quantity)) || Number(selection.quantity) <= 0 || Number(selection.quantity) > 1_000_000)) {
        throw new SyncValidationError("La cantidad de cada opción debe ser un entero entre 1 y 1000000.");
      }
      const comboDef = catalog.definitions.get(p.id);
      if (!comboDef) throw new SyncValidationError(`El combo "${p.name}" no tiene definición activa.`);
      const comboOpts = catalog.options.filter((option) => option.combo_id === comboDef.id);
      const optMap = new Map<string, any>(comboOpts.map((o: any) => [o.presentation_id, o]));
      const totalUnits = rawSelections.reduce((sum: number, s: any) => sum + Number(s.quantity || 0), 0);

      if (totalUnits < comboDef.selection_min || totalUnits > comboDef.selection_max) {
        throw new SyncValidationError(`La selección para "${p.name}" debe ser entre ${comboDef.selection_min} y ${comboDef.selection_max} unidades.`);
      }

      // Aggregate duplicate selections by presentation
      const aggregatedSelections = new Map<string, any>();
      for (const s of rawSelections) {
        const key = s.selectedPresentationId || s.selected_presentation_id;
        if (aggregatedSelections.has(key)) {
          aggregatedSelections.get(key).quantity += Number(s.quantity || 0);
        } else {
          aggregatedSelections.set(key, { ...s, quantity: Number(s.quantity || 0) });
        }
      }
      const mergedSelections = Array.from(aggregatedSelections.values());

      for (let sIdx = 0; sIdx < mergedSelections.length; sIdx++) {
        const s = mergedSelections[sIdx];
        const sPresId = s.selectedPresentationId || s.selected_presentation_id;
        const sQty = Number(s.quantity);
        const opt = optMap.get(sPresId);
        if (!opt) throw new SyncValidationError("Opción no permitida para este combo.");
        if (opt.max_quantity != null && sQty > opt.max_quantity) {
          throw new SyncValidationError(`Opción seleccionada excede el límite de ${opt.max_quantity}.`);
        }
        const selPres = catalog.selections.get(sPresId);
        if (!selPres) throw new SyncValidationError("Opción de presentación no encontrada.");
        selectionsSnapshot.push({
          id: uuid(),
          selected_product_id: selPres.prod_id,
          selected_presentation_id: sPresId,
          product_name_snapshot: selPres.prod_name,
          presentation_name_snapshot: selPres.pres_name,
          quantity: sQty,
          sort_order: s.sortOrder ?? s.sort_order ?? sIdx,
        });
      }
    } else if (rawItem.selections && (!Array.isArray(rawItem.selections) || rawItem.selections.length > 0)) {
      throw new SyncValidationError(`El producto estándar "${p.name}" no admite selecciones de combo.`);
    }

    const itemUnitPrice =
      rawItem.unitPriceCents != null
        ? Number(rawItem.unitPriceCents)
        : rawItem.unit_price_cents_snapshot != null
        ? Number(rawItem.unit_price_cents_snapshot)
        : q.price_cents;
    if (!Number.isSafeInteger(itemUnitPrice) || itemUnitPrice < 0) {
      throw new SyncValidationError("El precio debe ser un número entero no negativo de centavos.");
    }

    processedItems.push({
      id: uuid(),
      product_id: p.id,
      presentation_id: q.id,
      product_name_snapshot: p.name,
      sku_snapshot: p.sku,
      presentation_name_snapshot: q.name,
      unit_equivalence_snapshot: q.unit_equivalence,
      unit_price_cents_snapshot: itemUnitPrice,
      quantity: qty,
      subtotal_cents: calculateLineSubtotalCents(itemUnitPrice, qty),
      selections: selectionsSnapshot,
    });
  }

  const subtotal = processedItems.reduce((acc, it) => acc + it.subtotal_cents, 0);
  const taxRate = Number(data.taxRatePermille ?? data.tax_rate_permille ?? 0);
  if (!Number.isSafeInteger(taxRate) || taxRate < 0 || taxRate > 1000) throw new SyncValidationError("La tasa de impuesto debe ser un entero entre 0 y 1000.");
  const tax = calculateTaxCents(subtotal, taxRate);
  const total = subtotal + tax;
  const itemCount = processedItems.reduce((acc, it) => acc + it.quantity, 0);

  const paymentCondition = String(data.paymentCondition || data.payment_condition || "Contado 48h").trim();
  if (!paymentCondition || paymentCondition.length > 100) throw new SyncValidationError("Condición de pago inválida.");
  const orderId = orderToUpdate?.id || uuid();
  const orderCreatedAt = data.createdAt || data.created_at;
  const ts = orderCreatedAt && !isNaN(new Date(orderCreatedAt).getTime()) ? new Date(orderCreatedAt).toISOString() : nowIso();
  const serverNow = nowIso();

  if (orderToUpdate) {
    await client.query("DELETE FROM order_item_selections WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)", [orderId]);
    await client.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
    await client.query(
      "UPDATE orders SET payment_condition = $2, tax_rate_permille = $3, subtotal_cents = $4, tax_cents = $5, total_cents = $6, item_count = $7, updated_at = $8 WHERE id = $1",
      [orderId, paymentCondition, taxRate, subtotal, tax, total, itemCount, serverNow]
    );
  } else await client.query(
    `INSERT INTO orders (
       id, idempotency_key, work_day_id, user_id, client_id, payment_condition, tax_rate_permille,
       subtotal_cents, tax_cents, total_cents, item_count, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13)`,
    [orderId, idempotencyKey, wd.id, userId, clientRow.id, paymentCondition, taxRate, subtotal, tax, total, itemCount, ts, serverNow]
  );

  await insertOrderItems(client, orderId, processedItems, ts);

  await recalcWorkDayTotals(client, wd.id);
  return syncedOrderResult(client, localId, orderId);
}

async function processClientSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  if ((op.operation || op.action || data.operation) === "delete") {
    const targetId = data.serverId || data.server_id || data.id || localId;
    const { rows } = await client.query(
      "UPDATE clients SET active = false, updated_at = now() WHERE id = $1 OR client_local_id = $2 RETURNING id",
      [targetId, data.clientLocalId || data.client_local_id || localId]
    );
    return { id: localId, serverId: rows[0]?.id || targetId, entityType: "client", status: "synced", action: "deleted" };
  }
  const businessName = String(data.businessName || data.business_name || data.name || "").trim();
  const contactName = String(data.contactName || data.contact_name || data.ownerName || data.owner_name || "").trim();
  if (!businessName && !contactName) {
    throw new SyncValidationError("Debes ingresar al menos el nombre del negocio o el nombre del propietario.");
  }

  const clientLocalId = data.clientLocalId || data.client_local_id || localId;
  const { rows: existing } = await client.query(
    "SELECT id FROM clients WHERE id = $1 OR client_local_id = $2 LIMIT 1",
    [data.serverId || data.server_id || localId, clientLocalId]
  );

  const neighborhoodId = data.neighborhoodId ?? data.neighborhood_id ?? null;
  if (existing.length > 0) {
    const serverId = existing[0].id;
    await client.query(
      `UPDATE clients SET
         business_name = $1, contact_name = $2,
         phone = $3, address = $4, lat = $5, lng = $6, neighborhood_id = $7, updated_at = now()
       WHERE id = $8`,
      [businessName || null, contactName || null, data.phone ?? null, data.address ?? null, data.lat ?? null, data.lng ?? null, neighborhoodId, serverId]
    );
    return { id: localId, serverId, entityType: "client", status: "synced" };
  }

  const serverId = uuid();
  await client.query(
    `INSERT INTO clients (
       id, client_local_id, business_name, contact_name, phone, address, lat, lng,
       neighborhood_id, visit_status, active, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', true, $10, now(), now())`,
    [serverId, clientLocalId, businessName || null, contactName || null, data.phone ?? null, data.address ?? null, data.lat ?? null, data.lng ?? null, neighborhoodId, userId]
  );
  return { id: localId, serverId, entityType: "client", status: "synced" };
}

async function processCategorySync(client: PoolClient, op: SyncOperationItem): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  if ((op.operation || op.action || data.operation) === "delete") {
    const targetId = data.serverId || data.server_id || data.id || localId;
    await client.query("UPDATE categories SET active = false, updated_at = now() WHERE id = $1", [targetId]);
    return { id: localId, serverId: targetId, entityType: "category", status: "synced", action: "deleted" };
  }
  const name = String(data.name || "").trim();
  if (!name) throw new SyncValidationError("El nombre de la categoría es obligatorio.");

  // [M-05] Si el nombre enviado es un UUID, no crear una categoría con nombre UUID
  if (UUID_REGEX.test(name)) {
    return { id: localId, entityType: "category", status: "synced" };
  }

  const targetId = data.serverId || data.server_id || localId;
  const { rows: existing } = await client.query("SELECT id FROM categories WHERE id = $1 OR LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1", [targetId, name]);
  if (existing.length > 0) {
    const serverId = existing[0].id;
    await client.query("UPDATE categories SET name = $1, active = true, updated_at = now() WHERE id = $2", [name, serverId]);
    return { id: localId, serverId, entityType: "category", status: "synced" };
  }

  const serverId = UUID_REGEX.test(targetId) ? targetId : uuid();
  await client.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, now(), now())", [serverId, name]);
  return { id: localId, serverId, entityType: "category", status: "synced" };
}

async function processProductSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  if ((op.operation || op.action || data.operation) === "delete") {
    const targetId = data.serverId || data.server_id || data.id || localId;
    await client.query("UPDATE products SET active = false, updated_at = now() WHERE id = $1", [targetId]);
    return { id: localId, serverId: targetId, entityType: "product", status: "synced", action: "deleted" };
  }
  const name = String(data.name || "").trim();
  const sku = String(data.sku || "").trim().toUpperCase();
  if (!name || !sku) throw new SyncValidationError("Nombre y SKU son obligatorios.");

  const baseCost = Math.max(0, Number(data.baseCostCents ?? data.base_cost_cents ?? 0));
  const productType = data.productType || data.product_type || "standard";

  // [M-05] Resolver categoría sin crear nombres que sean cadenas UUID
  const targetCategoryId = await resolveCategoryId(
    client,
    data.categoryId || data.category_id || null,
    data.categoryName || data.category_name || null
  );

  const targetId = data.serverId || data.server_id || localId;
  const { rows: existing } = await client.query(
    "SELECT id, active FROM products WHERE id = $1 OR sku = $2 OR lower(name) = lower($3) LIMIT 1",
    [targetId, sku, name]
  );

  let serverId = targetId;
  const isExisting = existing.length > 0;
  if (isExisting) {
    serverId = existing[0].id;
    // [M-06] Reactivar si estaba inactivo y actualizar sus datos
    await client.query(
      `UPDATE products SET name = $1, sku = $2, base_cost_cents = $3, product_type = $4, category_id = $5, active = true, updated_at = now()
       WHERE id = $6`,
      [name, sku, baseCost, productType, targetCategoryId, serverId]
    );
  } else {
    serverId = UUID_REGEX.test(targetId) ? targetId : uuid();
    await client.query(
      `INSERT INTO products (id, sku, name, category_id, base_cost_cents, base_unit_name, product_type, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, now(), now())`,
      [serverId, sku, name, targetCategoryId, baseCost, data.baseUnitName || data.base_unit_name || "Unidad", productType, userId]
    );
  }

  // Los ID del servidor permiten renombrar sin invalidar opciones de otros combos.
  const rawPresentations = data.presentations;
  if (Array.isArray(rawPresentations) && rawPresentations.length > 0) {
    const presentations = rawPresentations.map((pres: any) => ({
      id: pres.id || pres.serverId || pres.server_id || undefined,
      localId: pres.localId || pres.local_id || undefined,
      name: String(pres.name || "").trim(),
      priceCents: Number(pres.priceCents ?? pres.price_cents ?? 0),
      costCents: Number(pres.costCents ?? pres.cost_cents ?? 0),
      unitEquivalence: Number(pres.unitEquivalence ?? pres.unit_equivalence ?? 1),
    }));
    if (presentations.some((pres: any) => !pres.name || !Number.isSafeInteger(pres.priceCents) || pres.priceCents < 0 ||
      !Number.isSafeInteger(pres.costCents) || pres.costCents < 0 || !Number.isSafeInteger(pres.unitEquivalence) || pres.unitEquivalence < 1)) {
      throw new SyncValidationError("Datos de presentación inválidos.");
    }
    try {
      await syncProductPresentations(client, serverId, presentations, nowIso());
    } catch (error) {
      throw new SyncValidationError(error instanceof Error ? error.message : "Presentaciones inválidas.");
    }
  }

  // Combos
  const comboDef = data.comboDefinition || data.combo_definition;
  if (comboDef && productType === "combo") {
    const selMin = Number(comboDef.selectionMin ?? comboDef.selection_min ?? 1);
    const selMax = Number(comboDef.selectionMax ?? comboDef.selection_max ?? selMin);
    const options = comboDef.options || [];

    // a. DELETE existing combo_options for this product's combo_definitions
    await client.query(
      "DELETE FROM combo_options WHERE combo_id IN (SELECT id FROM combo_definitions WHERE product_id = $1)",
      [serverId]
    );

    // b. DELETE existing combo_definitions for this product
    await client.query("DELETE FROM combo_definitions WHERE product_id = $1", [serverId]);

    // c. INSERT into combo_definitions (id, product_id, selection_min, selection_max, active, created_at, updated_at)
    const comboDefId = comboDef.id || uuid();
    const ts = nowIso();
    await client.query(
      `INSERT INTO combo_definitions (id, product_id, selection_min, selection_max, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $5)`,
      [comboDefId, serverId, selMin, selMax, ts]
    );

    // d. For each option, INSERT into combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active, created_at, updated_at)
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const optId = opt.id || uuid();
      const presId = opt.presentationId || opt.presentation_id;
      const maxQty = opt.maxQuantity ?? opt.max_quantity ?? null;
      const sortOrder = opt.sortOrder ?? opt.sort_order ?? i;
      await client.query(
        `INSERT INTO combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)`,
        [optId, comboDefId, presId, maxQty != null ? Number(maxQty) : null, sortOrder, ts]
      );
    }
  }

  return { id: localId, serverId, entityType: "product", status: "synced", deduped: isExisting };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/push & POST /api/sync — Carga atómica de lotes offline
// ─────────────────────────────────────────────────────────────────────────────

syncRouter.post(["/push", "/"], async (req: AuthedRequest, res, next) => {
  const body = req.body || {};
  const rawOperations: SyncOperationItem[] = [];

  if (Array.isArray(body)) {
    rawOperations.push(...body);
  } else if (Array.isArray(body.operations)) {
    rawOperations.push(...body.operations);
  } else if (Array.isArray(body.items)) {
    rawOperations.push(...body.items);
  } else {
    // Extraer por dominios y ordenar por dependencias: categorías -> clientes -> productos -> pedidos
    if (Array.isArray(body.categories)) {
      body.categories.forEach((c: any) => rawOperations.push({ ...c, entityType: "category", operation: c.operation || c.action || "create" }));
    }
    if (Array.isArray(body.clients)) {
      body.clients.forEach((c: any) => rawOperations.push({ ...c, entityType: "client", operation: c.operation || c.action || "create" }));
    }
    if (Array.isArray(body.products)) {
      body.products.forEach((p: any) => rawOperations.push({ ...p, entityType: "product", operation: p.operation || p.action || "create" }));
    }
    if (Array.isArray(body.orders)) {
      body.orders.forEach((o: any) => rawOperations.push({ ...o, entityType: "order", operation: o.operation || o.action || (o.status === "cancelled" ? "cancel" : "create") }));
    }
  }

  // Resuelve categorías antes de productos y padres antes de preventas,
  // también cuando el cliente manda un array de operaciones desordenado.
  const sortedOps = [...rawOperations].sort((a, b) => {
    const typeA = a.entityType || a.entity_type || a.type;
    const typeB = b.entityType || b.entity_type || b.type;
    const priorities: Record<string, number> = { category: 1, client: 2, product: 3, order: 4 };
    const prioA = priorities[typeA || "order"] ?? 5;
    const prioB = priorities[typeB || "order"] ?? 5;
    return prioA - prioB;
  });

  const results: SyncOperationResult[] = [];
  let hasModifications = false;

  let batchClient: PoolClient;
  try {
    batchClient = await pool.connect();
  } catch (error) {
    return next(error);
  }
  try {
    await batchClient.query("BEGIN");
    for (const op of sortedOps) {
      const entityType = op.entityType || op.entity_type || op.type || "order";
      const opId = op.id || op.local_entity_id || op.localId || uuid();
      const savepointName = `sp_${results.length}`;
      try {
        await batchClient.query(`SAVEPOINT ${savepointName}`);
        let result: SyncOperationResult;
        if (entityType === "client") {
          result = await processClientSync(batchClient, op, req.userId!);
        } else if (entityType === "category") {
          result = await processCategorySync(batchClient, op);
        } else if (entityType === "product") {
          result = await processProductSync(batchClient, op, req.userId!);
        } else if (entityType === "order") {
          result = await processOrderSync(batchClient, op, req.userId!);
        } else {
          throw new SyncValidationError("Tipo de entidad de sincronización no soportado.");
        }
        await batchClient.query(`RELEASE SAVEPOINT ${savepointName}`);
        results.push(result);
        if (result.status === "synced") hasModifications = true;
      } catch (err: any) {
        try {
          await batchClient.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch {}
        results.push({
          id: opId,
          entityType,
          status: "failed",
          error: err.message || "Error al procesar la operación de sincronización.",
          httpStatus: syncFailureStatus(err),
          retryable: syncFailureStatus(err) >= 500,
        });
      }
    }
    await batchClient.query("COMMIT");
  } catch (batchErr) {
    try {
      await batchClient.query("ROLLBACK");
    } catch {}
    return next(batchErr);
  } finally {
    batchClient.release();
  }

  if (hasModifications) {
    invalidatePullCache("all");
    invalidateWorkdayCache();
  }

  const succeededCount = results.filter((r) => r.status === "synced").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  res.json({
    ok: true,
    processed: results.length,
    succeeded: succeededCount,
    failed: failedCount,
    results,
  });
});

syncRouter.get("/ping", (_req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

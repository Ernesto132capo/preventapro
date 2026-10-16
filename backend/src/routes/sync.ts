import { Router } from "express";
import { v4 as uuid } from "uuid";
import { PoolClient } from "pg";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { calculateLineSubtotalCents, calculateTaxCents } from "../services/pricing";
import { closeStaleOpenWorkDays, invalidateWorkdayCache } from "./workdays";

export const syncRouter = Router();
syncRouter.use(requireAuth);

function today() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/La_Paz",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

function client(row: any) {
  return {
    id: row.id,
    client_local_id: row.client_local_id ?? null,
    business_name: row.business_name,
    contact_name: row.contact_name ?? null,
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
const MAX_PULL_CACHE_ENTRIES = 100;
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
let lastRealForceFetchAt = 0;

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
    const since = req.query.since ? String(req.query.since) : "1970-01-01T00:00:00.000Z";
    const pullKey = `${req.userId}:${since}`;
    const isInitial = !req.query.since || since.startsWith("1970");
    const requestedForce = req.query.force === "1";

    const now = Date.now();
    const forceThrottled = requestedForce && now - lastRealForceFetchAt < FORCE_TTL_MS;
    const force = requestedForce && !forceThrottled;
    if (force) lastRealForceFetchAt = now;

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

    const todayDate = today();

    // Auto-cerrar jornadas pasadas abiertas para mantener consistencia con workdays.ts
    const cleanupClient = await pool.connect();
    try {
      const closedStale = await closeStaleOpenWorkDays(todayDate, req.userId!, cleanupClient);
      if (closedStale) {
        invalidatePullCache("workdays");
        invalidateWorkdayCache();
      }
    } finally {
      cleanupClient.release();
    }

    const cursorKey = isInitial ? "__initial__" : since;
    const [clientRows, productRows, categoryRows, neighborhoodRows, todayWorkDayRows, comboDefRows, comboOptionRows] =
      await Promise.all([
        cachedRows(
          "clients",
          clientQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM clients WHERE active = true")).rows
              : (await pool.query("SELECT * FROM clients WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "products",
          productQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM products WHERE active = true")).rows
              : (await pool.query("SELECT * FROM products WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "categories",
          categoryQueryCache,
          cursorKey,
          async () => (await pool.query("SELECT * FROM categories WHERE active = true ORDER BY name")).rows,
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
          `${req.userId}:${todayDate}`,
          async () =>
            (await pool.query("SELECT * FROM work_days WHERE user_id = $1 AND work_date = $2", [req.userId, todayDate])).rows,
          force
        ),
        cachedRows(
          "combo_definitions",
          comboDefQueryCache,
          cursorKey,
          async () =>
            isInitial
              ? (await pool.query("SELECT * FROM combo_definitions WHERE active = true")).rows
              : (await pool.query("SELECT * FROM combo_definitions WHERE updated_at > $1", [since])).rows,
          force
        ),
        cachedRows(
          "combo_options",
          comboOptionQueryCache,
          cursorKey,
          async () => (await pool.query("SELECT * FROM combo_options WHERE active = true ORDER BY sort_order")).rows,
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
                "SELECT id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at FROM product_presentations WHERE active = true"
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

    const sortedTodayRows = [...todayWorkDayRows].sort((a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
    );
    const todayWorkDayRow = sortedTodayRows[0] || null;

    let orders: any[] = [];
    if (todayWorkDayRow) {
      const orderRows = await cachedRows(
        "orders",
        orderQueryCache,
        todayWorkDayRow.id,
        async () => (await pool.query("SELECT * FROM orders WHERE work_day_id = $1", [todayWorkDayRow.id])).rows,
        force
      );
      const activeOrders = orderRows.filter((row) => row.status === "active");

      if (activeOrders.length > 0) {
        const [itemsResults, clientIds] = [
          await Promise.all(
            activeOrders.map((row) =>
              cachedRows(
                "order-items",
                orderItemQueryCache,
                row.id,
                async () => (await pool.query("SELECT * FROM order_items WHERE order_id = $1", [row.id])).rows,
                force
              )
            )
          ),
          [...new Set(activeOrders.map((row) => row.client_id))],
        ];

        const allItemIds = itemsResults.flat().map((it: any) => it.id);
        const selectionsByItem = new Map<string, any[]>();
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

        const clientMap = new Map<string, string>();
        for (const row of clientRows) {
          const name = row.business_name || "Cliente";
          clientMap.set(row.id, name);
          setBoundedCacheEntry(clientNameCache, row.id, name, MAX_CLIENT_NAME_CACHE_ENTRIES);
        }
        const missingClientIds = clientIds.filter((cid) => !clientMap.has(cid));
        if (missingClientIds.length > 0) {
          const uncachedIds = missingClientIds.filter((cid) => !clientNameCache.has(cid));
          if (uncachedIds.length > 0) {
            const { rows: fetchedClients } = await pool.query(
              "SELECT id, business_name FROM clients WHERE id = ANY($1)",
              [uncachedIds]
            );
            for (const c of fetchedClients) {
              setBoundedCacheEntry(clientNameCache, c.id, c.business_name || "Cliente", MAX_CLIENT_NAME_CACHE_ENTRIES);
            }
          }
          for (const cid of missingClientIds) {
            clientMap.set(cid, clientNameCache.get(cid) || "Cliente");
          }
        }

        orders = activeOrders.map((row, i) => ({
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

    const hasChanges =
      isInitial ||
      clientRows.length > 0 ||
      productRows.length > 0 ||
      presentations.length > 0 ||
      categoryRows.length > 0 ||
      comboDefRows.length > 0 ||
      comboOptionRows.length > 0 ||
      neighborhoodRows.length > 0 ||
      Boolean(todayWorkDayRow && String(todayWorkDayRow.updated_at || todayWorkDayRow.created_at || "") > since) ||
      orders.some((order) => String(order.updated_at || order.created_at || "") > since);

    const nowIsoStr = new Date().toISOString();
    const responseBody = {
      serverTime: nowIsoStr,
      cursor: nowIsoStr,
      hasChanges,
      refreshThrottled: forceThrottled,
      workDay: workDayData,
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
}

async function processOrderSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  const action = op.operation || op.action || data.operation || (data.status === "cancelled" ? "cancel" : "create");

  if (action === "cancel") {
    const targetOrderId = data.serverId || data.server_id || data.id || localId;
    const { rows: existing } = await client.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [targetOrderId, userId]
    );
    if (existing.length > 0) {
      const order = existing[0];
      await client.query("UPDATE orders SET status = 'cancelled', updated_at = $2 WHERE id = $1", [order.id, nowIso()]);
      await recalcWorkDayTotals(client, order.work_day_id);
      return { id: localId, serverId: order.id, entityType: "order", status: "synced", action: "cancelled" };
    }
    return { id: localId, entityType: "order", status: "synced", action: "cancelled" };
  }

  const idempotencyKey = data.idempotencyKey || data.idempotency_key || localId;
  const existingOrder = await client.query(
    "SELECT id, user_id FROM orders WHERE idempotency_key = $1 LIMIT 1",
    [idempotencyKey]
  );
  if (existingOrder.rows.length > 0) {
    return { id: localId, serverId: existingOrder.rows[0].id, entityType: "order", status: "synced", deduped: true };
  }

  // Resolver jornada
  let workDayId = data.workDayId || data.work_day_id;
  let wd: any = null;
  if (workDayId) {
    const { rows } = await client.query("SELECT * FROM work_days WHERE id = $1 FOR UPDATE", [workDayId]);
    wd = rows[0];
  }
  if (!wd) {
    // Intentar resolver por fecha y usuario
    const orderDate = data.work_date || (data.createdAt ? String(data.createdAt).slice(0, 10) : today());
    const { rows } = await client.query(
      "SELECT * FROM work_days WHERE user_id = $1 AND work_date = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [userId, orderDate]
    );
    wd = rows[0];
  }
  if (!wd) {
    throw new Error("No se encontró la jornada asociada para esta preventa.");
  }

  // Regla de jornada cerrada: admitir pedidos legítimos tomados offline antes del cierre
  if (wd.status === "closed") {
    const orderCreatedAt = data.createdAt || data.created_at;
    const isLegitimateOfflineOrder = Boolean(
      orderCreatedAt &&
      (!wd.closed_at || new Date(orderCreatedAt).getTime() <= new Date(wd.closed_at).getTime() + 15 * 60 * 1000)
    );
    if (!isLegitimateOfflineOrder) {
      throw new Error("La jornada está concluida. Para registrar nuevas preventas debes reabrir la jornada.");
    }
  }

  // Resolver cliente
  const clientId = data.clientId || data.client_id;
  const { rows: clRows } = await client.query(
    "SELECT id, active FROM clients WHERE id = $1 OR client_local_id = $1 LIMIT 1",
    [clientId]
  );
  const clientRow = clRows[0];
  if (!clientRow || clientRow.active === false) {
    throw new Error("Cliente inválido o inactivo.");
  }

  const rawItems = data.items || [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("La preventa debe contener al menos un producto.");
  }

  const processedItems: any[] = [];
  for (const rawItem of rawItems) {
    const prodId = rawItem.productId || rawItem.product_id;
    const presId = rawItem.presentationId || rawItem.presentation_id;
    const qty = Number(rawItem.quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new Error("La cantidad de cada producto debe ser un entero mayor a 0.");
    }

    const { rows: pRows } = await client.query("SELECT id, name, sku, product_type, active FROM products WHERE id = $1", [prodId]);
    const { rows: qRows } = await client.query(
      "SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE id = $1",
      [presId]
    );
    const p = pRows[0], q = qRows[0];
    if (!p || p.active === false || !q || q.active === false) {
      throw new Error(`Producto o presentación no disponibles o inactivos.`);
    }

    const selectionsSnapshot: any[] = [];
    if (p.product_type === "combo") {
      const rawSelections = rawItem.selections || [];
      if (!rawSelections || rawSelections.length === 0) {
        throw new Error(`El producto combo "${p.name}" requiere selecciones.`);
      }
      const { rows: comboDefs } = await client.query(
        "SELECT * FROM combo_definitions WHERE product_id = $1 AND active = true LIMIT 1",
        [p.id]
      );
      if (comboDefs.length === 0) throw new Error(`El combo "${p.name}" no tiene definición activa.`);
      const comboDef = comboDefs[0];

      const { rows: comboOpts } = await client.query(
        "SELECT * FROM combo_options WHERE combo_id = $1 AND active = true",
        [comboDef.id]
      );
      const optMap = new Map<string, any>(comboOpts.map((o: any) => [o.presentation_id, o]));
      const totalUnits = rawSelections.reduce((sum: number, s: any) => sum + Number(s.quantity || 0), 0);

      if (totalUnits < comboDef.selection_min || totalUnits > comboDef.selection_max) {
        throw new Error(`La selección para "${p.name}" debe ser entre ${comboDef.selection_min} y ${comboDef.selection_max} unidades.`);
      }

      for (let sIdx = 0; sIdx < rawSelections.length; sIdx++) {
        const s = rawSelections[sIdx];
        const sPresId = s.selectedPresentationId || s.selected_presentation_id;
        const sQty = Number(s.quantity);
        const opt = optMap.get(sPresId);
        if (!opt) throw new Error("Opción no permitida para este combo.");
        if (opt.max_quantity != null && sQty > opt.max_quantity) {
          throw new Error(`Opción seleccionada excede el límite de ${opt.max_quantity}.`);
        }
        const { rows: selPres } = await client.query(
          "SELECT pp.name as pres_name, p.name as prod_name, p.id as prod_id FROM product_presentations pp JOIN products p ON pp.product_id = p.id WHERE pp.id = $1",
          [sPresId]
        );
        if (selPres.length === 0) throw new Error("Opción de presentación no encontrada.");
        selectionsSnapshot.push({
          id: uuid(),
          selected_product_id: selPres[0].prod_id,
          selected_presentation_id: sPresId,
          product_name_snapshot: selPres[0].prod_name,
          presentation_name_snapshot: selPres[0].pres_name,
          quantity: sQty,
          sort_order: s.sortOrder ?? s.sort_order ?? sIdx,
        });
      }
    }

    processedItems.push({
      id: uuid(),
      product_id: p.id,
      presentation_id: q.id,
      product_name_snapshot: p.name,
      sku_snapshot: p.sku,
      presentation_name_snapshot: q.name,
      unit_equivalence_snapshot: q.unit_equivalence,
      unit_price_cents_snapshot: q.price_cents,
      quantity: qty,
      subtotal_cents: calculateLineSubtotalCents(q.price_cents, qty),
      selections: selectionsSnapshot,
    });
  }

  const subtotal = processedItems.reduce((acc, it) => acc + it.subtotal_cents, 0);
  const taxRate = Number(data.taxRatePermille ?? data.tax_rate_permille ?? 0);
  const tax = calculateTaxCents(subtotal, taxRate);
  const total = subtotal + tax;
  const itemCount = processedItems.reduce((acc, it) => acc + it.quantity, 0);

  const orderId = uuid();
  const orderCreatedAt = data.createdAt || data.created_at;
  const ts = orderCreatedAt && !isNaN(new Date(orderCreatedAt).getTime()) ? new Date(orderCreatedAt).toISOString() : nowIso();

  await client.query(
    `INSERT INTO orders (
       id, idempotency_key, work_day_id, user_id, client_id, payment_condition, tax_rate_permille,
       subtotal_cents, tax_cents, total_cents, item_count, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $12)`,
    [orderId, idempotencyKey, wd.id, userId, clientRow.id, data.paymentCondition || data.payment_condition || "Contado 48h", taxRate, subtotal, tax, total, itemCount, ts]
  );

  for (const it of processedItems) {
    await client.query(
      `INSERT INTO order_items (
         id, order_id, product_id, presentation_id, product_name_snapshot, sku_snapshot,
         presentation_name_snapshot, unit_equivalence_snapshot, unit_price_cents_snapshot, quantity, subtotal_cents, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [it.id, orderId, it.product_id, it.presentation_id, it.product_name_snapshot, it.sku_snapshot, it.presentation_name_snapshot, it.unit_equivalence_snapshot, it.unit_price_cents_snapshot, it.quantity, it.subtotal_cents, ts]
    );
    for (const sel of it.selections) {
      await client.query(
        `INSERT INTO order_item_selections (
           id, order_item_id, selected_product_id, selected_presentation_id, product_name_snapshot,
           presentation_name_snapshot, quantity, sort_order, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuid(), it.id, sel.selected_product_id, sel.selected_presentation_id, sel.product_name_snapshot, sel.presentation_name_snapshot, sel.quantity, sel.sort_order, ts]
      );
    }
  }

  await recalcWorkDayTotals(client, wd.id);
  return { id: localId, serverId: orderId, entityType: "order", status: "synced" };
}

async function processClientSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  const businessName = String(data.businessName || data.business_name || "").trim();
  if (!businessName) throw new Error("El nombre comercial es obligatorio.");

  const clientLocalId = data.clientLocalId || data.client_local_id || localId;
  const { rows: existing } = await client.query(
    "SELECT id FROM clients WHERE id = $1 OR client_local_id = $2 LIMIT 1",
    [data.serverId || data.server_id || localId, clientLocalId]
  );

  if (existing.length > 0) {
    const serverId = existing[0].id;
    await client.query(
      `UPDATE clients SET business_name = $1, contact_name = $2, phone = $3, address = $4, lat = $5, lng = $6, updated_at = now()
       WHERE id = $7`,
      [businessName, data.contactName ?? data.contact_name ?? null, data.phone ?? null, data.address ?? null, data.lat ?? null, data.lng ?? null, serverId]
    );
    return { id: localId, serverId, entityType: "client", status: "synced" };
  }

  const serverId = uuid();
  await client.query(
    `INSERT INTO clients (
       id, client_local_id, business_name, contact_name, phone, address, lat, lng, visit_status, active, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', true, $9, now(), now())`,
    [serverId, clientLocalId, businessName, data.contactName ?? data.contact_name ?? null, data.phone ?? null, data.address ?? null, data.lat ?? null, data.lng ?? null, userId]
  );
  return { id: localId, serverId, entityType: "client", status: "synced" };
}

async function processCategorySync(client: PoolClient, op: SyncOperationItem): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  const name = String(data.name || "").trim();
  if (!name) throw new Error("El nombre de la categoría es obligatorio.");

  const targetId = data.serverId || data.server_id || localId;
  const { rows: existing } = await client.query("SELECT id FROM categories WHERE id = $1 OR name = $2 LIMIT 1", [targetId, name]);
  if (existing.length > 0) {
    const serverId = existing[0].id;
    await client.query("UPDATE categories SET name = $1, active = true, updated_at = now() WHERE id = $2", [name, serverId]);
    return { id: localId, serverId, entityType: "category", status: "synced" };
  }

  const serverId = uuid();
  await client.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, now(), now())", [serverId, name]);
  return { id: localId, serverId, entityType: "category", status: "synced" };
}

async function processProductSync(client: PoolClient, op: SyncOperationItem, userId: string): Promise<SyncOperationResult> {
  const localId = op.id || op.local_entity_id || op.localId || uuid();
  const data = op.data || op;
  const name = String(data.name || "").trim();
  const sku = String(data.sku || "").trim().toUpperCase();
  if (!name || !sku) throw new Error("Nombre y SKU son obligatorios.");

  const baseCost = Math.max(0, Number(data.baseCostCents ?? data.base_cost_cents ?? 0));
  const productType = data.productType || data.product_type || "standard";

  const targetId = data.serverId || data.server_id || localId;
  const { rows: existing } = await client.query("SELECT id FROM products WHERE id = $1 OR sku = $2 LIMIT 1", [targetId, sku]);

  let serverId = targetId;
  if (existing.length > 0) {
    serverId = existing[0].id;
    await client.query(
      `UPDATE products SET name = $1, sku = $2, base_cost_cents = $3, product_type = $4, category_id = $5, active = true, updated_at = now()
       WHERE id = $6`,
      [name, sku, baseCost, productType, data.categoryId || data.category_id || null, serverId]
    );
  } else {
    serverId = uuid();
    await client.query(
      `INSERT INTO products (id, sku, name, category_id, base_cost_cents, base_unit_name, product_type, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, now(), now())`,
      [serverId, sku, name, data.categoryId || data.category_id || null, baseCost, data.baseUnitName || data.base_unit_name || "Unidad", productType, userId]
    );
  }

  // Presentaciones
  const rawPresentations = data.presentations || [];
  for (const pres of rawPresentations) {
    const presName = String(pres.name || "").trim();
    if (!presName) continue;
    const priceCents = Math.max(0, Number(pres.priceCents ?? pres.price_cents ?? 0));
    const costCents = Math.max(0, Number(pres.costCents ?? pres.cost_cents ?? 0));
    const equiv = Math.max(1, Number(pres.unitEquivalence ?? pres.unit_equivalence ?? 1));
    const presTargetId = pres.id || pres.serverId || uuid();

    await client.query(
      `INSERT INTO product_presentations (id, product_id, name, unit_equivalence, price_cents, cost_cents, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now())
       ON CONFLICT (product_id, name) DO UPDATE SET
         price_cents = excluded.price_cents, cost_cents = excluded.cost_cents, unit_equivalence = excluded.unit_equivalence,
         active = true, updated_at = now()`,
      [presTargetId, serverId, presName, equiv, priceCents, costCents]
    );
  }

  return { id: localId, serverId, entityType: "product", status: "synced" };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/push & POST /api/sync — Carga atómica de lotes offline
// ─────────────────────────────────────────────────────────────────────────────

syncRouter.post(["/push", "/"], async (req: AuthedRequest, res) => {
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
      body.categories.forEach((c: any) => rawOperations.push({ ...c, entityType: "category", operation: "create" }));
    }
    if (Array.isArray(body.clients)) {
      body.clients.forEach((c: any) => rawOperations.push({ ...c, entityType: "client", operation: "create" }));
    }
    if (Array.isArray(body.products)) {
      body.products.forEach((p: any) => rawOperations.push({ ...p, entityType: "product", operation: "create" }));
    }
    if (Array.isArray(body.orders)) {
      body.orders.forEach((o: any) => rawOperations.push({ ...o, entityType: "order", operation: "create" }));
    }
  }

  // Ordenamiento por prioridad: category (1), client (1), product (1), order (2)
  const sortedOps = [...rawOperations].sort((a, b) => {
    const typeA = a.entityType || a.entity_type || a.type;
    const typeB = b.entityType || b.entity_type || b.type;
    const prioA = typeA === "order" ? 2 : 1;
    const prioB = typeB === "order" ? 2 : 1;
    return prioA - prioB;
  });

  const results: SyncOperationResult[] = [];
  let hasModifications = false;

  for (const op of sortedOps) {
    const entityType = op.entityType || op.entity_type || op.type || "order";
    const opId = op.id || op.local_entity_id || op.localId || uuid();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let result: SyncOperationResult;
      if (entityType === "client") {
        result = await processClientSync(client, op, req.userId!);
      } else if (entityType === "category") {
        result = await processCategorySync(client, op);
      } else if (entityType === "product") {
        result = await processProductSync(client, op, req.userId!);
      } else {
        result = await processOrderSync(client, op, req.userId!);
      }
      await client.query("COMMIT");
      results.push(result);
      if (result.status === "synced") hasModifications = true;
    } catch (err: any) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      // Aislamiento de fallos: un ítem rechazado no aborta el lote completo
      results.push({
        id: opId,
        entityType,
        status: "failed",
        error: err.message || "Error al procesar la operación de sincronización.",
      });
    } finally {
      client.release();
    }
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

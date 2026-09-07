import { Router } from "express";
import { pool } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const syncRouter = Router();
syncRouter.use(requireAuth);

function client(row: any) { return { id: row.id, client_local_id: row.client_local_id ?? null, business_name: row.business_name, contact_name: row.contact_name ?? null, phone: row.phone ?? null, neighborhood_id: row.neighborhood_id ?? null, address: row.address ?? null, lat: row.lat ?? null, lng: row.lng ?? null, visit_status: row.visit_status ?? "pending", active: row.active === false ? 0 : 1, created_at: row.created_at, updated_at: row.updated_at }; }
function product(row: any) { return { id: row.id, sku: row.sku, name: row.name, category_id: row.category_id ?? null, photo_url: row.photo_url ?? null, base_cost_cents: row.base_cost_cents ?? 0, base_unit_name: row.base_unit_name ?? "Unidad", active: row.active === false ? 0 : 1, created_at: row.created_at, updated_at: row.updated_at }; }
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
// Cada cursor `since` tiene su propia respuesta. Nunca debemos reutilizar una
// respuesta generada para un cursor distinto: podría ocultar cambios a otro
// teléfono. Las mutaciones locales invalidan todo el mapa inmediatamente.
interface PullCache {
  etag: string;
  payload: string;
}
const pullCache = new Map<string, PullCache>();
const MAX_PULL_CACHE_ENTRIES = 100;
type PullDomain = "all" | "clients" | "products" | "orders" | "workdays";

// Cachés de fuentes individuales. Aunque una mutación obligue a reconstruir el
// payload de /pull, las tablas que no cambiaron siguen sin tocar Postgres.
const clientQueryCache = new Map<string, any[]>();
const productQueryCache = new Map<string, any[]>();
const presentationQueryCache = new Map<string, any[]>();
const categoryQueryCache = new Map<string, any[]>();
const neighborhoodQueryCache = new Map<string, any[]>();
const workdayQueryCache = new Map<string, any[]>();
const orderQueryCache = new Map<string, any[]>();
const orderItemQueryCache = new Map<string, any[]>();
const clientNameCache = new Map<string, string>();
const sourceReadsInFlight = new Map<string, Promise<any[]>>();
const forcedPullsInFlight = new Map<string, Promise<PullCache>>();

async function cachedRows(domain: string, cache: Map<string, any[]>, key: string, load: () => Promise<any[]>, force = false): Promise<any[]> {
  if (!force && cache.has(key)) return cache.get(key)!;
  const flightKey = `${domain}:${key}`;
  const inFlight = sourceReadsInFlight.get(flightKey);
  if (inFlight) return inFlight;
  const task = load().then((rows) => { cache.set(key, rows); return rows; });
  sourceReadsInFlight.set(flightKey, task);
  try { return await task; } finally { sourceReadsInFlight.delete(flightKey); }
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

// ─── TTL para el flag `force=1` ────────────────────────────────────────────────
// `force=1` existe para el botón de refresh manual: debe traer datos frescos.
// Pero sin límite, una ráfaga de taps (o un retry en loop) multiplica lecturas
// reales a Postgres aunque nada haya cambiado. Con este TTL, un force=1 que
// llega a menos de FORCE_TTL_MS del último force real se atiende como un pull
// normal (con caché en memoria, cero queries nuevas), sin dejar de ser
// "fresco" — porque la única forma de que la caché tenga datos viejos de
// verdad es que nadie la haya invalidado, y eso solo pasa cuando SÍ hay una
// mutación crítica (crear/editar cliente, producto, preventa, jornada), lo
// cual limpia su caché de inmediato sin importar este TTL.
const FORCE_TTL_MS = Number(process.env.SYNC_FORCE_TTL_MS) || 45_000;
let lastRealForceFetchAt = 0;

// ─────────────────────────────────────────────────────────────────────────────

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  let rejectForcedPull: ((reason?: unknown) => void) | undefined;
  let resolveForcedPull: ((value: PullCache) => void) | undefined;
  let forcedKey: string | undefined;
  try {
    const since = req.query.since ? String(req.query.since) : "1970-01-01T00:00:00.000Z";
    const isInitial = !req.query.since || since.startsWith("1970");
    const requestedForce = req.query.force === "1";

    // Si el último force=1 real fue hace menos de FORCE_TTL_MS, lo degradamos a
    // un pull normal: se sirve de la caché en memoria (0 queries a Postgres)
    // en vez de repetir todas las consultas. El cliente igual recibe una
    // respuesta válida y actualizada al segundo, solo que reusando lo ya leído.
    const now = Date.now();
    const forceThrottled = requestedForce && now - lastRealForceFetchAt < FORCE_TTL_MS;
    const force = requestedForce && !forceThrottled;
    if (force) lastRealForceFetchAt = now;

    // Un pull sin cambios vuelve a consultar el mismo cursor. Es atendido por
    // memoria (cero queries a Postgres) hasta que una mutación lo invalida.
    // `force=1` es exclusivo del refresh manual: vacía la caché y consulta
    // Postgres de inmediato, incluso si el cursor ya tenía una respuesta.
    // `force` omite el payload compuesto, pero conserva las cachés por dominio.
    // Las mutaciones ya invalidan solamente su dominio; así un refresh no vuelve
    // a descargar productos/clientes que no cambiaron.
    const cached = !force && !isInitial ? pullCache.get(since) : undefined;
    if (cached) {
      const clientEtag = req.headers["if-none-match"];
      if (clientEtag === cached.etag) {
        return res.status(304).end();
      }
      res.setHeader("ETag", cached.etag);
      return res.json(JSON.parse(cached.payload));
    }

    // Varias pantallas/dispositivos pueden disparar refresh al mismo tiempo.
    // El primero consulta Postgres; los demás esperan exactamente ese resultado.
    if (force) {
      const inFlight = forcedPullsInFlight.get(since);
      if (inFlight) {
        const shared = await inFlight;
        res.setHeader("ETag", shared.etag);
        return res.json(JSON.parse(shared.payload));
      }
      forcedKey = since;
      const resolvableTask = new Promise<PullCache>((resolve, reject) => {
        resolveForcedPull = resolve;
        rejectForcedPull = reject;
      });
      forcedPullsInFlight.set(forcedKey, resolvableTask);
    }

    const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const v = (t: string) => todayParts.find((x) => x.type === t)?.value;
    const todayDate = `${v("year")}-${v("month")}-${v("day")}`;

    // ── Queries paralelas optimizadas ──────────────────────────────────────────
    // Mismo criterio que existía con Firestore: en el pull inicial se trae todo
    // lo activo; en un pull incremental, solo lo que cambió después de `since`,
    // usando los índices de updated_at ya creados en el esquema.
    const cursorKey = isInitial ? "__initial__" : since;
    const [clientRows, productRows, categoryRows, neighborhoodRows, todayWorkDayRows] = await Promise.all([
      cachedRows("clients", clientQueryCache, cursorKey, async () =>
        isInitial
          ? (await pool.query("SELECT * FROM clients WHERE active = true")).rows
          : (await pool.query("SELECT * FROM clients WHERE updated_at > $1", [since])).rows,
        force),
      cachedRows("products", productQueryCache, cursorKey, async () =>
        isInitial
          ? (await pool.query("SELECT * FROM products WHERE active = true")).rows
          : (await pool.query("SELECT * FROM products WHERE updated_at > $1", [since])).rows,
        force),
      cachedRows("categories", categoryQueryCache, cursorKey, async () =>
        isInitial ? (await pool.query("SELECT * FROM categories WHERE active = true")).rows : [],
        force),
      cachedRows("neighborhoods", neighborhoodQueryCache, cursorKey, async () =>
        isInitial ? (await pool.query("SELECT * FROM neighborhoods WHERE active = true")).rows : [],
        force),
      cachedRows("workdays", workdayQueryCache, todayDate, async () =>
        (await pool.query("SELECT * FROM work_days WHERE work_date = $1", [todayDate])).rows,
        force),
    ]);

    // ── Presentaciones: filtro por timestamp EN POSTGRES, no en JS ─────────────
    // Igual que en clients/products: solo se leen las filas que realmente
    // cumplen la condición, usando el índice de product_presentations.updated_at.
    const rawPresentationRows = await cachedRows("presentations", presentationQueryCache, cursorKey, async () =>
      isInitial
        ? (await pool.query("SELECT * FROM product_presentations WHERE active = true")).rows
        : (await pool.query("SELECT * FROM product_presentations WHERE updated_at > $1", [since])).rows,
      force);

    const presentations = rawPresentationRows.map((row: any) => presentation(row));

    // ── WorkDay de hoy (solo 1 query, sin redundancia) ─────────────────────────
    const sortedTodayRows = [...todayWorkDayRows].sort((a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
    );
    const todayWorkDayRow = sortedTodayRows[0] || null;

    // ── Órdenes de hoy: evitar N+1 de clients ─────────────────────────────────
    // Cargamos todos los clients involucrados en una sola pasada en batch, en
    // vez de una query por orden.
    let orders: any[] = [];
    if (todayWorkDayRow) {
      const orderRows = await cachedRows("orders", orderQueryCache, todayWorkDayRow.id, async () =>
        (await pool.query("SELECT * FROM orders WHERE work_day_id = $1", [todayWorkDayRow.id])).rows,
        force);
      const activeOrders = orderRows.filter((row) => row.status !== "cancelled");

      if (activeOrders.length > 0) {
        // Batch de items en paralelo (en vez de await secuencial)
        const [itemsResults, clientIds] = [
          await Promise.all(activeOrders.map((row) => cachedRows("order-items", orderItemQueryCache, row.id, async () =>
            (await pool.query("SELECT * FROM order_items WHERE order_id = $1", [row.id])).rows,
            force))),
          [...new Set(activeOrders.map((row) => row.client_id))],
        ];

        // 1 lectura por client único (batch), en vez de 1 por orden — y si el
        // cliente ya vino en el delta de `clientRows` de este mismo pull, ni
        // siquiera esa lectura hace falta: reusamos la fila ya traída.
        const clientMap = new Map<string, string>();
        for (const row of clientRows) {
          const name = row.business_name || "Cliente";
          clientMap.set(row.id, name);
          clientNameCache.set(row.id, name);
        }
        const missingClientIds = clientIds.filter((cid) => !clientMap.has(cid));
        if (missingClientIds.length > 0) {
          const uncachedIds = missingClientIds.filter((cid) => !clientNameCache.has(cid));
          if (uncachedIds.length > 0) {
            const { rows: fetchedClients } = await pool.query("SELECT id, business_name FROM clients WHERE id = ANY($1)", [uncachedIds]);
            for (const c of fetchedClients) clientNameCache.set(c.id, c.business_name || "Cliente");
          }
          for (const cid of missingClientIds) {
            clientMap.set(cid, clientNameCache.get(cid) || "Cliente");
          }
        }

        orders = activeOrders.map((row, i) => ({
          id: row.id,
          work_day_id: row.work_day_id,
          user_id: row.user_id,
          client_id: row.client_id,
          client_name: clientMap.get(row.client_id) || "Cliente",
          payment_condition: row.payment_condition || "Contado 48h",
          subtotal_cents: row.subtotal_cents ?? 0,
          tax_cents: row.tax_cents ?? 0,
          total_cents: row.total_cents ?? 0,
          item_count: row.item_count ?? 0,
          status: row.status || "active",
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: itemsResults[i],
        }));
      }
    }

    const workDayData = todayWorkDayRow
      ? {
          id: todayWorkDayRow.id,
          user_id: todayWorkDayRow.user_id,
          work_date: todayWorkDayRow.work_date,
          status: todayWorkDayRow.status,
          order_count: todayWorkDayRow.order_count ?? 0,
          total_cents: todayWorkDayRow.total_cents ?? 0,
          created_at: todayWorkDayRow.created_at,
          closed_at: todayWorkDayRow.closed_at ?? null,
        }
      : null;

    const hasChanges = isInitial ||
      clientRows.length > 0 || productRows.length > 0 ||
      presentations.length > 0 || categoryRows.length > 0 ||
      neighborhoodRows.length > 0 ||
      Boolean(todayWorkDayRow && String(todayWorkDayRow.updated_at || todayWorkDayRow.created_at || "") > since) ||
      orders.some((order) => String(order.updated_at || order.created_at || "") > since);

    const nowIsoStr = new Date().toISOString();
    const responseBody = {
      serverTime: nowIsoStr,
      cursor: nowIsoStr,
      hasChanges,
      // Diagnóstico: true si este pull pidió force=1 pero fue atendido como uno
      // normal (con caché) porque el último force real fue hace menos de
      // FORCE_TTL_MS. No afecta la data devuelta, solo informa el motivo.
      refreshThrottled: forceThrottled,
      workDay: workDayData,
      clients: clientRows.map((row: any) => client(row)),
      products: productRows.map((row: any) => product(row)),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: rawPresentationRows.find((row: any) => row.id === p.id)?.quantity_available ?? 0,
        updated_at: p.updated_at,
      })),
      orders,
      categories: categoryRows.map((row: any) => ({ ...row, active: 1 })),
      neighborhoods: neighborhoodRows.map((row: any) => ({ ...row, active: 1 })),
    };

    // Guardar solo pulls incrementales. Limitar el mapa evita crecimiento sin
    // límite si se conectan muchas instalaciones con cursores distintos.
    const payload = JSON.stringify(responseBody);
    const etag = `"${simpleHash(payload)}"`;
    if (force) {
      resolveForcedPull?.({ etag, payload });
      forcedPullsInFlight.delete(forcedKey!);
      res.setHeader("ETag", etag);
    } else if (!isInitial) {
      if (pullCache.size >= MAX_PULL_CACHE_ENTRIES) pullCache.delete(pullCache.keys().next().value!);
      pullCache.set(since, { etag, payload });
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

syncRouter.get("/ping", (_req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

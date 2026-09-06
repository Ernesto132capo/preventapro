import { Router } from "express";
import { col, orderItemsCol } from "../db/firestore";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const syncRouter = Router();
syncRouter.use(requireAuth);

function client(id: string, d: any) { return { id, business_name: d.businessName, contact_name: d.contactName ?? null, phone: d.phone ?? null, neighborhood_id: d.neighborhoodId ?? null, address: d.address ?? null, lat: d.lat ?? null, lng: d.lng ?? null, visit_status: d.visitStatus ?? "pending", active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt }; }
function product(id: string, d: any) { return { id, sku: d.sku, name: d.name, category_id: d.categoryId ?? null, photo_url: d.photoUrl ?? null, base_cost_cents: d.baseCostCents ?? 0, base_unit_name: d.baseUnitName ?? "Unidad", active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt }; }
function presentation(id: string, d: any, parentProductId?: string) {
  return {
    id,
    product_id: d.productId || parentProductId || null,
    name: d.name,
    sort_order: d.sortOrder ?? 0,
    unit_equivalence: d.unitEquivalence ?? 1,
    price_cents: d.priceCents ?? 0,
    cost_cents: d.costCents ?? 0,
    active: d.active === false ? 0 : 1,
    created_at: d.createdAt || new Date().toISOString(),
    updated_at: d.updatedAt || new Date().toISOString(),
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
// payload de /pull, las colecciones que no cambiaron siguen sin tocar Firestore.
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

async function cachedDocs(domain: string, cache: Map<string, any[]>, key: string, load: () => Promise<any[]>, force = false): Promise<any[]> {
  if (!force && cache.has(key)) return cache.get(key)!;
  const flightKey = `${domain}:${key}`;
  const inFlight = sourceReadsInFlight.get(flightKey);
  if (inFlight) return inFlight;
  const task = load().then((docs) => { cache.set(key, docs); return docs; });
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

// ─────────────────────────────────────────────────────────────────────────────

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  let rejectForcedPull: ((reason?: unknown) => void) | undefined;
  let resolveForcedPull: ((value: PullCache) => void) | undefined;
  let forcedKey: string | undefined;
  try {
    const since = req.query.since ? String(req.query.since) : "1970-01-01T00:00:00.000Z";
    const isInitial = !req.query.since || since.startsWith("1970");
    const force = req.query.force === "1";

    // Un pull sin cambios vuelve a consultar el mismo cursor. Es atendido por
    // memoria (cero lecturas Firestore) hasta que una mutación lo invalida.
    // `force=1` es exclusivo del refresh manual: vacía la caché y consulta
    // Firestore de inmediato, incluso si el cursor ya tenía una respuesta.
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
    // El primero consulta Firestore; los demás esperan exactamente ese resultado.
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
    // ANTES: 7 queries siempre, incluida una collectionGroup SIN FILTRO que
    //        descargaba TODAS las presentaciones de todos los productos.
    // AHORA: collectionGroup con filtro de timestamp en pulls incrementales,
    //        y una sola query de workdays (eliminamos la query redundante de "open").
    const cursorKey = isInitial ? "__initial__" : since;
    const [clientDocs, productDocs, categoryDocs, neighborhoodDocs, todayWorkDayDocs] = await Promise.all([
      cachedDocs("clients", clientQueryCache, cursorKey, async () => (isInitial ? await col.clients.where("active", "==", true).get() : await col.clients.where("updatedAt", ">", since).get()).docs, force),
      cachedDocs("products", productQueryCache, cursorKey, async () => (isInitial ? await col.products.where("active", "==", true).get() : await col.products.where("updatedAt", ">", since).get()).docs, force),
      cachedDocs("categories", categoryQueryCache, cursorKey, async () => isInitial ? (await col.categories.where("active", "==", true).get()).docs : [], force),
      cachedDocs("neighborhoods", neighborhoodQueryCache, cursorKey, async () => isInitial ? (await col.neighborhoods.where("active", "==", true).get()).docs : [], force),
      cachedDocs("workdays", workdayQueryCache, todayDate, async () => (await col.workDays.where("workDate", "==", todayDate).get()).docs, force),
    ]);

    // ── Presentaciones: filtro por timestamp en pulls incrementales ─────────────
    // ANTES: collectionGroup().get() sin filtro = TODOS los documentos de
    //        presentaciones en Firestore, independientemente de si cambiaron.
    // AHORA: en pulls incrementales solo descargamos las modificadas desde `since`.
    const rawPresentationDocs = await cachedDocs("presentations", presentationQueryCache, cursorKey, async () => {
      const snap = await col.products.firestore.collectionGroup("presentations").get();
      return snap.docs.filter((d: any) => {
        const data = d.data();
        if (isInitial) return data.active !== false;
        return (data.updatedAt && data.updatedAt > since) || (data.createdAt && data.createdAt > since);
      });
    }, force);

    const presentations = rawPresentationDocs.map((d: any) => presentation(d.id, d.data(), d.ref.parent?.parent?.id));

    // ── WorkDay de hoy (solo 1 query, sin redundancia) ─────────────────────────
    const sortedTodayDocs = [...todayWorkDayDocs].sort((a, b) =>
      (b.data().updatedAt || b.data().createdAt || "").localeCompare(a.data().updatedAt || a.data().createdAt || "")
    );
    const todayWorkDayDoc = sortedTodayDocs[0] || null;

    // ── Órdenes de hoy: evitar N+1 de clients ─────────────────────────────────
    // ANTES: por cada orden → col.clients.doc(clientId).get() individual.
    //        Con 10 órdenes = 10 lecturas extra de clientes en cada pull.
    // AHORA: cargamos todos los clients involucrados en una sola pasada en batch.
    let orders: any[] = [];
    if (todayWorkDayDoc) {
      const orderDocs = await cachedDocs("orders", orderQueryCache, todayWorkDayDoc.id, async () => (await col.orders.where("workDayId", "==", todayWorkDayDoc.id).get()).docs, force);
      const activeOrders = orderDocs.filter((d) => d.data().status !== "cancelled");

      if (activeOrders.length > 0) {
        // Batch de items en paralelo (en vez de await secuencial)
        const [itemsSnaps, clientIds] = [
          await Promise.all(activeOrders.map((d) => cachedDocs("order-items", orderItemQueryCache, d.id, async () => (await orderItemsCol(d.id).get()).docs, force))),
          [...new Set(activeOrders.map((d) => d.data().clientId))],
        ];

        // 1 lectura por client único (batch), en vez de 1 por orden
        const clientMap = new Map<string, string>();
        await Promise.all(
          clientIds.map(async (cid) => {
            const cachedName = clientNameCache.get(cid);
            if (cachedName) { clientMap.set(cid, cachedName); return; }
            const cdoc = await col.clients.doc(cid).get();
            const name = cdoc.data()?.businessName || "Cliente";
            clientNameCache.set(cid, name);
            clientMap.set(cid, name);
          })
        );

        orders = activeOrders.map((d, i) => {
          const data = d.data();
          return {
            id: d.id,
            work_day_id: data.workDayId,
            user_id: data.userId,
            client_id: data.clientId,
            client_name: clientMap.get(data.clientId) || "Cliente",
            payment_condition: data.paymentCondition || "Contado 48h",
            subtotal_cents: data.subtotalCents ?? 0,
            tax_cents: data.taxCents ?? 0,
            total_cents: data.totalCents ?? 0,
            item_count: data.itemCount ?? 0,
            status: data.status || "active",
            created_at: data.createdAt,
            updated_at: data.updatedAt,
            items: itemsSnaps[i].map((it) => ({ id: it.id, ...it.data() })),
          };
        });
      }
    }

    const workDayData = todayWorkDayDoc
      ? {
          id: todayWorkDayDoc.id,
          user_id: todayWorkDayDoc.data().userId,
          work_date: todayWorkDayDoc.data().workDate,
          status: todayWorkDayDoc.data().status,
          order_count: todayWorkDayDoc.data().orderCount ?? 0,
          total_cents: todayWorkDayDoc.data().totalCents ?? 0,
          created_at: todayWorkDayDoc.data().createdAt,
          closed_at: todayWorkDayDoc.data().closedAt ?? null,
        }
      : null;

    const hasChanges = isInitial ||
      clientDocs.length > 0 || productDocs.length > 0 ||
      presentations.length > 0 || categoryDocs.length > 0 ||
      neighborhoodDocs.length > 0 ||
      Boolean(todayWorkDayDoc && String(todayWorkDayDoc.data().updatedAt || todayWorkDayDoc.data().createdAt || "") > since) ||
      orders.some((order) => String(order.updated_at || order.created_at || "") > since);

    const nowIsoStr = new Date().toISOString();
    const responseBody = {
      serverTime: nowIsoStr,
      cursor: nowIsoStr,
      hasChanges,
      workDay: workDayData,
      clients: clientDocs.map((d: any) => client(d.id, d.data())),
      products: productDocs.map((d: any) => product(d.id, d.data())),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: rawPresentationDocs.find((d: any) => d.id === p.id)?.data().stock ?? 0,
        updated_at: p.updated_at,
      })),
      orders,
      categories: categoryDocs.map((d: any) => ({ id: d.id, ...d.data(), active: 1 })),
      neighborhoods: neighborhoodDocs.map((d: any) => ({ id: d.id, ...d.data(), active: 1 })),
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

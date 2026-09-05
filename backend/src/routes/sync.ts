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

export function invalidatePullCache() {
  pullCache.clear();
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  try {
    const since = req.query.since ? String(req.query.since) : "1970-01-01T00:00:00.000Z";
    const isInitial = !req.query.since || since.startsWith("1970");

    // Un pull sin cambios vuelve a consultar el mismo cursor. Es atendido por
    // memoria (cero lecturas Firestore) hasta que una mutación lo invalida.
    const cached = !isInitial ? pullCache.get(since) : undefined;
    if (cached) {
      const clientEtag = req.headers["if-none-match"];
      if (clientEtag === cached.etag) {
        return res.status(304).end();
      }
      res.setHeader("ETag", cached.etag);
      return res.json(JSON.parse(cached.payload));
    }

    const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const v = (t: string) => todayParts.find((x) => x.type === t)?.value;
    const todayDate = `${v("year")}-${v("month")}-${v("day")}`;

    // ── Queries paralelas optimizadas ──────────────────────────────────────────
    // ANTES: 7 queries siempre, incluida una collectionGroup SIN FILTRO que
    //        descargaba TODAS las presentaciones de todos los productos.
    // AHORA: collectionGroup con filtro de timestamp en pulls incrementales,
    //        y una sola query de workdays (eliminamos la query redundante de "open").
    const [clientDocs, productDocs, categoryDocs, neighborhoodDocs, todayWorkDaysSnap] = await Promise.all([
      isInitial
        ? col.clients.where("active", "==", true).get()
        : col.clients.where("updatedAt", ">", since).get(),
      isInitial
        ? col.products.where("active", "==", true).get()
        : col.products.where("updatedAt", ">", since).get(),
      isInitial ? col.categories.where("active", "==", true).get() : Promise.resolve({ docs: [] as any[] }),
      isInitial ? col.neighborhoods.where("active", "==", true).get() : Promise.resolve({ docs: [] as any[] }),
      col.workDays.where("workDate", "==", todayDate).get(), // 1 query en vez de 2
    ]);

    // ── Presentaciones: filtro por timestamp en pulls incrementales ─────────────
    // ANTES: collectionGroup().get() sin filtro = TODOS los documentos de
    //        presentaciones en Firestore, independientemente de si cambiaron.
    // AHORA: en pulls incrementales solo descargamos las modificadas desde `since`.
    let rawPresentationDocs: any[] = [];
    if (isInitial) {
      const snap = await col.products.firestore.collectionGroup("presentations").where("active", "==", true).get();
      rawPresentationDocs = snap.docs;
    } else {
      const snap = await col.products.firestore.collectionGroup("presentations").where("updatedAt", ">", since).get();
      rawPresentationDocs = snap.docs;
    }

    const presentations = rawPresentationDocs.map((d: any) => presentation(d.id, d.data(), d.ref.parent?.parent?.id));

    // ── WorkDay de hoy (solo 1 query, sin redundancia) ─────────────────────────
    const sortedTodayDocs = todayWorkDaysSnap.docs.sort((a, b) =>
      (b.data().updatedAt || b.data().createdAt || "").localeCompare(a.data().updatedAt || a.data().createdAt || "")
    );
    const todayWorkDayDoc = sortedTodayDocs[0] || null;

    // ── Órdenes de hoy: evitar N+1 de clients ─────────────────────────────────
    // ANTES: por cada orden → col.clients.doc(clientId).get() individual.
    //        Con 10 órdenes = 10 lecturas extra de clientes en cada pull.
    // AHORA: cargamos todos los clients involucrados en una sola pasada en batch.
    let orders: any[] = [];
    if (todayWorkDayDoc) {
      const orderDocs = await col.orders.where("workDayId", "==", todayWorkDayDoc.id).get();
      const activeOrders = orderDocs.docs.filter((d) => d.data().status !== "cancelled");

      if (activeOrders.length > 0) {
        // Batch de items en paralelo (en vez de await secuencial)
        const [itemsSnaps, clientIds] = [
          await Promise.all(activeOrders.map((d) => orderItemsCol(d.id).get())),
          [...new Set(activeOrders.map((d) => d.data().clientId))],
        ];

        // 1 lectura por client único (batch), en vez de 1 por orden
        const clientMap = new Map<string, string>();
        await Promise.all(
          clientIds.map(async (cid) => {
            const cdoc = await col.clients.doc(cid).get();
            clientMap.set(cid, cdoc.data()?.businessName || "Cliente");
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
            items: itemsSnaps[i].docs.map((it) => ({ id: it.id, ...it.data() })),
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
      clientDocs.docs.length > 0 || productDocs.docs.length > 0 ||
      presentations.length > 0 || categoryDocs.docs.length > 0 ||
      neighborhoodDocs.docs.length > 0 ||
      Boolean(todayWorkDayDoc && String(todayWorkDayDoc.data().updatedAt || todayWorkDayDoc.data().createdAt || "") > since) ||
      orders.some((order) => String(order.updated_at || order.created_at || "") > since);

    const responseBody = {
      serverTime: new Date().toISOString(),
      // El móvil conserva el cursor cuando no hubo cambios; así el siguiente
      // poll usa exactamente la misma clave y llega a esta caché.
      cursor: hasChanges ? new Date().toISOString() : since,
      hasChanges,
      workDay: workDayData,
      clients: clientDocs.docs.map((d: any) => client(d.id, d.data())),
      products: productDocs.docs.map((d: any) => product(d.id, d.data())),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: rawPresentationDocs.find((d: any) => d.id === p.id)?.data().stock ?? 0,
        updated_at: p.updated_at,
      })),
      orders,
      categories: categoryDocs.docs.map((d: any) => ({ id: d.id, ...d.data(), active: 1 })),
      neighborhoods: neighborhoodDocs.docs.map((d: any) => ({ id: d.id, ...d.data(), active: 1 })),
    };

    // Guardar solo pulls incrementales. Limitar el mapa evita crecimiento sin
    // límite si se conectan muchas instalaciones con cursores distintos.
    if (!isInitial) {
      const payload = JSON.stringify(responseBody);
      const etag = `"${simpleHash(payload)}"`;
      if (pullCache.size >= MAX_PULL_CACHE_ENTRIES) pullCache.delete(pullCache.keys().next().value!);
      pullCache.set(since, { etag, payload });
      res.setHeader("ETag", etag);
    }

    res.json(responseBody);
  } catch (error: any) {
    console.error("Error en sync /pull:", error);
    res.status(500).json({ error: error.message || "Error al sincronizar datos." });
  }
});

syncRouter.get("/ping", (_req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

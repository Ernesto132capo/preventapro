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

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  try {
    const since = req.query.since ? String(req.query.since) : "1970-01-01T00:00:00.000Z";
    const isInitial = !req.query.since || since.startsWith("1970");

    const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const v = (t: string) => todayParts.find((x) => x.type === t)?.value;
    const todayDate = `${v("year")}-${v("month")}-${v("day")}`;

    const [clientDocs, productDocs, rawPresentationDocs, categoryDocs, neighborhoodDocs, todayWorkDaysSnap, openWorkDaysSnap] = await Promise.all([
      isInitial ? col.clients.where("active", "==", true).get() : col.clients.where("updatedAt", ">", since).get(),
      isInitial ? col.products.where("active", "==", true).get() : col.products.where("updatedAt", ">", since).get(),
      col.products.firestore.collectionGroup("presentations").get(),
      col.categories.where("active", "==", true).get(),
      col.neighborhoods.where("active", "==", true).get(),
      col.workDays.where("workDate", "==", todayDate).get(),
      col.workDays.where("status", "==", "open").get(),
    ]);

    const filteredPresDocs = rawPresentationDocs.docs.filter((d) => {
      const data = d.data();
      if (isInitial) return data.active !== false;
      return (data.updatedAt && data.updatedAt > since) || (data.createdAt && data.createdAt > since);
    });

    const presentations = filteredPresDocs.map((d) => presentation(d.id, d.data(), d.ref.parent?.parent?.id));

    // Determinar la jornada activa o más reciente de hoy
    const todayWorkDayDoc =
      todayWorkDaysSnap.docs.find((d) => d.data().status === "open") ||
      todayWorkDaysSnap.docs.sort((a, b) => (b.data().createdAt || "").localeCompare(a.data().createdAt || ""))[0] ||
      openWorkDaysSnap.docs[0];

    let orders: any[] = [];
    if (todayWorkDayDoc) {
      const orderDocs = await col.orders.where("workDayId", "==", todayWorkDayDoc.id).get();
      orders = await Promise.all(
        orderDocs.docs
          .filter((d) => d.data().status !== "cancelled")
          .map(async (d) => {
            const data = d.data();
            const itemsSnap = await orderItemsCol(d.id).get();
            const clientDoc = await col.clients.doc(data.clientId).get();
            return {
              id: d.id,
              work_day_id: data.workDayId,
              user_id: data.userId,
              client_id: data.clientId,
              client_name: clientDoc.data()?.businessName || "Cliente",
              payment_condition: data.paymentCondition || "Contado 48h",
              subtotal_cents: data.subtotalCents ?? 0,
              tax_cents: data.taxCents ?? 0,
              total_cents: data.totalCents ?? 0,
              item_count: data.itemCount ?? 0,
              status: data.status || "active",
              created_at: data.createdAt,
              updated_at: data.updatedAt,
              items: itemsSnap.docs.map((it) => ({
                id: it.id,
                ...it.data(),
              })),
            };
          })
      );
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

    res.json({
      serverTime: new Date().toISOString(),
      workDay: workDayData,
      clients: clientDocs.docs.map((d) => client(d.id, d.data())),
      products: productDocs.docs.map((d) => product(d.id, d.data())),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: filteredPresDocs.find((d: any) => d.id === p.id)?.data().stock ?? 0,
        updated_at: p.updated_at,
      })),
      orders,
      categories: categoryDocs.docs.map((d) => ({ id: d.id, ...d.data(), active: 1 })),
      neighborhoods: neighborhoodDocs.docs.map((d) => ({ id: d.id, ...d.data(), active: 1 })),
    });
  } catch (error: any) {
    console.error("Error en sync /pull:", error);
    res.status(500).json({ error: error.message || "Error al sincronizar datos." });
  }
});
syncRouter.get("/ping", (_req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

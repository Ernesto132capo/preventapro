import { Router } from "express";
import { col } from "../db/firestore";
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

    const [clientDocs, productDocs, rawPresentationDocs, categoryDocs, neighborhoodDocs] = await Promise.all([
      isInitial ? col.clients.where("active", "==", true).get() : col.clients.where("updatedAt", ">", since).get(),
      isInitial ? col.products.where("active", "==", true).get() : col.products.where("updatedAt", ">", since).get(),
      col.products.firestore.collectionGroup("presentations").get(),
      col.categories.where("active", "==", true).get(),
      col.neighborhoods.where("active", "==", true).get(),
    ]);

    const filteredPresDocs = rawPresentationDocs.docs.filter((d) => {
      const data = d.data();
      if (isInitial) return data.active !== false;
      return (data.updatedAt && data.updatedAt > since) || (data.createdAt && data.createdAt > since);
    });

    const presentations = filteredPresDocs.map((d) => presentation(d.id, d.data(), d.ref.parent?.parent?.id));
    res.json({
      serverTime: new Date().toISOString(),
      clients: clientDocs.docs.map((d) => client(d.id, d.data())),
      products: productDocs.docs.map((d) => product(d.id, d.data())),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: filteredPresDocs.find((d: any) => d.id === p.id)?.data().stock ?? 0,
        updated_at: p.updated_at,
      })),
      categories: categoryDocs.docs.map((d) => ({ id: d.id, ...d.data(), active: 1 })),
      neighborhoods: neighborhoodDocs.docs.map((d) => ({ id: d.id, ...d.data(), active: 1 })),
    });
  } catch (error: any) {
    console.error("Error en sync /pull:", error);
    res.status(500).json({ error: error.message || "Error al sincronizar datos." });
  }
});
syncRouter.get("/ping", (_req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

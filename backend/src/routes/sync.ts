import { Router } from "express";
import { col } from "../db/firestore";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const syncRouter = Router();
syncRouter.use(requireAuth);

function client(id: string, d: any) { return { id, business_name: d.businessName, contact_name: d.contactName ?? null, phone: d.phone ?? null, neighborhood_id: d.neighborhoodId ?? null, address: d.address ?? null, lat: d.lat ?? null, lng: d.lng ?? null, visit_status: d.visitStatus ?? "pending", active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt }; }
function product(id: string, d: any) { return { id, sku: d.sku, name: d.name, category_id: d.categoryId ?? null, photo_url: d.photoUrl ?? null, base_cost_cents: d.baseCostCents ?? 0, base_unit_name: d.baseUnitName ?? "Unidad", active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt }; }
function presentation(id: string, d: any) { return { id, product_id: d.productId, name: d.name, sort_order: d.sortOrder, unit_equivalence: d.unitEquivalence, price_cents: d.priceCents, cost_cents: d.costCents, active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt }; }

syncRouter.get("/pull", async (req: AuthedRequest, res) => {
  try {
    const since = String(req.query.since || "1970-01-01T00:00:00.000Z");
    const [clientDocs, productDocs, presentationDocs, categoryDocs, neighborhoodDocs] = await Promise.all([
      col.clients.where("updatedAt", ">", since).get(),
      col.products.where("updatedAt", ">", since).get(),
      col.products.firestore.collectionGroup("presentations").where("updatedAt", ">", since).get(),
      col.categories.where("active", "==", true).get(),
      col.neighborhoods.where("active", "==", true).get(),
    ]);
    const presentations = presentationDocs.docs.map((d) => presentation(d.id, d.data()));
    res.json({
      serverTime: new Date().toISOString(),
      clients: clientDocs.docs.map((d) => client(d.id, d.data())),
      products: productDocs.docs.map((d) => product(d.id, d.data())),
      presentations,
      inventory: presentations.map((p) => ({
        id: p.id,
        presentation_id: p.id,
        quantity_available: presentationDocs.docs.find((d) => d.id === p.id)?.data().stock ?? 0,
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

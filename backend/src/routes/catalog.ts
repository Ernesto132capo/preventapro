import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { col, nowIso, presentationsCol } from "../db/firestore";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

const presentationInput = z.object({ name: z.string().min(1), unitEquivalence: z.number().int().positive(), priceCents: z.number().int().nonnegative(), costCents: z.number().int().nonnegative().default(0), stock: z.number().int().nonnegative().default(0) });
const productSchema = z.object({ sku: z.string().min(1), name: z.string().min(1), categoryId: z.string().optional(), photoUrl: z.string().optional(), baseCostCents: z.number().int().nonnegative().default(0), baseUnitName: z.string().default("Unidad"), presentations: z.array(presentationInput).min(1, "Configura al menos una presentación.") });
const productUpdateSchema = productSchema.omit({ sku: true });

function serialPresentation(id: string, d: any) {
  return { id, product_id: d.productId, name: d.name, sort_order: d.sortOrder, unit_equivalence: d.unitEquivalence, price_cents: d.priceCents, cost_cents: d.costCents, active: d.active === false ? 0 : 1, quantity_available: d.stock ?? 0, created_at: d.createdAt, updated_at: d.updatedAt };
}
async function serialProduct(id: string, d: any) {
  const pres = await presentationsCol(id).where("active", "==", true).get();
  return { id, sku: d.sku, name: d.name, category_id: d.categoryId ?? null, photo_url: d.photoUrl ?? null, base_cost_cents: d.baseCostCents ?? 0, base_unit_name: d.baseUnitName ?? "Unidad", active: d.active === false ? 0 : 1, created_at: d.createdAt, updated_at: d.updatedAt, presentations: pres.docs.map((p) => serialPresentation(p.id, p.data())).sort((a, b) => a.sort_order - b.sort_order) };
}

catalogRouter.get("/categories", async (_req, res) => {
  const snap = await col.categories.where("active", "==", true).get();
  const categories = snap.docs.map((d) => ({ id: d.id, ...d.data(), active: 1 })).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  res.json({ categories });
});
catalogRouter.post("/categories", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "El nombre de categoría es obligatorio." });
  if (!(await col.categories.where("name", "==", name).limit(1).get()).empty) return res.status(409).json({ error: "Esa categoría ya existe." });
  const id = uuid(), ts = nowIso(); await col.categories.doc(id).set({ name, active: true, createdAt: ts, updatedAt: ts });
  invalidatePullCache();
  res.status(201).json({ id, name });
});

catalogRouter.get("/products", async (req, res) => {
  const { q, categoryId } = req.query as { q?: string; categoryId?: string };
  let docs = (await col.products.where("active", "==", true).get()).docs;
  if (categoryId) docs = docs.filter((d) => d.data().categoryId === categoryId);
  if (q) { const term = q.toLowerCase(); docs = docs.filter((d) => `${d.data().name} ${d.data().sku}`.toLowerCase().includes(term)); }
  const products = await Promise.all(docs.map((d) => serialProduct(d.id, d.data()))); products.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ products });
});
catalogRouter.get("/products/:id", async (req, res) => {
  const doc = await col.products.doc(req.params.id).get();
  if (!doc.exists || doc.data()?.active === false) return res.status(404).json({ error: "Producto no encontrado." });
  res.json({ product: await serialProduct(doc.id, doc.data()!) });
});

catalogRouter.post("/products", async (req: AuthedRequest, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const d = parsed.data;
  const existing = await col.products.where("sku", "==", d.sku).limit(1).get();
  if (!existing.empty) {
    return res.json({ product: await serialProduct(existing.docs[0].id, existing.docs[0].data()), deduped: true });
  }
  const id = uuid(), ts = nowIso(), product = { sku: d.sku, name: d.name, categoryId: d.categoryId ?? null, photoUrl: d.photoUrl ?? null, baseCostCents: d.baseCostCents, baseUnitName: d.baseUnitName, createdBy: req.userId, active: true, createdAt: ts, updatedAt: ts };
  const batch = col.products.firestore.batch(); batch.set(col.products.doc(id), product);
  d.presentations.forEach((p, sortOrder) => batch.set(presentationsCol(id).doc(uuid()), { ...p, productId: id, sortOrder, active: true, createdAt: ts, updatedAt: ts }));
  await batch.commit(); invalidatePullCache(); res.status(201).json({ product: await serialProduct(id, product) });
});

catalogRouter.put("/products/:id", async (req: AuthedRequest, res) => {
  const parsed = productUpdateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const ref = col.products.doc(req.params.id), existing = await ref.get(); if (!existing.exists || existing.data()?.active === false) return res.status(404).json({ error: "Producto no encontrado." });
  const d = parsed.data, old = existing.data()!, ts = nowIso(), current = await presentationsCol(ref.id).get(), names = new Set(d.presentations.map((p) => p.name)), byName = new Map(current.docs.map((p) => [p.data().name, p]));
  const batch = col.products.firestore.batch(); batch.update(ref, { name: d.name, categoryId: d.categoryId ?? old.categoryId ?? null, baseCostCents: d.baseCostCents ?? old.baseCostCents ?? 0, baseUnitName: d.baseUnitName ?? old.baseUnitName ?? "Unidad", updatedAt: ts });
  current.docs.filter((p) => !names.has(p.data().name)).forEach((p) => batch.update(p.ref, { active: false, updatedAt: ts }));
  d.presentations.forEach((p, sortOrder) => { const match = byName.get(p.name), pref = match?.ref ?? presentationsCol(ref.id).doc(uuid()); batch.set(pref, { ...p, productId: ref.id, sortOrder, active: true, createdAt: match?.data().createdAt ?? ts, updatedAt: ts }, { merge: true }); });
  await batch.commit(); invalidatePullCache(); res.json({ product: await serialProduct(ref.id, { ...old, name: d.name, categoryId: d.categoryId ?? old.categoryId, baseCostCents: d.baseCostCents ?? old.baseCostCents, baseUnitName: d.baseUnitName ?? old.baseUnitName, updatedAt: ts }) });
});

catalogRouter.patch("/presentations/:id/stock", async (req, res) => {
  const { quantityAvailable } = req.body || {}; if (typeof quantityAvailable !== "number" || quantityAvailable < 0) return res.status(400).json({ error: "quantityAvailable inválido." });
  const group = await col.products.firestore.collectionGroup("presentations").where("__name__", "==", req.params.id).limit(1).get();
  if (group.empty) return res.status(404).json({ error: "Presentación sin registro de inventario." });
  await group.docs[0].ref.update({ stock: quantityAvailable, updatedAt: nowIso() }); invalidatePullCache(); res.json({ ok: true });
});
catalogRouter.delete("/products/:id", async (req, res) => { await col.products.doc(req.params.id).update({ active: false, updatedAt: nowIso() }); invalidatePullCache(); res.json({ ok: true }); });

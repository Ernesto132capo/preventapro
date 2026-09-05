import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { col, nowIso } from "../db/firestore";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

function serializeClient(id: string, d: any, neighborhoodName: string | null = null) {
  return { id, server_id: id, client_local_id: d.clientLocalId ?? null, client_code: d.clientCode ?? null,
    business_name: d.businessName, contact_name: d.contactName ?? null, phone: d.phone ?? null,
    neighborhood_id: d.neighborhoodId ?? null, neighborhood_name: neighborhoodName, address: d.address ?? null,
    lat: d.lat ?? null, lng: d.lng ?? null, visit_status: d.visitStatus ?? "pending", active: d.active === false ? 0 : 1,
    sync_status: "synced", created_at: d.createdAt, updated_at: d.updatedAt };
}

const clientSchema = z.object({ clientLocalId: z.string().optional(), businessName: z.string().min(1, "El nombre del negocio es obligatorio"),
  contactName: z.string().optional(), phone: z.string().optional(), neighborhoodId: z.string().optional(),
  address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() });

clientsRouter.get("/", async (_req, res) => {
  const snap = await col.clients.where("active", "==", true).get();
  const ids = [...new Set(snap.docs.map((d) => d.data().neighborhoodId).filter(Boolean))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, (await col.neighborhoods.doc(id).get()).data()?.name ?? null] as const)));
  const clients = snap.docs.map((d) => serializeClient(d.id, d.data(), names.get(d.data().neighborhoodId) ?? null)).sort((a, b) => a.business_name.localeCompare(b.business_name));
  res.json({ clients });
});

clientsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const d = parsed.data;
  if (d.clientLocalId) {
    const existing = await col.clients.where("clientLocalId", "==", d.clientLocalId).limit(1).get();
    if (!existing.empty) return res.json({ client: serializeClient(existing.docs[0].id, existing.docs[0].data()), deduped: true });
  }
  const id = uuid(), ts = nowIso();
  const data = { ...d, contactName: d.contactName ?? null, phone: d.phone ?? null, neighborhoodId: d.neighborhoodId ?? null, address: d.address ?? null, lat: d.lat ?? null, lng: d.lng ?? null, assignedUserId: req.userId, createdBy: req.userId, visitStatus: "pending", active: true, createdAt: ts, updatedAt: ts };
  await col.clients.doc(id).set(data);
  invalidatePullCache();
  res.status(201).json({ client: serializeClient(id, data) });
});

clientsRouter.put("/:id", async (req, res) => {
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const ref = col.clients.doc(req.params.id), snap = await ref.get();
  if (!snap.exists || snap.data()?.active === false) return res.status(404).json({ error: "Cliente no encontrado." });
  const d = parsed.data, changes: any = { updatedAt: nowIso() };
  if (d.businessName !== undefined) changes.businessName = d.businessName;
  if (d.contactName !== undefined) changes.contactName = d.contactName;
  if (d.phone !== undefined) changes.phone = d.phone;
  if (d.neighborhoodId !== undefined) changes.neighborhoodId = d.neighborhoodId;
  if (d.address !== undefined) changes.address = d.address;
  if (d.lat !== undefined) changes.lat = d.lat;
  if (d.lng !== undefined) changes.lng = d.lng;
  await ref.update(changes);
  invalidatePullCache();
  res.json({ client: serializeClient(ref.id, { ...snap.data(), ...changes }) });
});

clientsRouter.patch("/:id/visit-status", async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'visited'].includes(status)) return res.status(400).json({ error: "Estado inválido." });
  await col.clients.doc(req.params.id).update({ visitStatus: status, updatedAt: nowIso() });
  invalidatePullCache();
  res.json({ ok: true });
});

clientsRouter.delete("/:id", async (req, res) => {
  const orders = await col.orders.where("clientId", "==", req.params.id).limit(1).get();
  await col.clients.doc(req.params.id).update({ active: false, updatedAt: nowIso() });
  invalidatePullCache();
  res.json({ ok: true, hadHistory: !orders.empty });
});

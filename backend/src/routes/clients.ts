import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

function serializeClient(row: any) {
  return {
    id: row.id, server_id: row.id, client_local_id: row.client_local_id ?? null, client_code: row.client_code ?? null,
    business_name: row.business_name, contact_name: row.contact_name ?? null, phone: row.phone ?? null,
    neighborhood_id: row.neighborhood_id ?? null, neighborhood_name: row.neighborhood_name ?? null, address: row.address ?? null,
    lat: row.lat ?? null, lng: row.lng ?? null, visit_status: row.visit_status ?? "pending", active: row.active === false ? 0 : 1,
    sync_status: "synced", created_at: row.created_at, updated_at: row.updated_at,
  };
}

const clientSchema = z.object({ clientLocalId: z.string().optional(), businessName: z.string().min(1, "El nombre del negocio es obligatorio"),
  contactName: z.string().optional(), phone: z.string().optional(), neighborhoodId: z.string().optional(),
  address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() });

clientsRouter.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, n.name AS neighborhood_name
     FROM clients c
     LEFT JOIN neighborhoods n ON n.id = c.neighborhood_id
     WHERE c.active = true
     ORDER BY c.business_name`
  );
  res.json({ clients: rows.map(serializeClient) });
});

clientsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const d = parsed.data;

  if (d.clientLocalId) {
    const existing = await pool.query("SELECT * FROM clients WHERE client_local_id = $1 LIMIT 1", [d.clientLocalId]);
    if (existing.rows.length > 0) return res.json({ client: serializeClient(existing.rows[0]), deduped: true });
  }

  const id = uuid(), ts = nowIso();
  const { rows } = await pool.query(
    `INSERT INTO clients (
       id, client_code, business_name, contact_name, phone, neighborhood_id, address, lat, lng,
       visit_status, active, assigned_user_id, created_by, client_local_id, created_at, updated_at
     ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'pending', true, $9, $9, $10, $11, $11)
     RETURNING *`,
    [
      id, d.businessName, d.contactName ?? null, d.phone ?? null, d.neighborhoodId ?? null,
      d.address ?? null, d.lat ?? null, d.lng ?? null, req.userId, d.clientLocalId ?? null, ts,
    ]
  );
  invalidatePullCache("clients");
  res.status(201).json({ client: serializeClient(rows[0]) });
});

clientsRouter.put("/:id", async (req, res) => {
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });

  const existing = await pool.query("SELECT * FROM clients WHERE id = $1", [req.params.id]);
  const current = existing.rows[0];
  if (!current || current.active === false) return res.status(404).json({ error: "Cliente no encontrado." });

  const d = parsed.data;
  const merged = {
    business_name: d.businessName !== undefined ? d.businessName : current.business_name,
    contact_name: d.contactName !== undefined ? d.contactName : current.contact_name,
    phone: d.phone !== undefined ? d.phone : current.phone,
    neighborhood_id: d.neighborhoodId !== undefined ? d.neighborhoodId : current.neighborhood_id,
    address: d.address !== undefined ? d.address : current.address,
    lat: d.lat !== undefined ? d.lat : current.lat,
    lng: d.lng !== undefined ? d.lng : current.lng,
  };
  const ts = nowIso();
  const { rows } = await pool.query(
    `UPDATE clients SET business_name = $2, contact_name = $3, phone = $4, neighborhood_id = $5,
       address = $6, lat = $7, lng = $8, updated_at = $9
     WHERE id = $1
     RETURNING *`,
    [req.params.id, merged.business_name, merged.contact_name, merged.phone, merged.neighborhood_id, merged.address, merged.lat, merged.lng, ts]
  );
  invalidatePullCache("clients");
  res.json({ client: serializeClient(rows[0]) });
});

clientsRouter.patch("/:id/visit-status", async (req, res) => {
  const { status } = req.body || {};
  if (!["pending", "visited"].includes(status)) return res.status(400).json({ error: "Estado inválido." });
  await pool.query("UPDATE clients SET visit_status = $2, updated_at = $3 WHERE id = $1", [req.params.id, status, nowIso()]);
  invalidatePullCache("clients");
  res.json({ ok: true });
});

clientsRouter.delete("/:id", async (req, res) => {
  const orders = await pool.query("SELECT id FROM orders WHERE client_id = $1 LIMIT 1", [req.params.id]);
  await pool.query("UPDATE clients SET active = false, updated_at = $2 WHERE id = $1", [req.params.id, nowIso()]);
  invalidatePullCache("clients");
  res.json({ ok: true, hadHistory: orders.rows.length > 0 });
});

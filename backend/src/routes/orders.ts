import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { PoolClient } from "pg";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";
import { invalidateWorkdayCache } from "./workdays";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const item = z.object({ productId: z.string(), presentationId: z.string(), quantity: z.number().int().positive() });
const schema = z.object({ idempotencyKey: z.string().min(1), workDayId: z.string(), clientId: z.string(), paymentCondition: z.string().default("Contado 48h"), taxRatePermille: z.number().int().nonnegative().default(0), items: z.array(item).min(1) });

function serial(row: any, items: any[]) {
  return {
    id: row.id, idempotency_key: row.idempotency_key, work_day_id: row.work_day_id, user_id: row.user_id, client_id: row.client_id,
    payment_condition: row.payment_condition, subtotal_cents: row.subtotal_cents, tax_cents: row.tax_cents, total_cents: row.total_cents,
    item_count: row.item_count, status: row.status, receipt_number: row.receipt_number ?? null, sync_status: "synced",
    created_at: row.created_at, updated_at: row.updated_at, items,
  };
}

async function full(id: string, client: PoolClient | typeof pool = pool) {
  const { rows } = await client.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (rows.length === 0) return null;
  const { rows: items } = await client.query("SELECT * FROM order_items WHERE order_id = $1", [id]);
  return serial(rows[0], items);
}

async function make(client: PoolClient, items: z.infer<typeof item>[]) {
  const out: any[] = [];
  for (const x of items) {
    const { rows: pRows } = await client.query("SELECT * FROM products WHERE id = $1", [x.productId]);
    const { rows: qRows } = await client.query("SELECT * FROM product_presentations WHERE id = $1", [x.presentationId]);
    const p = pRows[0], q = qRows[0];
    if (!p || p.active === false || !q || q.active === false) throw Error("Producto o presentación no encontrados o inactivos.");
    if (q.product_id !== x.productId) throw Error("La presentación no pertenece a este producto.");
    out.push({
      id: uuid(), product_id: x.productId, presentation_id: x.presentationId, product_name_snapshot: p.name,
      sku_snapshot: p.sku, presentation_name_snapshot: q.name, unit_equivalence_snapshot: q.unit_equivalence,
      unit_price_cents_snapshot: q.price_cents, quantity: x.quantity, subtotal_cents: q.price_cents * x.quantity,
    });
  }
  return out;
}

async function totals(client: PoolClient, workDayId: string) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::int AS total FROM orders WHERE work_day_id = $1 AND status != 'cancelled'",
    [workDayId]
  );
  await client.query("UPDATE work_days SET order_count = $2, total_cents = $3, updated_at = $4 WHERE id = $1", [workDayId, rows[0].count, rows[0].total, nowIso()]);
}

function invalidateReadCaches() {
  invalidatePullCache("orders");
  invalidateWorkdayCache();
}

ordersRouter.post("/", async (req: AuthedRequest, res) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: "Datos inválidos", details: r.error.flatten() });
  const d = r.data;

  const existing = await pool.query("SELECT id FROM orders WHERE idempotency_key = $1 LIMIT 1", [d.idempotencyKey]);
  if (existing.rows.length > 0) return res.json({ order: await full(existing.rows[0].id), deduped: true });

  const { rows: wdRows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [d.workDayId]);
  const wd = wdRows[0];
  if (!wd) return res.status(404).json({ error: "Jornada no encontrada." });
  if (wd.status === "closed") return res.status(400).json({ error: "La jornada está concluida. Para registrar nuevas preventas debes reabrir la jornada." });

  const { rows: clRows } = await pool.query("SELECT * FROM clients WHERE id = $1", [d.clientId]);
  const cl = clRows[0];
  if (!cl || cl.active === false) return res.status(400).json({ error: "Cliente inválido o inactivo." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const items = await make(client, d.items);
    const sub = items.reduce((n, x) => n + x.subtotal_cents, 0);
    const tax = Math.round((sub * d.taxRatePermille) / 1000);
    const id = uuid(), ts = nowIso();
    const itemCount = items.reduce((n, x) => n + x.quantity, 0);

    // receipt_number se asigna automáticamente vía DEFAULT nextval('receipt_number_seq').
    await client.query(
      `INSERT INTO orders (
         id, idempotency_key, work_day_id, user_id, client_id, payment_condition, tax_rate_permille,
         subtotal_cents, tax_cents, total_cents, item_count, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $12)`,
      [id, d.idempotencyKey, d.workDayId, req.userId, d.clientId, d.paymentCondition, d.taxRatePermille, sub, tax, sub + tax, itemCount, ts]
    );
    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (
           id, order_id, product_id, presentation_id, product_name_snapshot, sku_snapshot,
           presentation_name_snapshot, unit_equivalence_snapshot, unit_price_cents_snapshot, quantity, subtotal_cents, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [it.id, id, it.product_id, it.presentation_id, it.product_name_snapshot, it.sku_snapshot, it.presentation_name_snapshot, it.unit_equivalence_snapshot, it.unit_price_cents_snapshot, it.quantity, it.subtotal_cents, ts]
      );
    }
    await totals(client, d.workDayId);
    await client.query("COMMIT");
    invalidateReadCaches();
    res.status(201).json({ order: await full(id) });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

ordersRouter.get("/:id", async (req, res) => {
  const o = await full(req.params.id);
  if (!o) return res.status(404).json({ error: "Preventa no encontrada." });
  res.json({ order: o });
});

ordersRouter.put("/:id", async (req, res) => {
  const parsed = schema.omit({ idempotencyKey: true, workDayId: true, clientId: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });

  const { rows: oldRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = oldRows[0];
  if (!order) return res.status(404).json({ error: "Preventa no encontrada." });

  const { rows: wdRows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [order.work_day_id]);
  const wd = wdRows[0];
  if (wd && wd.status === "closed") return res.status(400).json({ error: "La jornada está concluida. Para editar preventas debes reabrir la jornada." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const d = parsed.data;
    const items = await make(client, d.items);
    const sub = items.reduce((n, x) => n + x.subtotal_cents, 0);
    const tax = Math.round((sub * d.taxRatePermille) / 1000);
    const ts = nowIso();
    const itemCount = items.reduce((n, x) => n + x.quantity, 0);

    await client.query("DELETE FROM order_items WHERE order_id = $1", [req.params.id]);
    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (
           id, order_id, product_id, presentation_id, product_name_snapshot, sku_snapshot,
           presentation_name_snapshot, unit_equivalence_snapshot, unit_price_cents_snapshot, quantity, subtotal_cents, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [it.id, req.params.id, it.product_id, it.presentation_id, it.product_name_snapshot, it.sku_snapshot, it.presentation_name_snapshot, it.unit_equivalence_snapshot, it.unit_price_cents_snapshot, it.quantity, it.subtotal_cents, ts]
      );
    }
    await client.query(
      "UPDATE orders SET payment_condition = $2, tax_rate_permille = $3, subtotal_cents = $4, tax_cents = $5, total_cents = $6, item_count = $7, updated_at = $8 WHERE id = $1",
      [req.params.id, d.paymentCondition, d.taxRatePermille, sub, tax, sub + tax, itemCount, ts]
    );
    await totals(client, order.work_day_id);
    await client.query("COMMIT");
    invalidateReadCaches();
    res.json({ order: await full(req.params.id) });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

ordersRouter.post("/:id/cancel", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const d = rows[0];
  if (!d) return res.status(404).json({ error: "Preventa no encontrada." });

  const { rows: wdRows } = await pool.query("SELECT * FROM work_days WHERE id = $1", [d.work_day_id]);
  const wd = wdRows[0];
  if (wd && wd.status === "closed") return res.status(400).json({ error: "La jornada está concluida. Para eliminar preventas debes reabrir la jornada." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE orders SET status = 'cancelled', updated_at = $2 WHERE id = $1", [req.params.id, nowIso()]);
    await totals(client, d.work_day_id);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateReadCaches();
  res.json({ ok: true });
});

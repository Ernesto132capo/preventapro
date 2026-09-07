import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

const presentationInput = z.object({ name: z.string().min(1), unitEquivalence: z.number().int().positive(), priceCents: z.number().int().nonnegative(), costCents: z.number().int().nonnegative().default(0), stock: z.number().int().nonnegative().default(0) });
const productSchema = z.object({ sku: z.string().min(1), name: z.string().min(1), categoryId: z.string().optional(), photoUrl: z.string().optional(), baseCostCents: z.number().int().nonnegative().default(0), baseUnitName: z.string().default("Unidad"), presentations: z.array(presentationInput).min(1, "Configura al menos una presentación.") });
const productUpdateSchema = productSchema.omit({ sku: true });

function serialPresentation(row: any) {
  return { id: row.id, product_id: row.product_id, name: row.name, sort_order: row.sort_order, unit_equivalence: row.unit_equivalence, price_cents: row.price_cents, cost_cents: row.cost_cents, active: row.active === false ? 0 : 1, quantity_available: row.quantity_available ?? 0, created_at: row.created_at, updated_at: row.updated_at };
}

async function serialProduct(row: any) {
  const pres = await pool.query(
    "SELECT * FROM product_presentations WHERE product_id = $1 AND active = true ORDER BY sort_order",
    [row.id]
  );
  return {
    id: row.id, sku: row.sku, name: row.name, category_id: row.category_id ?? null, photo_url: row.photo_url ?? null,
    base_cost_cents: row.base_cost_cents ?? 0, base_unit_name: row.base_unit_name ?? "Unidad", active: row.active === false ? 0 : 1,
    created_at: row.created_at, updated_at: row.updated_at,
    presentations: pres.rows.map(serialPresentation),
  };
}

catalogRouter.get("/categories", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM categories WHERE active = true ORDER BY name");
  res.json({ categories: rows.map((r) => ({ ...r, active: 1 })) });
});

catalogRouter.post("/categories", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "El nombre de categoría es obligatorio." });
  const existing = await pool.query("SELECT id FROM categories WHERE name = $1 LIMIT 1", [name]);
  if (existing.rows.length > 0) return res.status(409).json({ error: "Esa categoría ya existe." });
  const id = uuid(), ts = nowIso();
  await pool.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, $3, $3)", [id, name, ts]);
  invalidatePullCache("products");
  res.status(201).json({ id, name });
});

catalogRouter.get("/products", async (req, res) => {
  const { q, categoryId } = req.query as { q?: string; categoryId?: string };
  const conditions: string[] = ["active = true"];
  const params: any[] = [];
  if (categoryId) { params.push(categoryId); conditions.push(`category_id = $${params.length}`); }
  if (q) { params.push(`%${q.toLowerCase()}%`); conditions.push(`(lower(name) || ' ' || lower(sku)) LIKE $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM products WHERE ${conditions.join(" AND ")} ORDER BY name`, params);
  const products = await Promise.all(rows.map(serialProduct));
  res.json({ products });
});

catalogRouter.get("/products/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  const row = rows[0];
  if (!row || row.active === false) return res.status(404).json({ error: "Producto no encontrado." });
  res.json({ product: await serialProduct(row) });
});

catalogRouter.post("/products", async (req: AuthedRequest, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const d = parsed.data;

  const existing = await pool.query("SELECT * FROM products WHERE sku = $1 LIMIT 1", [d.sku]);
  if (existing.rows.length > 0) {
    return res.json({ product: await serialProduct(existing.rows[0]), deduped: true });
  }

  const id = uuid(), ts = nowIso();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO products (id, sku, name, category_id, photo_url, base_cost_cents, base_unit_name, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $9)
       RETURNING *`,
      [id, d.sku, d.name, d.categoryId ?? null, d.photoUrl ?? null, d.baseCostCents, d.baseUnitName, req.userId, ts]
    );
    for (let sortOrder = 0; sortOrder < d.presentations.length; sortOrder++) {
      const p = d.presentations[sortOrder];
      await client.query(
        `INSERT INTO product_presentations (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)`,
        [uuid(), id, p.name, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, p.stock, ts]
      );
    }
    await client.query("COMMIT");
    invalidatePullCache("products");
    res.status(201).json({ product: await serialProduct(rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

catalogRouter.put("/products/:id", async (req: AuthedRequest, res) => {
  const parsed = productUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });

  const existing = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  const old = existing.rows[0];
  if (!old || old.active === false) return res.status(404).json({ error: "Producto no encontrado." });

  const d = parsed.data, ts = nowIso();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE products SET name = $2, category_id = $3, base_cost_cents = $4, base_unit_name = $5, updated_at = $6 WHERE id = $1`,
      [req.params.id, d.name, d.categoryId ?? old.category_id ?? null, d.baseCostCents ?? old.base_cost_cents ?? 0, d.baseUnitName ?? old.base_unit_name ?? "Unidad", ts]
    );

    const current = await client.query("SELECT * FROM product_presentations WHERE product_id = $1", [req.params.id]);
    const names = new Set(d.presentations.map((p) => p.name));
    const byName = new Map(current.rows.map((p: any) => [p.name, p]));

    for (const row of current.rows) {
      if (!names.has(row.name)) {
        await client.query("UPDATE product_presentations SET active = false, updated_at = $2 WHERE id = $1", [row.id, ts]);
      }
    }
    for (let sortOrder = 0; sortOrder < d.presentations.length; sortOrder++) {
      const p = d.presentations[sortOrder];
      const match = byName.get(p.name);
      if (match) {
        await client.query(
          `UPDATE product_presentations SET sort_order = $2, unit_equivalence = $3, price_cents = $4, cost_cents = $5, quantity_available = $6, active = true, updated_at = $7 WHERE id = $1`,
          [match.id, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, p.stock, ts]
        );
      } else {
        await client.query(
          `INSERT INTO product_presentations (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)`,
          [uuid(), req.params.id, p.name, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, p.stock, ts]
        );
      }
    }
    await client.query("COMMIT");
    const { rows: refreshed } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    invalidatePullCache("products");
    res.json({ product: await serialProduct(refreshed[0]) });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

catalogRouter.patch("/presentations/:id/stock", async (req, res) => {
  const { quantityAvailable } = req.body || {};
  if (typeof quantityAvailable !== "number" || quantityAvailable < 0) return res.status(400).json({ error: "quantityAvailable inválido." });
  const { rowCount } = await pool.query(
    "UPDATE product_presentations SET quantity_available = $2, updated_at = $3 WHERE id = $1",
    [req.params.id, quantityAvailable, nowIso()]
  );
  if (rowCount === 0) return res.status(404).json({ error: "Presentación sin registro de inventario." });
  invalidatePullCache("products");
  res.json({ ok: true });
});

catalogRouter.delete("/products/:id", async (req, res) => {
  await pool.query("UPDATE products SET active = false, updated_at = $2 WHERE id = $1", [req.params.id, nowIso()]);
  invalidatePullCache("products");
  res.json({ ok: true });
});

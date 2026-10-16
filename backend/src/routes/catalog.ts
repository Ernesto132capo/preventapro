import { Router } from "express";
import { v4 as uuid } from "uuid";
import { PoolClient } from "pg";
import { z } from "zod";
import { pool, nowIso } from "../db/pg";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCategoryId(
  client: PoolClient | typeof pool,
  categoryId?: string | null,
  categoryName?: string | null,
  ts: string = nowIso()
): Promise<string | null> {
  const cleanCatId = categoryId ? String(categoryId).trim() : null;
  const cleanCatName = categoryName ? String(categoryName).trim() : null;

  if (cleanCatId) {
    // 1. Verificar si existe por ID directo en categories
    const byId = await client.query("SELECT id, active FROM categories WHERE id = $1 LIMIT 1", [cleanCatId]);
    if (byId.rows.length > 0) {
      if (byId.rows[0].active === false) {
        await client.query("UPDATE categories SET active = true, updated_at = $2 WHERE id = $1", [byId.rows[0].id, ts]);
      }
      return byId.rows[0].id;
    }

    // 2. Si no existe por ID, verificar si cleanCatId NO es un UUID (es un nombre textual de categoría)
    if (!UUID_REGEX.test(cleanCatId)) {
      const byName = await client.query("SELECT id, active FROM categories WHERE lower(name) = lower($1) LIMIT 1", [cleanCatId]);
      if (byName.rows.length > 0) {
        if (byName.rows[0].active === false) {
          await client.query("UPDATE categories SET active = true, updated_at = $2 WHERE id = $1", [byName.rows[0].id, ts]);
        }
        return byName.rows[0].id;
      }
      // Crear nueva categoría con este nombre legítimo
      const newCatId = uuid();
      await client.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, $3, $3)", [newCatId, cleanCatId, ts]);
      return newCatId;
    }
  }

  // 3. cleanCatId era un UUID huérfano inexistente (o no se proveyó).
  // Si se proveyó un categoryName válido (no UUID):
  if (cleanCatName && !UUID_REGEX.test(cleanCatName)) {
    const byName = await client.query("SELECT id, active FROM categories WHERE lower(name) = lower($1) LIMIT 1", [cleanCatName]);
    if (byName.rows.length > 0) {
      if (byName.rows[0].active === false) {
        await client.query("UPDATE categories SET active = true, updated_at = $2 WHERE id = $1", [byName.rows[0].id, ts]);
      }
      return byName.rows[0].id;
    }
    const newCatId = cleanCatId && UUID_REGEX.test(cleanCatId) ? cleanCatId : uuid();
    await client.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, $3, $3)", [newCatId, cleanCatName, ts]);
    return newCatId;
  }

  // 4. Si solo viene un UUID huérfano inexistente sin nombre real -> null (no ensuciar catálogo con UUIDs)
  return null;
}

const comboOptionInput = z.object({
  presentationId: z.string().min(1),
  maxQuantity: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional().default(0),
}).passthrough();

const comboDefinitionInput = z.object({
  selectionMin: z.number().int().positive(),
  selectionMax: z.number().int().positive(),
  options: z.array(comboOptionInput).min(1, "Configura al menos una opción para el combo."),
}).passthrough();

const presentationInput = z.object({
  name: z.string().trim().min(1).max(100),
  unitEquivalence: z.number().int().positive().max(1_000_000),
  priceCents: z.number().int().nonnegative().max(2_000_000_000),
  costCents: z.number().int().nonnegative().max(2_000_000_000).default(0),
}).passthrough();

const productSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(250),
  categoryId: z.string().min(1).optional().nullable(),
  categoryName: z.string().trim().min(1).max(100).optional().nullable(),
  photoUrl: z.string().url().max(2_000).optional().nullable(),
  baseCostCents: z.number().int().nonnegative().max(2_000_000_000).default(0),
  baseUnitName: z.string().trim().min(1).max(100).default("Unidad"),
  productType: z.enum(["standard", "combo"]).default("standard"),
  presentations: z.array(presentationInput).min(1, "Configura al menos una presentación.").max(100),
  comboDefinition: comboDefinitionInput.optional().nullable(),
}).passthrough().refine((data) => {
  if (data.productType === "combo") {
    if (!data.comboDefinition) return false;
    if (data.comboDefinition.selectionMax < data.comboDefinition.selectionMin) return false;
  }
  return true;
}, {
  message: "Para un producto combo, la definición de combo es obligatoria y selectionMax debe ser mayor o igual a selectionMin.",
});

const productUpdateSchema = z.object({
  sku: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(250),
  categoryId: z.string().min(1).optional().nullable(),
  categoryName: z.string().trim().min(1).max(100).optional().nullable(),
  photoUrl: z.string().url().max(2_000).optional().nullable(),
  baseCostCents: z.number().int().nonnegative().max(2_000_000_000).default(0),
  baseUnitName: z.string().trim().min(1).max(100).default("Unidad"),
  productType: z.enum(["standard", "combo"]).default("standard"),
  presentations: z.array(presentationInput).min(1, "Configura al menos una presentación.").max(100),
  comboDefinition: comboDefinitionInput.optional().nullable(),
}).passthrough().refine((data) => {
  if (data.productType === "combo") {
    if (!data.comboDefinition) return false;
    if (data.comboDefinition.selectionMax < data.comboDefinition.selectionMin) return false;
  }
  return true;
}, {
  message: "Para un producto combo, la definición de combo es obligatoria y selectionMax debe ser mayor o igual a selectionMin.",
});

function serialPresentation(row: any) {
  return {
    id: row.id,
    product_id: row.product_id,
    name: row.name,
    sort_order: row.sort_order,
    unit_equivalence: row.unit_equivalence,
    price_cents: row.price_cents,
    cost_cents: row.cost_cents,
    active: row.active === false ? 0 : 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function batchLoadProducts(rows: any[], dbClient: PoolClient | typeof pool = pool) {
  if (!rows || rows.length === 0) return [];

  const productIds = rows.map((r) => r.id);

  // 1. Cargar todas las presentaciones de los productos en lote (1 query)
  const presRes = await dbClient.query(
    `SELECT id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at
     FROM product_presentations
     WHERE product_id = ANY($1::text[]) AND active = true
     ORDER BY sort_order`,
    [productIds]
  );

  const presByProductId = new Map<string, any[]>();
  for (const presRow of presRes.rows) {
    const list = presByProductId.get(presRow.product_id) || [];
    list.push(serialPresentation(presRow));
    presByProductId.set(presRow.product_id, list);
  }

  // 2. Cargar definiciones de combos para productos combo en lote (1 query opcional)
  const comboProductIds = rows.filter((r) => r.product_type === "combo").map((r) => r.id);
  const comboDefByProductId = new Map<string, any>();

  if (comboProductIds.length > 0) {
    const comboDefsRes = await dbClient.query(
      `SELECT id, product_id, selection_min, selection_max, active, created_at, updated_at
       FROM combo_definitions
       WHERE product_id = ANY($1::text[]) AND active = true`,
      [comboProductIds]
    );

    const comboDefRows = comboDefsRes.rows;
    if (comboDefRows.length > 0) {
      const comboDefIds = comboDefRows.map((cd: any) => cd.id);

      // 3. Cargar opciones de combos con JOIN a presentations y products en lote (1 query)
      const optionsRes = await dbClient.query(
        `SELECT co.*, pp.name as presentation_name, p.name as product_name, p.id as product_id
         FROM combo_options co
         JOIN product_presentations pp ON co.presentation_id = pp.id
         JOIN products p ON pp.product_id = p.id
         WHERE co.combo_id = ANY($1::text[]) AND co.active = true AND pp.active = true AND p.active = true
         ORDER BY co.sort_order`,
        [comboDefIds]
      );

      const optionsByComboId = new Map<string, any[]>();
      for (const o of optionsRes.rows) {
        const list = optionsByComboId.get(o.combo_id) || [];
        list.push({
          id: o.id,
          combo_id: o.combo_id,
          presentation_id: o.presentation_id,
          product_id: o.product_id,
          product_name: o.product_name,
          presentation_name: o.presentation_name,
          max_quantity: o.max_quantity ?? null,
          sort_order: o.sort_order ?? 0,
          active: o.active === false ? 0 : 1,
        });
        optionsByComboId.set(o.combo_id, list);
      }

      for (const defRow of comboDefRows) {
        comboDefByProductId.set(defRow.product_id, {
          id: defRow.id,
          product_id: defRow.product_id,
          selection_min: defRow.selection_min,
          selection_max: defRow.selection_max,
          active: defRow.active === false ? 0 : 1,
          created_at: defRow.created_at,
          updated_at: defRow.updated_at,
          options: optionsByComboId.get(defRow.id) || [],
        });
      }
    }
  }

  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    category_id: row.category_id ?? null,
    photo_url: row.photo_url ?? null,
    base_cost_cents: row.base_cost_cents ?? 0,
    base_unit_name: row.base_unit_name ?? "Unidad",
    product_type: row.product_type || "standard",
    active: row.active === false ? 0 : 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    presentations: presByProductId.get(row.id) || [],
    combo_definition: comboDefByProductId.get(row.id) || null,
  }));
}

export async function serialProduct(row: any, dbClient: PoolClient | typeof pool = pool) {
  const [product] = await batchLoadProducts([row], dbClient);
  return product;
}

async function syncProductPresentationsAndCombos(
  client: PoolClient,
  productId: string,
  presentations: Array<{ name: string; unitEquivalence: number; priceCents: number; costCents: number }>,
  productType: "standard" | "combo",
  comboDefinition: { selectionMin: number; selectionMax: number; options: Array<{ presentationId: string; maxQuantity?: number | null; sortOrder?: number }> } | null | undefined,
  ts: string
) {
  const current = await client.query("SELECT id, name FROM product_presentations WHERE product_id = $1", [productId]);
  const names = new Set(presentations.map((p) => p.name));
  const byName = new Map(current.rows.map((p: any) => [p.name, p]));

  for (const row of current.rows) {
    if (!names.has(row.name)) {
      await client.query("UPDATE product_presentations SET active = false, updated_at = $2 WHERE id = $1", [row.id, ts]);
    }
  }
  for (let sortOrder = 0; sortOrder < presentations.length; sortOrder++) {
    const p = presentations[sortOrder];
    const match = byName.get(p.name);
    if (match) {
      await client.query(
        `UPDATE product_presentations SET sort_order = $2, unit_equivalence = $3, price_cents = $4, cost_cents = $5, active = true, updated_at = $6 WHERE id = $1`,
        [match.id, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, ts]
      );
    } else {
      await client.query(
        `INSERT INTO product_presentations (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)`,
        [uuid(), productId, p.name, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, ts]
      );
    }
  }

  // Gestionar definición de combo
  if (productType === "combo" && comboDefinition) {
    const existingCombo = await client.query("SELECT id FROM combo_definitions WHERE product_id = $1", [productId]);
    let comboDefId: string;
    if (existingCombo.rows.length > 0) {
      comboDefId = existingCombo.rows[0].id;
      await client.query(
        `UPDATE combo_definitions SET selection_min = $2, selection_max = $3, active = true, updated_at = $4 WHERE id = $1`,
        [comboDefId, comboDefinition.selectionMin, comboDefinition.selectionMax, ts]
      );
    } else {
      comboDefId = uuid();
      await client.query(
        `INSERT INTO combo_definitions (id, product_id, selection_min, selection_max, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [comboDefId, productId, comboDefinition.selectionMin, comboDefinition.selectionMax, ts]
      );
    }

    // Reemplazar opciones de combo
    await client.query("DELETE FROM combo_options WHERE combo_id = $1", [comboDefId]);
    for (let i = 0; i < comboDefinition.options.length; i++) {
      const opt = comboDefinition.options[i];
      await client.query(
        `INSERT INTO combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [uuid(), comboDefId, opt.presentationId, opt.maxQuantity ?? null, opt.sortOrder ?? i]
      );
    }
  } else {
    // Si el producto cambió a estándar, desactivar la definición de combo previa
    await client.query("UPDATE combo_definitions SET active = false, updated_at = $2 WHERE product_id = $1", [productId, ts]);
  }
}

// ─── Categorías CRUD ──────────────────────────────────────────────────────────

catalogRouter.get("/categories", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM categories WHERE active = true ORDER BY name");
    res.json({ categories: rows.map((r) => ({ ...r, active: r.active === false ? 0 : 1 })) });
  } catch (err) {
    next(err);
  }
});

catalogRouter.post("/categories", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1, "El nombre de categoría es obligatorio.").max(100) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
    const { name } = parsed.data;
    if (UUID_REGEX.test(name)) {
      return res.status(400).json({ error: "El nombre de categoría no puede ser un UUID." });
    }
    const existing = await pool.query("SELECT id, active FROM categories WHERE lower(name) = lower($1) LIMIT 1", [name]);
    const ts = nowIso();
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.active === false) {
        // Reactivar categoría previa con el mismo nombre
        await pool.query("UPDATE categories SET active = true, updated_at = $2 WHERE id = $1", [row.id, ts]);
      }
      invalidatePullCache("products");
      return res.json({ category: { id: row.id, name, active: 1, created_at: ts, updated_at: ts } });
    }
    const id = uuid();
    await pool.query("INSERT INTO categories (id, name, active, created_at, updated_at) VALUES ($1, $2, true, $3, $3)", [id, name, ts]);
    invalidatePullCache("products");
    res.status(201).json({ category: { id, name, active: 1, created_at: ts, updated_at: ts } });
  } catch (err) {
    next(err);
  }
});

catalogRouter.put("/categories/:id", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1, "El nombre de categoría es obligatorio.").max(100) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
    const { name } = parsed.data;
    if (UUID_REGEX.test(name)) {
      return res.status(400).json({ error: "El nombre de categoría no puede ser un UUID." });
    }
    const ts = nowIso();
    const { rows } = await pool.query(
      "UPDATE categories SET name = $2, updated_at = $3 WHERE id = $1 RETURNING *",
      [req.params.id, name, ts]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Categoría no encontrada." });
    invalidatePullCache("products");
    res.json({ category: { ...rows[0], active: rows[0].active === false ? 0 : 1 } });
  } catch (err) {
    next(err);
  }
});

catalogRouter.delete("/categories/:id", requireRole("admin"), async (req: AuthedRequest, res, next) => {
  try {
    const ts = nowIso();
    const { rowCount } = await pool.query("UPDATE categories SET active = false, updated_at = $2 WHERE id = $1", [req.params.id, ts]);
    if (rowCount === 0) return res.status(404).json({ error: "Categoría no encontrada." });
    invalidatePullCache("products");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Productos CRUD ───────────────────────────────────────────────────────────

catalogRouter.get("/products", async (req, res, next) => {
  try {
    const { q, categoryId } = req.query as { q?: string; categoryId?: string };
    const conditions: string[] = ["active = true"];
    const params: any[] = [];
    if (categoryId) { params.push(categoryId); conditions.push(`category_id = $${params.length}`); }
    if (q) { params.push(`%${q.toLowerCase()}%`); conditions.push(`(lower(name) || ' ' || lower(sku)) LIKE $${params.length}`); }
    const { rows } = await pool.query(`SELECT * FROM products WHERE ${conditions.join(" AND ")} ORDER BY name`, params);
    // [A-08] Consulta en lote O(1) que elimina el bucle N+1 de presentaciones y combos
    const products = await batchLoadProducts(rows);
    res.json({ products });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/products/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    const row = rows[0];
    if (!row || row.active === false) return res.status(404).json({ error: "Producto no encontrado." });
    res.json({ product: await serialProduct(row) });
  } catch (err) {
    next(err);
  }
});

catalogRouter.post("/products", async (req: AuthedRequest, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const d = parsed.data;

  const existing = await pool.query(
    "SELECT * FROM products WHERE sku = $1 OR lower(name) = lower($2) LIMIT 1",
    [d.sku, d.name]
  );

  const ts = nowIso();

  if (existing.rows.length > 0) {
    const existingRow = existing.rows[0];
    if (existingRow.active !== false) {
      // Producto activo existente: retornar deduplicado
      return res.json({ product: await serialProduct(existingRow), deduped: true });
    }

    // [M-06] Si existía pero estaba inactivo, reactivarlo y actualizar sus datos
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (d.productType === "combo" && d.comboDefinition) {
        const presIds = d.comboDefinition.options.map((o) => o.presentationId);
        const { rows: validPres } = await client.query(
          `SELECT pp.id FROM product_presentations pp
           JOIN products p ON pp.product_id = p.id
           WHERE pp.id = ANY($1) AND pp.active = true AND p.active = true`,
          [presIds]
        );
        if (validPres.length !== presIds.length) {
          throw new Error("Una o más opciones del combo no pertenecen a presentaciones o productos activos.");
        }
      }

      // [M-05] Resolver categoría sin crear nombres que sean cadenas UUID
      const targetCategoryId = await resolveCategoryId(client, d.categoryId, d.categoryName, ts);

      await client.query(
        `UPDATE products
         SET active = true,
             sku = $2,
             name = $3,
             category_id = $4,
             photo_url = COALESCE($5, photo_url),
             base_cost_cents = $6,
             base_unit_name = $7,
             product_type = $8,
             updated_at = $9
         WHERE id = $1`,
        [existingRow.id, d.sku, d.name, targetCategoryId, d.photoUrl ?? null, d.baseCostCents, d.baseUnitName, d.productType, ts]
      );

      await syncProductPresentationsAndCombos(client, existingRow.id, d.presentations, d.productType, d.comboDefinition, ts);

      await client.query("COMMIT");
      invalidatePullCache("products");
      const { rows: refreshed } = await pool.query("SELECT * FROM products WHERE id = $1", [existingRow.id]);
      return res.json({ product: await serialProduct(refreshed[0]), deduped: true });
    } catch (err: any) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      return res.status(400).json({ error: err.message || "Error al reactivar el producto." });
    } finally {
      client.release();
    }
  }

  // Creación de nuevo producto
  const id = uuid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (d.productType === "combo" && d.comboDefinition) {
      const presIds = d.comboDefinition.options.map((o) => o.presentationId);
      const { rows: validPres } = await client.query(
        `SELECT pp.id FROM product_presentations pp
         JOIN products p ON pp.product_id = p.id
         WHERE pp.id = ANY($1) AND pp.active = true AND p.active = true`,
        [presIds]
      );
      if (validPres.length !== presIds.length) {
        throw new Error("Una o más opciones del combo no pertenecen a presentaciones o productos activos.");
      }
    }

    // [M-05] Resolver categoría sin crear nombres que sean cadenas UUID
    const targetCategoryId = await resolveCategoryId(client, d.categoryId, d.categoryName, ts);

    const { rows } = await client.query(
      `INSERT INTO products (id, sku, name, category_id, photo_url, base_cost_cents, base_unit_name, product_type, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $10)
       RETURNING *`,
      [id, d.sku, d.name, targetCategoryId, d.photoUrl ?? null, d.baseCostCents, d.baseUnitName, d.productType, req.userId, ts]
    );

    for (let sortOrder = 0; sortOrder < d.presentations.length; sortOrder++) {
      const p = d.presentations[sortOrder];
      await client.query(
        `INSERT INTO product_presentations (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)`,
        [uuid(), id, p.name, sortOrder, p.unitEquivalence, p.priceCents, p.costCents, ts]
      );
    }

    if (d.productType === "combo" && d.comboDefinition) {
      const comboDefId = uuid();
      await client.query(
        `INSERT INTO combo_definitions (id, product_id, selection_min, selection_max, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [comboDefId, id, d.comboDefinition.selectionMin, d.comboDefinition.selectionMax, ts]
      );
      for (let i = 0; i < d.comboDefinition.options.length; i++) {
        const opt = d.comboDefinition.options[i];
        await client.query(
          `INSERT INTO combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [uuid(), comboDefId, opt.presentationId, opt.maxQuantity ?? null, opt.sortOrder ?? i]
        );
      }
    }

    await client.query("COMMIT");
    invalidatePullCache("products");
    res.status(201).json({ product: await serialProduct(rows[0]) });
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch { /* connection lost */ }
    res.status(400).json({ error: err.message || "Error al registrar el producto." });
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

    if (d.productType === "combo" && d.comboDefinition) {
      const presIds = d.comboDefinition.options.map((o) => o.presentationId);
      const { rows: validPres } = await client.query(
        `SELECT pp.id FROM product_presentations pp
         JOIN products p ON pp.product_id = p.id
         WHERE pp.id = ANY($1) AND pp.active = true AND p.active = true`,
        [presIds]
      );
      if (validPres.length !== presIds.length) {
        throw new Error("Una o más opciones del combo no pertenecen a presentaciones o productos activos.");
      }
    }

    // [M-05] Resolver categoría sin crear nombres que sean cadenas UUID
    let targetCategoryId = old.category_id ?? null;
    if (d.categoryId !== undefined || d.categoryName !== undefined) {
      targetCategoryId = await resolveCategoryId(client, d.categoryId, d.categoryName, ts);
    }

    await client.query(
      `UPDATE products SET name = $2, category_id = $3, base_cost_cents = $4, base_unit_name = $5, product_type = $6, updated_at = $7 WHERE id = $1`,
      [req.params.id, d.name, targetCategoryId, d.baseCostCents ?? old.base_cost_cents ?? 0, d.baseUnitName ?? old.base_unit_name ?? "Unidad", d.productType, ts]
    );

    await syncProductPresentationsAndCombos(client, req.params.id, d.presentations, d.productType, d.comboDefinition, ts);

    await client.query("COMMIT");
    const { rows: refreshed } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    invalidatePullCache("products");
    res.json({ product: await serialProduct(refreshed[0]) });
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch { /* connection lost */ }
    res.status(400).json({ error: err.message || "Error al actualizar el producto." });
  } finally {
    client.release();
  }
});

catalogRouter.delete("/products/:id", requireRole("admin"), async (req: AuthedRequest, res, next) => {
  try {
    const { rowCount } = await pool.query("UPDATE products SET active = false, updated_at = $2 WHERE id = $1", [req.params.id, nowIso()]);
    if (rowCount === 0) return res.status(404).json({ error: "Producto no encontrado." });
    invalidatePullCache("products");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


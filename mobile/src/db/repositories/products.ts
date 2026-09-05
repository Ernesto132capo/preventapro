import { v4 as uuid } from "uuid";
import { getDb } from "../client";
import { enqueue } from "../outbox";
import { Product, Presentation } from "../../domain/types";

export interface ProductWithPresentations extends Product {
  presentations: Presentation[];
}

export async function listProducts(search?: string): Promise<ProductWithPresentations[]> {
  const db = await getDb();
  const products = search && search.trim()
    ? await db.getAllAsync<Product>(
        `SELECT * FROM products WHERE active = 1 AND (name LIKE ? OR sku LIKE ?) ORDER BY name COLLATE NOCASE ASC`,
        [`%${search.trim()}%`, `%${search.trim()}%`]
      )
    : await db.getAllAsync<Product>(`SELECT * FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`);

  const result: ProductWithPresentations[] = [];
  for (const p of products) {
    const presentations = await db.getAllAsync<Presentation>(
      `SELECT * FROM product_presentations WHERE product_id = ? AND active = 1 ORDER BY sort_order ASC`,
      [p.id]
    );
    result.push({ ...p, presentations });
  }
  return result;
}

export async function getProduct(id: string): Promise<ProductWithPresentations | null> {
  const db = await getDb();
  const product = await db.getFirstAsync<Product>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!product) return null;
  const presentations = await db.getAllAsync<Presentation>(
    `SELECT * FROM product_presentations WHERE product_id = ? AND active = 1 ORDER BY sort_order ASC`,
    [id]
  );
  return { ...product, presentations };
}

export interface NewPresentationInput {
  name: string;
  unitEquivalence: number;
  priceCents: number;
  costCents: number;
  stock: number;
}

export interface NewProductInput {
  name: string;
  categoryId?: string;
  presentations: NewPresentationInput[];
}

export interface EditPresentationInput extends NewPresentationInput {
  /** Id local de una presentación ya existente. Si no viene, se crea una nueva. */
  id?: string;
}

export interface UpdateProductInput {
  name: string;
  categoryId?: string;
  presentations: EditPresentationInput[];
}

/** Valida reglas comunes a crear/editar: nombres de presentación no vacíos y únicos. */
function validatePresentations(presentations: { name: string; unitEquivalence: number; priceCents: number; stock: number }[]) {
  if (presentations.length === 0) throw new Error("Configura al menos una presentación.");
  const seen = new Set<string>();
  for (const p of presentations) {
    if (!p.name.trim()) throw new Error("Cada presentación necesita un nombre.");
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`Ya existe una presentación llamada "${p.name}".`);
    seen.add(key);
    if (p.unitEquivalence <= 0) throw new Error(`Equivalencia inválida en "${p.name}".`);
    if (p.priceCents < 0) throw new Error(`Precio inválido en "${p.name}".`);
    if (p.stock < 0) throw new Error(`El stock de "${p.name}" no puede ser negativo.`);
  }
}

/** Genera un identificador interno único. El usuario ya no captura SKU manualmente. */
function generateInternalSku(): string {
  return `AUTO-${uuid().slice(0, 8).toUpperCase()}`;
}

/** Registrar Producto (Fase 9/10) — se guarda localmente al instante y se encola para el backend. */
export async function createProductLocal(input: NewProductInput): Promise<ProductWithPresentations> {
  if (!input.name.trim()) throw new Error("El nombre del producto es obligatorio.");
  validatePresentations(input.presentations);

  const db = await getDb();
  const productId = uuid();
  await db.runAsync(
    `INSERT INTO products (id, sku, name, category_id, base_cost_cents, base_unit_name, active, sync_status)
     VALUES (?, ?, ?, ?, ?, 'Unidad', 1, 'pending')`,
    [productId, generateInternalSku(), input.name.trim(), input.categoryId || null, 0]
  );

  let sortOrder = 0;
  for (const p of input.presentations) {
    const presId = uuid();
    await db.runAsync(
      `INSERT INTO product_presentations
        (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [presId, productId, p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock]
    );
  }

  await enqueue("product", productId, 1);
  return (await getProduct(productId))!;
}

/** Edita un producto ya existente (creado offline o ya sincronizado). Permite agregar, editar o quitar presentaciones. */
export async function updateProductLocal(productId: string, input: UpdateProductInput): Promise<ProductWithPresentations> {
  if (!input.name.trim()) throw new Error("El nombre del producto es obligatorio.");
  validatePresentations(input.presentations);

  const db = await getDb();
  const existing = await db.getFirstAsync<any>(`SELECT id FROM products WHERE id = ?`, [productId]);
  if (!existing) throw new Error("Producto no encontrado.");

  await db.runAsync(`UPDATE products SET name = ?, category_id = ?, sync_status = 'pending' WHERE id = ?`, [
    input.name.trim(),
    input.categoryId || null,
    productId,
  ]);

  const currentPresentations = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM product_presentations WHERE product_id = ? AND active = 1`,
    [productId]
  );
  const keepIds = new Set(input.presentations.filter((p) => p.id).map((p) => p.id));
  for (const row of currentPresentations) {
    if (!keepIds.has(row.id)) {
      await db.runAsync(`UPDATE product_presentations SET active = 0 WHERE id = ?`, [row.id]);
    }
  }

  let sortOrder = 0;
  for (const p of input.presentations) {
    if (p.id) {
      await db.runAsync(
        `UPDATE product_presentations
           SET name = ?, sort_order = ?, unit_equivalence = ?, price_cents = ?, cost_cents = ?, quantity_available = ?, active = 1
         WHERE id = ?`,
        [p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock, p.id]
      );
    } else {
      const presId = uuid();
      await db.runAsync(
        `INSERT INTO product_presentations
          (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [presId, productId, p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock]
      );
    }
  }

  await enqueue("product", productId, 1);
  return (await getProduct(productId))!;
}

/** Borrado (soft delete) de un producto. Nunca se elimina físicamente para no perder historial de preventas. */
export async function deleteProductLocal(productId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE products SET active = 0, sync_status = 'pending' WHERE id = ?`, [productId]);
  await enqueue("product", productId, 1);
}

export async function upsertProductFromServer(serverProduct: any) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO products (id, server_id, sku, name, category_id, base_cost_cents, base_unit_name, active, promo_active, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       sku = excluded.sku, name = excluded.name, category_id = excluded.category_id,
       base_cost_cents = excluded.base_cost_cents, active = excluded.active,
       promo_active = excluded.promo_active, sync_status = 'synced'`,
    [
      serverProduct.id,
      serverProduct.id,
      serverProduct.sku || "",
      serverProduct.name || "",
      serverProduct.category_id ?? null,
      serverProduct.base_cost_cents ?? 0,
      serverProduct.base_unit_name || "Unidad",
      serverProduct.active ?? 1,
      serverProduct.promo_active ?? 0,
    ]
  );
  for (const pres of serverProduct.presentations || []) {
    await db.runAsync(
      `INSERT INTO product_presentations
        (id, server_id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, unit_equivalence = excluded.unit_equivalence, price_cents = excluded.price_cents,
         cost_cents = excluded.cost_cents, quantity_available = excluded.quantity_available, active = excluded.active`,
      [
        pres.id,
        pres.id,
        serverProduct.id,
        pres.name || "",
        pres.sort_order ?? 0,
        pres.unit_equivalence ?? 1,
        pres.price_cents ?? 0,
        pres.cost_cents ?? 0,
        pres.quantity_available ?? 0,
        pres.active ?? 1,
      ]
    );
  }
}

export async function resolveServerProductId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ server_id: string | null; sync_status: string }>(
    `SELECT server_id, sync_status FROM products WHERE id = ?`,
    [localId]
  );
  if (!row) return null;
  if (row.server_id) return row.server_id;
  return row.sync_status === "synced" ? localId : null;
}

export async function resolveServerPresentationId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ server_id: string | null }>(
    `SELECT server_id FROM product_presentations WHERE id = ?`,
    [localId]
  );
  if (!row) return null;
  return row.server_id || null;
}

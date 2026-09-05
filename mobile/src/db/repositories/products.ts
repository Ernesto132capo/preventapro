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
  let localMatch = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM products WHERE server_id = ? OR sku = ?`,
    [serverProduct.id, serverProduct.sku]
  );

  const targetId = localMatch ? localMatch.id : serverProduct.id;

  await db.runAsync(
    `INSERT INTO products (id, server_id, sku, name, category_id, base_cost_cents, base_unit_name, active, promo_active, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       server_id = excluded.server_id, sku = excluded.sku, name = excluded.name,
       category_id = excluded.category_id, base_cost_cents = excluded.base_cost_cents,
       base_unit_name = excluded.base_unit_name, active = excluded.active,
       promo_active = excluded.promo_active, sync_status = 'synced'`,
    [
      targetId,
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

  // Mantener presentaciones existentes por nombre o server_id para no romper las referencias
  // en order_items creadas localmente mientras estaba offline.
  const existingPresentations = await db.getAllAsync<any>(
    `SELECT * FROM product_presentations WHERE product_id = ?`,
    [targetId]
  );

  const serverPresList = serverProduct.presentations || [];
  const serverPresNames = new Set(serverPresList.map((p: any) => (p.name || "").trim().toLowerCase()));

  for (const pres of serverPresList) {
    const presNameKey = (pres.name || "").trim().toLowerCase();
    const match = existingPresentations.find(
      (ep: any) => ep.server_id === pres.id || ep.id === pres.id || (ep.name || "").trim().toLowerCase() === presNameKey
    );

    const presLocalId = match ? match.id : pres.id;

    await db.runAsync(
      `INSERT INTO product_presentations
        (id, server_id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         server_id = excluded.server_id, product_id = excluded.product_id,
         name = excluded.name, sort_order = excluded.sort_order,
         unit_equivalence = excluded.unit_equivalence, price_cents = excluded.price_cents,
         cost_cents = excluded.cost_cents, quantity_available = excluded.quantity_available, active = excluded.active`,
      [
        presLocalId,
        pres.id,
        targetId,
        pres.name || "",
        pres.sort_order ?? 0,
        pres.unit_equivalence ?? 1,
        pres.price_cents ?? 0,
        pres.cost_cents ?? 0,
        pres.quantity_available ?? 0,
        pres.active ?? 1,
      ]
    );

    // Si la presentación local tenía otro ID pero coincide con la del servidor, actualizar ítems de preventas locales
    if (match && match.id !== pres.id) {
      await db.runAsync(
        `UPDATE order_items SET presentation_id = ? WHERE presentation_id = ?`,
        [match.id, pres.id]
      );
    }
  }

  // Desactivar localmente las que fueron eliminadas en el servidor
  for (const ep of existingPresentations) {
    const epNameKey = (ep.name || "").trim().toLowerCase();
    if (!serverPresNames.has(epNameKey) && !serverPresList.some((p: any) => p.id === ep.server_id)) {
      await db.runAsync(`UPDATE product_presentations SET active = 0 WHERE id = ?`, [ep.id]);
    }
  }
}

export async function resolveServerProductId(localId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; server_id: string | null; sync_status: string }>(
    `SELECT id, server_id, sync_status FROM products WHERE id = ? OR server_id = ?`,
    [localId, localId]
  );
  if (row) {
    if (row.server_id) return row.server_id;
    if (row.sync_status === "synced") return row.id;
  }

  // Fallback: buscar por SKU en el snapshot de ítems de preventa
  const item = await db.getFirstAsync<{ sku_snapshot: string }>(
    `SELECT sku_snapshot FROM order_items WHERE product_id = ? LIMIT 1`,
    [localId]
  );
  if (item?.sku_snapshot) {
    const bySku = await db.getFirstAsync<{ id: string; server_id: string | null; sync_status: string }>(
      `SELECT id, server_id, sync_status FROM products WHERE sku = ?`,
      [item.sku_snapshot]
    );
    if (bySku?.server_id) {
      await db.runAsync(`UPDATE order_items SET product_id = ? WHERE product_id = ?`, [bySku.id, localId]);
      return bySku.server_id;
    }
    if (bySku?.sync_status === "synced") return bySku.id;
  }

  return null;
}

export async function resolveServerPresentationId(localId: string): Promise<string | null> {
  const db = await getDb();

  // 1. Coincidencia directa por id
  const byId = await db.getFirstAsync<{ id: string; server_id: string | null }>(
    `SELECT id, server_id FROM product_presentations WHERE id = ?`,
    [localId]
  );
  if (byId?.server_id) return byId.server_id;

  // 2. Coincidencia si localId ya es un server_id
  const byServerId = await db.getFirstAsync<{ server_id: string }>(
    `SELECT server_id FROM product_presentations WHERE server_id = ?`,
    [localId]
  );
  if (byServerId?.server_id) return byServerId.server_id;

  // 3. Fallback inteligente: buscar por el nombre de la presentación en order_items
  const item = await db.getFirstAsync<{ product_id: string; presentation_name_snapshot: string }>(
    `SELECT product_id, presentation_name_snapshot FROM order_items WHERE presentation_id = ? LIMIT 1`,
    [localId]
  );
  if (item?.presentation_name_snapshot) {
    const product = await db.getFirstAsync<{ id: string; server_id: string | null }>(
      `SELECT id, server_id FROM products WHERE id = ? OR server_id = ?`,
      [item.product_id, item.product_id]
    );
    if (product) {
      const presMatch = await db.getFirstAsync<{ id: string; server_id: string | null }>(
        `SELECT id, server_id FROM product_presentations WHERE (product_id = ? OR product_id = ?) AND name = ?`,
        [product.id, product.server_id || product.id, item.presentation_name_snapshot]
      );
      if (presMatch?.server_id) {
        // Reparar el registro de order_items para que apunte al id local vigente
        await db.runAsync(`UPDATE order_items SET presentation_id = ? WHERE presentation_id = ?`, [presMatch.id, localId]);
        return presMatch.server_id;
      }
    }
  }

  return null;
}

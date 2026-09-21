import { v4 as uuid } from "uuid";
import type { SQLiteDatabase } from "expo-sqlite";
import { getDb, nowIso } from "../client";
import { enqueue } from "../outbox";
import { Product, Presentation, ComboDefinition, ComboOption } from "../../domain/types";
import { listRecentProductIdsForClient } from "./orders";

export interface ProductWithPresentations extends Product {
  presentations: Presentation[];
  combo_definition?: ComboDefinition | null;
  is_favorite?: boolean;
}

export interface ListProductsOptions {
  search?: string;
  categoryId?: string | null;
  onlyFavorites?: boolean;
  productIds?: string[];
  limit?: number;
  offset?: number;
}

export async function listFavoriteProductIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ product_id: string }>(`SELECT product_id FROM product_favorites`);
  return new Set(rows.map((r) => r.product_id));
}

export async function isFavoriteLocal(productId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ product_id: string }>(
    `SELECT product_id FROM product_favorites WHERE product_id = ?`,
    [productId]
  );
  return !!row;
}

export async function toggleFavoriteLocal(productId: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db.getFirstAsync<{ product_id: string }>(
    `SELECT product_id FROM product_favorites WHERE product_id = ?`,
    [productId]
  );
  if (existing) {
    await db.runAsync(`DELETE FROM product_favorites WHERE product_id = ?`, [productId]);
    return false;
  } else {
    await db.runAsync(`INSERT INTO product_favorites (product_id, created_at) VALUES (?, ?)`, [productId, nowIso()]);
    return true;
  }
}

/** Hidrata una lista de productos con sus presentaciones y definiciones de combos */
async function hydrateProducts(db: SQLiteDatabase, products: Product[]): Promise<ProductWithPresentations[]> {
  if (products.length === 0) return [];

  const favoriteIds = await listFavoriteProductIds();
  const allIds = Array.from(
    new Set(
      products.flatMap((p) => [p.id, p.server_id]).filter((id): id is string => Boolean(id))
    )
  );
  const placeholders = allIds.map(() => "?").join(",");

  const allPresentations = await db.getAllAsync<Presentation>(
    `SELECT * FROM product_presentations WHERE product_id IN (${placeholders}) AND active = 1 ORDER BY sort_order ASC`,
    allIds
  );
  const byProduct = new Map<string, Presentation[]>();
  for (const pres of allPresentations) {
    const list = byProduct.get(pres.product_id) || [];
    list.push(pres);
    byProduct.set(pres.product_id, list);
  }

  const comboProductIds = Array.from(
    new Set(
      products
        .filter((p) => p.product_type === "combo")
        .flatMap((p) => [p.id, p.server_id])
        .filter((id): id is string => Boolean(id))
    )
  );

  const comboDefsMap = new Map<string, ComboDefinition>();
  if (comboProductIds.length > 0) {
    const ph = comboProductIds.map(() => "?").join(",");
    const defs = await db.getAllAsync<any>(
      `SELECT * FROM combo_definitions WHERE product_id IN (${ph}) AND active = 1`,
      comboProductIds
    );
    if (defs.length > 0) {
      const allDefIds = Array.from(
        new Set(defs.flatMap((d) => [d.id, d.server_id]).filter((id): id is string => Boolean(id)))
      );
      const defPh = allDefIds.map(() => "?").join(",");
      const options = await db.getAllAsync<any>(
        `SELECT co.*, COALESCE(pp.name, 'Opción') as presentation_name, COALESCE(p.name, 'Producto') as product_name, COALESCE(p.id, pp.product_id) as prod_id
         FROM combo_options co
         LEFT JOIN product_presentations pp ON co.presentation_id = pp.id OR (co.presentation_id IS NOT NULL AND co.presentation_id = pp.server_id)
         LEFT JOIN products p ON pp.product_id = p.id OR (pp.product_id IS NOT NULL AND pp.product_id = p.server_id)
         WHERE co.combo_id IN (${defPh}) AND co.active = 1
         ORDER BY co.sort_order ASC`,
        allDefIds
      );
      const optionsByDef = new Map<string, ComboOption[]>();
      for (const opt of options) {
        const list = optionsByDef.get(opt.combo_id) || [];
        list.push({
          id: opt.id,
          server_id: opt.server_id,
          combo_id: opt.combo_id,
          presentation_id: opt.presentation_id,
          product_id: opt.prod_id,
          product_name: opt.product_name || "Producto",
          presentation_name: opt.presentation_name || "Unidad",
          max_quantity: opt.max_quantity,
          sort_order: opt.sort_order,
          active: opt.active,
        });
        optionsByDef.set(opt.combo_id, list);
      }
      for (const def of defs) {
        const opts = optionsByDef.get(def.id) || (def.server_id ? optionsByDef.get(def.server_id) : []) || [];
        const comboObj: ComboDefinition = {
          id: def.id,
          server_id: def.server_id,
          product_id: def.product_id,
          selection_min: def.selection_min,
          selection_max: def.selection_max,
          active: def.active,
          options: opts,
        };
        comboDefsMap.set(def.product_id, comboObj);
        if (def.server_id) comboDefsMap.set(def.server_id, comboObj);
      }
    }
  }

  return products.map((p) => ({
    ...p,
    is_favorite: favoriteIds.has(p.id) || (p.server_id != null && favoriteIds.has(p.server_id)),
    presentations: byProduct.get(p.id) || (p.server_id ? byProduct.get(p.server_id) : []) || [],
    combo_definition: comboDefsMap.get(p.id) || (p.server_id ? comboDefsMap.get(p.server_id) : null) || null,
  }));
}

export async function listProducts(optionsOrSearch?: string | ListProductsOptions): Promise<ProductWithPresentations[]> {
  const db = await getDb();
  let search: string | undefined;
  let categoryId: string | null | undefined;
  let onlyFavorites: boolean | undefined;
  let productIds: string[] | undefined;
  let limit: number | undefined;
  let offset: number | undefined;

  if (typeof optionsOrSearch === "string") {
    search = optionsOrSearch;
  } else if (optionsOrSearch) {
    search = optionsOrSearch.search;
    categoryId = optionsOrSearch.categoryId;
    onlyFavorites = optionsOrSearch.onlyFavorites;
    productIds = optionsOrSearch.productIds;
    limit = optionsOrSearch.limit;
    offset = optionsOrSearch.offset;
  }

  const conditions: string[] = ["p.active = 1"];
  const params: any[] = [];

  if (search && search.trim()) {
    conditions.push("(p.name LIKE ? OR p.sku LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }

  if (categoryId) {
    conditions.push("(p.category_id = ? OR p.category_id IN (SELECT server_id FROM categories WHERE id = ?))");
    params.push(categoryId, categoryId);
  }

  if (onlyFavorites) {
    conditions.push("p.id IN (SELECT product_id FROM product_favorites)");
  }

  if (productIds && productIds.length > 0) {
    const ph = productIds.map(() => "?").join(",");
    conditions.push(`(p.id IN (${ph}) OR p.server_id IN (${ph}))`);
    params.push(...productIds, ...productIds);
  }

  let sql = `SELECT p.* FROM products p WHERE ${conditions.join(" AND ")} ORDER BY p.name COLLATE NOCASE ASC`;
  if (limit) {
    sql += ` LIMIT ?`;
    params.push(limit);
    if (offset) {
      sql += ` OFFSET ?`;
      params.push(offset);
    }
  }

  const products = await db.getAllAsync<Product>(sql, params);
  return hydrateProducts(db, products);
}

/** Devuelve los productos más frecuentes o vendidos en preventas */
export async function listFrequentProducts(limit = 10): Promise<ProductWithPresentations[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ product_id: string }>(
    `SELECT oi.product_id, COUNT(*) as frequency
     FROM order_items oi
     JOIN orders o ON (oi.order_id = o.id OR oi.order_id = o.server_id)
     WHERE o.status = 'active'
     GROUP BY oi.product_id
     ORDER BY frequency DESC
     LIMIT ?`,
    [limit]
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.product_id);
  return listProducts({ productIds: ids });
}

/** Devuelve los productos comprados previamente por este cliente */
export async function listRecentProductsForClient(clientId: string, limit = 6): Promise<ProductWithPresentations[]> {
  const ids = await listRecentProductIdsForClient(clientId, limit);
  if (ids.length === 0) return [];
  return listProducts({ productIds: ids });
}

export async function getProduct(id: string): Promise<ProductWithPresentations | null> {
  const db = await getDb();
  const product = await db.getFirstAsync<Product>(`SELECT * FROM products WHERE id = ? OR server_id = ?`, [id, id]);
  if (!product) return null;
  const hydrated = await hydrateProducts(db, [product]);
  return hydrated[0] || null;
}

export interface NewPresentationInput {
  name: string;
  unitEquivalence: number;
  priceCents: number;
  costCents: number;
  stock?: number;
}

export interface ComboOptionInput {
  presentationId: string;
  maxQuantity?: number | null;
  sortOrder?: number;
}

export interface ComboDefinitionInput {
  selectionMin: number;
  selectionMax: number;
  options: ComboOptionInput[];
}

export interface NewProductInput {
  name: string;
  categoryId?: string;
  productType?: "standard" | "combo";
  presentations: NewPresentationInput[];
  comboDefinition?: ComboDefinitionInput;
}

export interface EditPresentationInput extends NewPresentationInput {
  /** Id local de una presentación ya existente. Si no viene, se crea una nueva. */
  id?: string;
}

export interface UpdateProductInput {
  name: string;
  categoryId?: string;
  productType?: "standard" | "combo";
  presentations: EditPresentationInput[];
  comboDefinition?: ComboDefinitionInput;
}

/** Valida reglas comunes a crear/editar: nombres de presentación no vacíos y únicos. */
function validatePresentations(presentations: { name: string; unitEquivalence: number; priceCents: number; stock?: number }[]) {
  if (presentations.length === 0) throw new Error("Configura al menos una presentación.");
  const seen = new Set<string>();
  for (const p of presentations) {
    if (!p.name.trim()) throw new Error("Cada presentación necesita un nombre.");
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`Ya existe una presentación llamada "${p.name}".`);
    seen.add(key);
    if (p.unitEquivalence <= 0) throw new Error(`Equivalencia inválida en "${p.name}".`);
    if (p.priceCents < 0) throw new Error(`Precio inválido en "${p.name}".`);
  }
}

function validateComboDefinition(comboDef?: ComboDefinitionInput) {
  if (!comboDef) throw new Error("Configura la regla y opciones del combo.");
  if (comboDef.selectionMin <= 0) throw new Error("La cantidad mínima debe ser mayor a cero.");
  if (comboDef.selectionMax < comboDef.selectionMin) throw new Error("La cantidad máxima no puede ser menor al mínimo.");
  if (!comboDef.options || comboDef.options.length === 0) throw new Error("Agrega al menos una opción para el combo.");
}

/** Genera un identificador interno único. El usuario ya no captura SKU manualmente. */
function generateInternalSku(): string {
  return `AUTO-${uuid().slice(0, 8).toUpperCase()}`;
}

/** Registrar Producto (Fase 9/10) — se guarda localmente al instante y se encola para el backend. */
export async function createProductLocal(input: NewProductInput): Promise<ProductWithPresentations> {
  if (!input.name.trim()) throw new Error("El nombre del producto es obligatorio.");
  validatePresentations(input.presentations);

  const productType = input.productType || "standard";
  if (productType === "combo") {
    validateComboDefinition(input.comboDefinition);
  }

  const db = await getDb();
  const productId = uuid();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO products (id, sku, name, category_id, base_cost_cents, base_unit_name, product_type, active, sync_status)
       VALUES (?, ?, ?, ?, ?, 'Unidad', ?, 1, 'pending')`,
      [productId, generateInternalSku(), input.name.trim(), input.categoryId || null, 0, productType]
    );

    let sortOrder = 0;
    for (const p of input.presentations) {
      const presId = uuid();
      await db.runAsync(
        `INSERT INTO product_presentations
          (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [presId, productId, p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock ?? 0]
      );
    }

    if (productType === "combo" && input.comboDefinition) {
      const comboDefId = uuid();
      await db.runAsync(
        `INSERT INTO combo_definitions (id, product_id, selection_min, selection_max, active, sync_status)
         VALUES (?, ?, ?, ?, 1, 'pending')`,
        [comboDefId, productId, input.comboDefinition.selectionMin, input.comboDefinition.selectionMax]
      );

      for (let i = 0; i < input.comboDefinition.options.length; i++) {
        const opt = input.comboDefinition.options[i];
        await db.runAsync(
          `INSERT INTO combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active, sync_status)
           VALUES (?, ?, ?, ?, ?, 1, 'pending')`,
          [uuid(), comboDefId, opt.presentationId, opt.maxQuantity ?? null, opt.sortOrder ?? i]
        );
      }
    }
  });

  await enqueue("product", productId, 1);
  return (await getProduct(productId))!;
}

/** Edita un producto ya existente (creado offline o ya sincronizado). Permite agregar, editar o quitar presentaciones. */
export async function updateProductLocal(productId: string, input: UpdateProductInput): Promise<ProductWithPresentations> {
  if (!input.name.trim()) throw new Error("El nombre del producto es obligatorio.");
  validatePresentations(input.presentations);

  const productType = input.productType || "standard";
  if (productType === "combo") {
    validateComboDefinition(input.comboDefinition);
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<any>(`SELECT id, server_id FROM products WHERE id = ? OR server_id = ?`, [productId, productId]);
  if (!existing) throw new Error("Producto no encontrado.");
  const localProdId = existing.id;
  const serverProdId = existing.server_id;

  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE products SET name = ?, category_id = ?, product_type = ?, sync_status = 'pending' WHERE id = ?`, [
      input.name.trim(),
      input.categoryId || null,
      productType,
      localProdId,
    ]);

    const currentPresentations = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM product_presentations WHERE (product_id = ? OR (product_id = ? AND product_id IS NOT NULL)) AND active = 1`,
      [localProdId, serverProdId]
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
          [p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock ?? 0, p.id]
        );
      } else {
        const presId = uuid();
        await db.runAsync(
          `INSERT INTO product_presentations
            (id, product_id, name, sort_order, unit_equivalence, price_cents, cost_cents, quantity_available, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [presId, localProdId, p.name.trim(), sortOrder++, p.unitEquivalence, p.priceCents, p.costCents, p.stock ?? 0]
        );
      }
    }

    if (productType === "combo" && input.comboDefinition) {
      const existingDef = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM combo_definitions WHERE product_id = ? OR (product_id = ? AND product_id IS NOT NULL)`,
        [localProdId, serverProdId]
      );
      let comboDefId: string;
      if (existingDef) {
        comboDefId = existingDef.id;
        await db.runAsync(
          `UPDATE combo_definitions SET product_id = ?, selection_min = ?, selection_max = ?, active = 1, sync_status = 'pending' WHERE id = ?`,
          [localProdId, input.comboDefinition.selectionMin, input.comboDefinition.selectionMax, comboDefId]
        );
      } else {
        comboDefId = uuid();
        await db.runAsync(
          `INSERT INTO combo_definitions (id, product_id, selection_min, selection_max, active, sync_status)
           VALUES (?, ?, ?, ?, 1, 'pending')`,
          [comboDefId, localProdId, input.comboDefinition.selectionMin, input.comboDefinition.selectionMax]
        );
      }

      await db.runAsync(`DELETE FROM combo_options WHERE combo_id = ?`, [comboDefId]);
      for (let i = 0; i < input.comboDefinition.options.length; i++) {
        const opt = input.comboDefinition.options[i];
        await db.runAsync(
          `INSERT INTO combo_options (id, combo_id, presentation_id, max_quantity, sort_order, active, sync_status)
           VALUES (?, ?, ?, ?, ?, 1, 'pending')`,
          [uuid(), comboDefId, opt.presentationId, opt.maxQuantity ?? null, opt.sortOrder ?? i]
        );
      }
    } else {
      await db.runAsync(
        `UPDATE combo_definitions SET active = 0, sync_status = 'pending' WHERE product_id = ? OR (product_id = ? AND product_id IS NOT NULL)`,
        [localProdId, serverProdId]
      );
    }
  });

  await enqueue("product", localProdId, 1, "update");
  return (await getProduct(localProdId))!;
}

/** Borrado (soft delete) de un producto. Nunca se elimina físicamente para no perder historial de preventas. */
export async function deleteProductLocal(productId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE products SET active = 0, sync_status = 'pending' WHERE id = ? OR server_id = ?`, [productId, productId]);
  const product = await db.getFirstAsync<{ id: string }>(`SELECT id FROM products WHERE id = ? OR server_id = ?`, [productId, productId]);
  if (product) {
    await enqueue("product", product.id, 1, "delete");
  }
}

export async function upsertProductFromServer(serverProduct: any) {
  const db = await getDb();
  let localMatch = await db.getFirstAsync<{ id: string; sync_status: string }>(
    `SELECT id, sync_status FROM products WHERE server_id = ? OR sku = ?`,
    [serverProduct.id, serverProduct.sku]
  );

  // Si el producto local tiene cambios pendientes de subir, no sobreescribir
  if (localMatch && localMatch.sync_status === "pending") {
    return;
  }

  const targetId = localMatch ? localMatch.id : serverProduct.id;

  await db.runAsync(
    `INSERT INTO products (id, server_id, sku, name, category_id, base_cost_cents, base_unit_name, product_type, active, promo_active, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       server_id = excluded.server_id, sku = excluded.sku, name = excluded.name,
       category_id = excluded.category_id, base_cost_cents = excluded.base_cost_cents,
       base_unit_name = excluded.base_unit_name, product_type = excluded.product_type,
       active = excluded.active, promo_active = excluded.promo_active, sync_status = 'synced'`,
    [
      targetId,
      serverProduct.id,
      serverProduct.sku || "",
      serverProduct.name || "",
      serverProduct.category_id ?? null,
      serverProduct.base_cost_cents ?? 0,
      serverProduct.base_unit_name || "Unidad",
      serverProduct.product_type || "standard",
      serverProduct.active ?? 1,
      serverProduct.promo_active ?? 0,
    ]
  );

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

  // 1. Coincidencia directa por id o server_id
  const byId = await db.getFirstAsync<{ id: string; server_id: string | null }>(
    `SELECT id, server_id FROM product_presentations WHERE id = ? OR server_id = ?`,
    [localId, localId]
  );
  if (byId) {
    return byId.server_id || byId.id;
  }

  // 2. Fallback inteligente: buscar por el nombre de la presentación en order_items
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
      if (presMatch) {
        await db.runAsync(`UPDATE order_items SET presentation_id = ? WHERE presentation_id = ?`, [presMatch.id, localId]);
        return presMatch.server_id || presMatch.id;
      }
    }
  }

  return localId;
}

import { PoolClient } from "pg";

type CatalogItem = { productId: string; presentationId: string; selections?: Array<{ selectedPresentationId: string }> };

/** Una consulta por conjunto, sin volver a leer cada producto por cada línea. */
export async function loadOrderCatalog(client: PoolClient, items: CatalogItem[]) {
  const productIds = [...new Set(items.map((it) => it.productId))];
  const presentationIds = [...new Set(items.map((it) => it.presentationId))];
  const selectionIds = [...new Set(items.flatMap((it) => (it.selections || []).map((s) => s.selectedPresentationId)))];
  const products = (await client.query(
    `SELECT id, name, sku, product_type, active FROM products WHERE ${productIds.length === 1 ? "id = $1" : "id = ANY($1::text[])"}`,
    [productIds.length === 1 ? productIds[0] : productIds]
  )).rows;
  const presentations = (await client.query(
    `SELECT id, product_id, name, unit_equivalence, price_cents, active FROM product_presentations WHERE ${presentationIds.length === 1 ? "id = $1" : "id = ANY($1::text[])"}`,
    [presentationIds.length === 1 ? presentationIds[0] : presentationIds]
  )).rows;
  const comboProductIds = products.filter((p) => p.product_type === "combo").map((p) => p.id);
  const definitions = comboProductIds.length > 0 ? (await client.query(
    comboProductIds.length === 1
      ? "SELECT * FROM combo_definitions WHERE product_id = $1 AND active = true LIMIT 1"
      : "SELECT * FROM combo_definitions WHERE product_id = ANY($1::text[]) AND active = true",
    [comboProductIds.length === 1 ? comboProductIds[0] : comboProductIds]
  )).rows : [];
  const definitionIds = definitions.map((d) => d.id);
  const options = definitionIds.length > 0 ? (await client.query(
    definitionIds.length === 1
      ? "SELECT * FROM combo_options WHERE combo_id = $1 AND active = true"
      : "SELECT * FROM combo_options WHERE combo_id = ANY($1::text[]) AND active = true",
    [definitionIds.length === 1 ? definitionIds[0] : definitionIds]
  )).rows : [];
  const selections = selectionIds.length > 0 ? (await client.query(
    `SELECT pp.id, pp.name as pres_name, p.name as prod_name, p.id as prod_id
     FROM product_presentations pp JOIN products p ON pp.product_id = p.id
     WHERE ${selectionIds.length === 1 ? "pp.id = $1" : "pp.id = ANY($1::text[])"} AND pp.active = true AND p.active = true`,
    [selectionIds.length === 1 ? selectionIds[0] : selectionIds]
  )).rows : [];
  return {
    products: new Map(products.map((p) => [p.id, p])),
    presentations: new Map(presentations.map((p) => [p.id, p])),
    definitions: new Map(definitions.map((d) => [d.product_id, d])),
    options,
    selections: new Map(selections.map((s) => [s.id, s])),
  };
}

async function insertRows(client: PoolClient, table: string, columns: string[], rows: unknown[][]) {
  // 1000 filas mantiene el número de parámetros por debajo del límite de PostgreSQL.
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const chunk = rows.slice(offset, offset + 1000);
    const values = chunk.map((row, rowIndex) => `(${row.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(", ")})`).join(", ");
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, chunk.flat());
  }
}

/** Debe ejecutarse dentro de la transacción de cabecera, detalle y totales. */
export async function insertOrderItems(client: PoolClient, orderId: string, items: any[], timestamp: string) {
  await insertRows(client, "order_items", ["id", "order_id", "product_id", "presentation_id", "product_name_snapshot", "sku_snapshot", "presentation_name_snapshot", "unit_equivalence_snapshot", "unit_price_cents_snapshot", "quantity", "subtotal_cents", "created_at"],
    items.map((it) => [it.id, orderId, it.product_id, it.presentation_id, it.product_name_snapshot, it.sku_snapshot, it.presentation_name_snapshot, it.unit_equivalence_snapshot, it.unit_price_cents_snapshot, it.quantity, it.subtotal_cents, timestamp]));
  await insertRows(client, "order_item_selections", ["id", "order_item_id", "selected_product_id", "selected_presentation_id", "product_name_snapshot", "presentation_name_snapshot", "quantity", "sort_order", "created_at"],
    items.flatMap((it) => (it.selections || []).map((sel: any, i: number) => [sel.id, it.id, sel.selected_product_id, sel.selected_presentation_id, sel.product_name_snapshot, sel.presentation_name_snapshot, sel.quantity, sel.sort_order ?? i, timestamp])));
}

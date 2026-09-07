/**
 * Migración histórica: Firestore → Neon (Postgres).
 *
 * Uso:
 *   DATABASE_URL="postgres://...neon.tech/neondb?sslmode=require" npx tsx scripts/migrate-firestore-to-neon.ts
 *
 * Requisitos:
 *   - backend/firebase-service-account.json presente (o GOOGLE_APPLICATION_CREDENTIALS /
 *     FIREBASE_SERVICE_ACCOUNT), tal como ya lo usa el backend hoy.
 *   - DATABASE_URL apuntando a Neon (connection string pooleado).
 *   - El esquema de Postgres (backend/db/schema.sql o el ya aplicado en Neon) debe existir
 *     de antemano — este script NO crea tablas, solo inserta datos.
 *
 * Idempotencia:
 *   Cada tabla se puebla con INSERT ... ON CONFLICT (id) DO UPDATE, así que correr el
 *   script varias veces nunca duplica filas — simplemente vuelve a escribir los mismos
 *   valores (o los actualiza si Firestore cambió entre corridas).
 *
 * Orden de migración (respeta dependencias de FK):
 *   users → neighborhoods → categories → clients → products → product_presentations
 *   → work_days → orders → order_items
 */

import "dotenv/config";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pg";
import { col, firestore, getReceiptCounterValue } from "../src/db/firestore";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades genéricas
// ─────────────────────────────────────────────────────────────────────────────

/** Firestore no distingue `false` de "no seteado": tratamos ambos como default true,
 *  igual que ya hacen las rutas actuales (`d.active === false ? 0 : 1`). */
const isActive = (v: unknown): boolean => v !== false;

/** Timestamp de respaldo para documentos legados sin createdAt/updatedAt. */
const tsOrNow = (v: unknown): string => (typeof v === "string" && v ? v : new Date().toISOString());

interface MigrationSummary {
  table: string;
  read: number;
  inserted: number;
  skipped: number;
}

const summaries: MigrationSummary[] = [];

/**
 * Inserta/actualiza filas en lotes usando ON CONFLICT (id) DO UPDATE.
 * `columns` debe incluir "id" como primera columna.
 */
async function upsertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunkSize = 500
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, rIdx) => {
        const base = rIdx * columns.length;
        values.push(...row);
        return `(${columns.map((_, cIdx) => `$${base + cIdx + 1}`).join(",")})`;
      })
      .join(",");
    const updateSet = columns
      .filter((c) => c !== "id")
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}
      ON CONFLICT (id) DO UPDATE SET ${updateSet}`;
    await client.query(sql, values as any[]);
    total += chunk.length;
  }
  return total;
}

async function migrateTable(
  table: string,
  columns: string[],
  rows: unknown[][],
  readCount: number,
  skipped = 0
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await upsertRows(client, table, columns, rows);
    await client.query("COMMIT");
    summaries.push({ table, read: readCount, inserted, skipped });
    console.log(`✔ ${table}: ${inserted} filas insertadas/actualizadas (leídas: ${readCount}, omitidas: ${skipped})`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`✘ Error migrando ${table}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("── Migración Firestore → Neon ──────────────────────────────\n");

  // Sets de IDs válidos, poblados a medida que migramos (respetan el orden de
  // dependencias de FK). Sirven para no violar integridad referencial si hay
  // datos huérfanos en Firestore (referencias a documentos borrados, etc).
  const userIds = new Set<string>();
  const neighborhoodIds = new Set<string>();
  const categoryIds = new Set<string>();
  const clientIds = new Set<string>();
  const productIds = new Set<string>();
  const presentationIds = new Set<string>();
  const workDayIds = new Set<string>();
  const orderIds = new Set<string>();

  // ── users ───────────────────────────────────────────────────────────────
  {
    const snap = await col.users.get();
    const columns = ["id", "code", "real_email", "full_name", "active", "created_at", "updated_at"];
    const rows = snap.docs.map((d) => {
      const x = d.data() as any;
      userIds.add(d.id);
      return [d.id, x.code ?? d.id, x.realEmail ?? null, x.fullName ?? "", isActive(x.active), tsOrNow(x.createdAt), tsOrNow(x.updatedAt)];
    });
    await migrateTable("users", columns, rows, snap.size);
  }

  // ── neighborhoods ───────────────────────────────────────────────────────
  {
    const snap = await col.neighborhoods.get();
    const columns = ["id", "name", "active"];
    const rows = snap.docs.map((d) => {
      const x = d.data() as any;
      neighborhoodIds.add(d.id);
      return [d.id, x.name ?? "", isActive(x.active)];
    });
    await migrateTable("neighborhoods", columns, rows, snap.size);
  }

  // ── categories ──────────────────────────────────────────────────────────
  {
    const snap = await col.categories.get();
    const columns = ["id", "name", "active", "created_at", "updated_at"];
    const rows = snap.docs.map((d) => {
      const x = d.data() as any;
      categoryIds.add(d.id);
      return [d.id, x.name ?? "", isActive(x.active), tsOrNow(x.createdAt), tsOrNow(x.updatedAt)];
    });
    await migrateTable("categories", columns, rows, snap.size);
  }

  // ── clients ─────────────────────────────────────────────────────────────
  {
    const snap = await col.clients.get();
    const columns = [
      "id", "client_code", "business_name", "contact_name", "phone", "neighborhood_id",
      "address", "lat", "lng", "visit_status", "active", "assigned_user_id", "created_by",
      "client_local_id", "created_at", "updated_at",
    ];
    let skipped = 0;
    const rows: unknown[][] = [];
    for (const d of snap.docs) {
      const x = d.data() as any;
      if (!x.businessName) {
        console.warn(`  ⚠ clients/${d.id}: sin businessName, se omite.`);
        skipped++;
        continue;
      }
      const neighborhoodId = x.neighborhoodId && neighborhoodIds.has(x.neighborhoodId) ? x.neighborhoodId : null;
      if (x.neighborhoodId && !neighborhoodId) console.warn(`  ⚠ clients/${d.id}: neighborhoodId "${x.neighborhoodId}" no existe, se deja null.`);
      const assignedUserId = x.assignedUserId && userIds.has(x.assignedUserId) ? x.assignedUserId : null;
      const createdBy = x.createdBy && userIds.has(x.createdBy) ? x.createdBy : null;
      clientIds.add(d.id);
      rows.push([
        d.id, x.clientCode ?? null, x.businessName, x.contactName ?? null, x.phone ?? null, neighborhoodId,
        x.address ?? null, x.lat ?? null, x.lng ?? null, x.visitStatus ?? "pending", isActive(x.active),
        assignedUserId, createdBy, x.clientLocalId ?? null, tsOrNow(x.createdAt), tsOrNow(x.updatedAt),
      ]);
    }
    await migrateTable("clients", columns, rows, snap.size, skipped);
  }

  // ── products ────────────────────────────────────────────────────────────
  {
    const snap = await col.products.get();
    const columns = [
      "id", "sku", "name", "category_id", "photo_url", "base_cost_cents", "base_unit_name",
      "active", "created_by", "created_at", "updated_at",
    ];
    let skipped = 0;
    const rows: unknown[][] = [];
    for (const d of snap.docs) {
      const x = d.data() as any;
      if (!x.sku || !x.name) {
        console.warn(`  ⚠ products/${d.id}: sin sku/name, se omite.`);
        skipped++;
        continue;
      }
      const categoryId = x.categoryId && categoryIds.has(x.categoryId) ? x.categoryId : null;
      if (x.categoryId && !categoryId) console.warn(`  ⚠ products/${d.id}: categoryId "${x.categoryId}" no existe, se deja null.`);
      const createdBy = x.createdBy && userIds.has(x.createdBy) ? x.createdBy : null;
      productIds.add(d.id);
      rows.push([
        d.id, x.sku, x.name, categoryId, x.photoUrl ?? null, x.baseCostCents ?? 0, x.baseUnitName ?? "Unidad",
        isActive(x.active), createdBy, tsOrNow(x.createdAt), tsOrNow(x.updatedAt),
      ]);
    }
    await migrateTable("products", columns, rows, snap.size, skipped);
  }

  // ── product_presentations (subcolección products/{id}/presentations) ─────
  // Firestore guarda el stock en el campo `stock`; Postgres lo llama
  // `quantity_available` (ya está fusionado en la misma tabla, sin tabla
  // `inventory` aparte).
  {
    const snap = await firestore.collectionGroup("presentations").get();
    const columns = [
      "id", "product_id", "name", "sort_order", "unit_equivalence", "price_cents",
      "cost_cents", "quantity_available", "active", "created_at", "updated_at",
    ];
    let skipped = 0;
    const rows: unknown[][] = [];
    for (const d of snap.docs) {
      const x = d.data() as any;
      const productId = x.productId || d.ref.parent?.parent?.id || null;
      if (!productId || !productIds.has(productId)) {
        console.warn(`  ⚠ presentations/${d.id}: product_id "${productId}" no existe, se omite.`);
        skipped++;
        continue;
      }
      presentationIds.add(d.id);
      rows.push([
        d.id, productId, x.name ?? "", x.sortOrder ?? 0, x.unitEquivalence ?? 1, x.priceCents ?? 0,
        x.costCents ?? 0, x.stock ?? 0, isActive(x.active), tsOrNow(x.createdAt), tsOrNow(x.updatedAt),
      ]);
    }
    await migrateTable("product_presentations", columns, rows, snap.size, skipped);
  }

  // ── work_days ───────────────────────────────────────────────────────────
  {
    const snap = await col.workDays.get();
    const columns = [
      "id", "user_id", "work_date", "status", "order_count", "total_cents",
      "auto_closed", "created_at", "updated_at", "closed_at",
    ];
    let skipped = 0;
    const rows: unknown[][] = [];
    for (const d of snap.docs) {
      const x = d.data() as any;
      if (!x.userId || !userIds.has(x.userId)) {
        console.warn(`  ⚠ work_days/${d.id}: userId "${x.userId}" no existe, se omite (columna NOT NULL).`);
        skipped++;
        continue;
      }
      workDayIds.add(d.id);
      rows.push([
        d.id, x.userId, x.workDate ?? "", x.status ?? "open", x.orderCount ?? 0, x.totalCents ?? 0,
        x.autoClosed === true, tsOrNow(x.createdAt), tsOrNow(x.updatedAt || x.createdAt), x.closedAt ?? null,
      ]);
    }
    await migrateTable("work_days", columns, rows, snap.size, skipped);
  }

  // ── orders ──────────────────────────────────────────────────────────────
  // El correlativo de boletas (receipt_number) se resuelve así:
  //  1. Se toma tal cual para toda orden que ya lo tenga en Firestore.
  //  2. Para órdenes legadas sin receiptNumber (creadas antes de existir el
  //     correlativo), se les asigna uno nuevo de forma determinística —
  //     ordenadas por created_at y luego por id — continuando después del
  //     máximo ya visto. Esto hace que el script sea seguro de re-ejecutar:
  //     mientras Firestore no cambie, siempre asigna los mismos números.
  let receiptSequenceCeiling = await getReceiptCounterValue();
  {
    const snap = await col.orders.get();
    const columns = [
      "id", "idempotency_key", "work_day_id", "user_id", "client_id", "status",
      "payment_condition", "tax_rate_permille", "subtotal_cents", "tax_cents",
      "total_cents", "item_count", "receipt_number", "created_at", "updated_at",
    ];
    let skipped = 0;
    const withNumber: { id: string; row: unknown[] }[] = [];
    const withoutNumber: { id: string; createdAt: string; base: any }[] = [];

    for (const d of snap.docs) {
      const x = d.data() as any;
      if (!x.workDayId || !workDayIds.has(x.workDayId)) {
        console.warn(`  ⚠ orders/${d.id}: work_day_id "${x.workDayId}" no existe, se omite.`);
        skipped++;
        continue;
      }
      if (!x.userId || !userIds.has(x.userId)) {
        console.warn(`  ⚠ orders/${d.id}: user_id "${x.userId}" no existe, se omite.`);
        skipped++;
        continue;
      }
      if (!x.clientId || !clientIds.has(x.clientId)) {
        console.warn(`  ⚠ orders/${d.id}: client_id "${x.clientId}" no existe, se omite.`);
        skipped++;
        continue;
      }
      const createdAt = tsOrNow(x.createdAt);
      const base = [
        d.id, x.idempotencyKey ?? d.id, x.workDayId, x.userId, x.clientId, x.status ?? "active",
        x.paymentCondition ?? "Contado 48h", x.taxRatePermille ?? 0, x.subtotalCents ?? 0, x.taxCents ?? 0,
        x.totalCents ?? 0, x.itemCount ?? 0,
      ];
      orderIds.add(d.id);
      if (typeof x.receiptNumber === "number" && x.receiptNumber > 0) {
        receiptSequenceCeiling = Math.max(receiptSequenceCeiling, x.receiptNumber);
        withNumber.push({ id: d.id, row: [...base, x.receiptNumber, createdAt, tsOrNow(x.updatedAt)] });
      } else {
        withoutNumber.push({ id: d.id, createdAt, base: [...base, createdAt, tsOrNow(x.updatedAt)] });
      }
    }

    // Asignación determinística para las que no traían receiptNumber.
    withoutNumber.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const resolvedWithoutNumber = withoutNumber.map(({ base }) => {
      receiptSequenceCeiling += 1;
      const [id, idem, wd, uid, cid, status, pc, trp, sub, tax, total, count, createdAt, updatedAt] = base;
      return [id, idem, wd, uid, cid, status, pc, trp, sub, tax, total, count, receiptSequenceCeiling, createdAt, updatedAt];
    });

    const rows = [...withNumber.map((o) => o.row), ...resolvedWithoutNumber];
    if (withoutNumber.length > 0) {
      console.log(`  ℹ ${withoutNumber.length} preventa(s) sin receipt_number en Firestore: se les asignó correlativo nuevo (${receiptSequenceCeiling - withoutNumber.length + 1}–${receiptSequenceCeiling}).`);
    }
    await migrateTable("orders", columns, rows, snap.size, skipped);
  }

  // ── order_items (subcolección orders/{id}/items) ──────────────────────────
  // Los items ya se guardan en Firestore con nombres de campo snake_case
  // (ver src/routes/orders.ts → make()), así que el mapeo es casi 1:1.
  {
    const snap = await firestore.collectionGroup("items").get();
    const columns = [
      "id", "order_id", "product_id", "presentation_id", "product_name_snapshot", "sku_snapshot",
      "presentation_name_snapshot", "unit_equivalence_snapshot", "unit_price_cents_snapshot",
      "quantity", "subtotal_cents", "created_at",
    ];
    let skipped = 0;
    const rows: unknown[][] = [];
    for (const d of snap.docs) {
      const x = d.data() as any;
      const orderId = d.ref.parent?.parent?.id || null;
      if (!orderId || !orderIds.has(orderId)) {
        console.warn(`  ⚠ order_items/${d.id}: order_id "${orderId}" no existe, se omite.`);
        skipped++;
        continue;
      }
      if (!x.product_id || !productIds.has(x.product_id)) {
        console.warn(`  ⚠ order_items/${d.id}: product_id "${x.product_id}" no existe, se omite.`);
        skipped++;
        continue;
      }
      if (!x.presentation_id || !presentationIds.has(x.presentation_id)) {
        console.warn(`  ⚠ order_items/${d.id}: presentation_id "${x.presentation_id}" no existe, se omite.`);
        skipped++;
        continue;
      }
      rows.push([
        d.id, orderId, x.product_id, x.presentation_id, x.product_name_snapshot ?? "", x.sku_snapshot ?? "",
        x.presentation_name_snapshot ?? "", x.unit_equivalence_snapshot ?? 1, x.unit_price_cents_snapshot ?? 0,
        x.quantity ?? 0, x.subtotal_cents ?? 0, x.created_at ?? tsOrNow(undefined),
      ]);
    }
    await migrateTable("order_items", columns, rows, snap.size, skipped);
  }

  // ── Secuencia de boletas ───────────────────────────────────────────────
  // Continúa exactamente donde se quedó: nunca repite ni salta un número.
  await pool.query("SELECT setval('receipt_number_seq', $1)", [receiptSequenceCeiling]);
  console.log(`\n✔ receipt_number_seq ajustada a ${receiptSequenceCeiling}`);

  // ── Resumen final ────────────────────────────────────────────────────────
  console.log("\n── Resumen ──────────────────────────────────────────────────");
  console.table(summaries);
  const totalSkipped = summaries.reduce((n, s) => n + s.skipped, 0);
  if (totalSkipped > 0) {
    console.warn(`\n⚠ ${totalSkipped} fila(s) omitidas en total por referencias inválidas. Revisa los warnings arriba.`);
  }
  console.log("\nMigración completada.");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✘ Migración abortada:", err);
    pool.end().finally(() => process.exit(1));
  });

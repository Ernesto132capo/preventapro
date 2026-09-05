import { v4 as uuid } from "uuid";
import { getDb, nowIso } from "../client";
import { enqueue } from "../outbox";
import { CartLine, LocalOrder } from "../../domain/types";
import { calcOrderTotals, PricingError } from "../../domain/pricing";
import { getClient } from "./clients";

export interface CreateOrderInput {
  workDayLocalId: string;
  clientId: string;
  paymentCondition: string;
  lines: CartLine[];
  taxRatePermille?: number;
}

/**
 * Guarda una preventa completa (Fase 23) de forma ATÓMICA en la base local:
 * cabecera + items juntos, o nada. Nunca deja estados parciales (Fase 37).
 * Funciona 100% sin conexión — se encola para sincronizar después.
 */
export async function createOrderLocal(input: CreateOrderInput): Promise<LocalOrder> {
  if (!input.clientId) throw new PricingError("Debes seleccionar un cliente.");
  const totals = calcOrderTotals(input.lines, input.taxRatePermille ?? 0);

  const client = await getClient(input.clientId);
  if (!client) throw new PricingError("Cliente no encontrado.");

  const db = await getDb();
  const orderId = uuid();
  const ts = nowIso();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO orders
        (id, work_day_id, client_id, client_name, payment_condition, subtotal_cents, tax_cents, total_cents,
         item_count, status, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?, ?)`,
      [
        orderId,
        input.workDayLocalId,
        input.clientId,
        client.business_name,
        input.paymentCondition,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        totals.itemCount,
        ts,
        ts,
      ]
    );

    for (const line of input.lines) {
      await db.runAsync(
        `INSERT INTO order_items
          (id, order_id, product_id, presentation_id, product_name_snapshot, sku_snapshot,
           presentation_name_snapshot, unit_equivalence_snapshot, unit_price_cents_snapshot, quantity, subtotal_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          orderId,
          line.productId,
          line.presentationId,
          line.productName,
          line.sku,
          line.presentationName,
          line.unitEquivalence,
          line.unitPriceCents,
          line.quantity,
          line.subtotalCents,
        ]
      );
      // Descuento optimista de stock local (se reconcilia con el servidor al sincronizar)
      await db.runAsync(
        `UPDATE product_presentations SET quantity_available = quantity_available - ? WHERE id = ?`,
        [line.quantity, line.presentationId]
      );
    }

    await db.runAsync(
      `UPDATE work_days SET
         order_count = (SELECT COUNT(*) FROM orders WHERE work_day_id = ? AND status = 'active'),
         total_cents = (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE work_day_id = ? AND status = 'active')
       WHERE id = ?`,
      [input.workDayLocalId, input.workDayLocalId, input.workDayLocalId]
    );
  });

  await enqueue("order", orderId, 2);

  const row = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  return row as LocalOrder;
}

export async function listOrdersForWorkDay(workDayLocalId: string): Promise<LocalOrder[]> {
  const db = await getDb();
  return db.getAllAsync<LocalOrder>(
    `SELECT * FROM orders WHERE work_day_id = ? AND status = 'active' ORDER BY created_at DESC`,
    [workDayLocalId]
  );
}

export async function getOrderWithItems(orderId: string) {
  const db = await getDb();
  const order = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  const items = await db.getAllAsync<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
  return { order, items };
}

/** Reemplaza los artículos de una preventa abierta y devuelve/resta el stock correctamente. */
export async function updateOrderLocal(orderId: string, lines: CartLine[], paymentCondition = "Contado 48h"): Promise<void> {
  const totals = calcOrderTotals(lines, 0);
  const db = await getDb();
  const order = await db.getFirstAsync<LocalOrder>(`SELECT * FROM orders WHERE id = ? AND status = 'active'`, [orderId]);
  if (!order) throw new PricingError("La preventa no existe o ya fue eliminada.");
  const ts = nowIso();

  await db.withTransactionAsync(async () => {
    const oldItems = await db.getAllAsync<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
    for (const item of oldItems) {
      await db.runAsync(`UPDATE product_presentations SET quantity_available = quantity_available + ? WHERE id = ?`, [item.quantity, item.presentation_id]);
    }
    await db.runAsync(`DELETE FROM order_items WHERE order_id = ?`, [orderId]);
    for (const line of lines) {
      await db.runAsync(
        `INSERT INTO order_items (id, order_id, product_id, presentation_id, product_name_snapshot, sku_snapshot, presentation_name_snapshot, unit_equivalence_snapshot, unit_price_cents_snapshot, quantity, subtotal_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), orderId, line.productId, line.presentationId, line.productName, line.sku, line.presentationName, line.unitEquivalence, line.unitPriceCents, line.quantity, line.subtotalCents]
      );
      await db.runAsync(`UPDATE product_presentations SET quantity_available = quantity_available - ? WHERE id = ?`, [line.quantity, line.presentationId]);
    }
    await db.runAsync(
      `UPDATE orders SET payment_condition = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, item_count = ?, sync_status = 'pending', sync_error = NULL, updated_at = ? WHERE id = ?`,
      [paymentCondition, totals.subtotalCents, totals.taxCents, totals.totalCents, totals.itemCount, ts, orderId]
    );
    await refreshWorkDayTotals(db, (order as any).work_day_id);
  });
  await enqueue("order", orderId, 2, "update");
}

/** Cancelación lógica: conserva el historial y devuelve las unidades al inventario. */
export async function cancelOrderLocal(orderId: string): Promise<void> {
  const db = await getDb();
  const order = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE id = ? AND status = 'active'`, [orderId]);
  if (!order) throw new PricingError("La preventa no existe o ya fue eliminada.");
  await db.withTransactionAsync(async () => {
    const items = await db.getAllAsync<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
    for (const item of items) {
      await db.runAsync(`UPDATE product_presentations SET quantity_available = quantity_available + ? WHERE id = ?`, [item.quantity, item.presentation_id]);
    }
    await db.runAsync(`UPDATE orders SET status = 'cancelled', sync_status = 'pending', updated_at = ? WHERE id = ?`, [nowIso(), orderId]);
    await refreshWorkDayTotals(db, order.work_day_id);
    // Las altas/ediciones pendientes ya no deben enviarse después de cancelar.
    await db.runAsync(`UPDATE outbox SET status = 'done' WHERE entity_type = 'order' AND local_entity_id = ? AND status IN ('pending', 'failed')`, [orderId]);
  });
  await enqueue("order", orderId, 2, "cancel");
}

async function refreshWorkDayTotals(db: any, workDayId: string) {
  await db.runAsync(
    `UPDATE work_days SET order_count = (SELECT COUNT(*) FROM orders WHERE work_day_id = ? AND status = 'active'), total_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE work_day_id = ? AND status = 'active') WHERE id = ?`,
    [workDayId, workDayId, workDayId]
  );
}

export async function markOrderSynced(localId: string, serverId: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE orders SET server_id = ?, sync_status = 'synced', sync_error = NULL WHERE id = ?`, [
    serverId,
    localId,
  ]);
}

export async function markOrderFailed(localId: string, error: string) {
  const db = await getDb();
  await db.runAsync(`UPDATE orders SET sync_status = 'failed', sync_error = ? WHERE id = ?`, [error, localId]);
}

export async function countUnsyncedOrders(workDayLocalId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    // Una preventa cancelada ya no bloquea el cierre; su cancelación se envía
    // en la outbox, pero no forma parte de la jornada activa.
    `SELECT COUNT(*) as n FROM orders WHERE work_day_id = ? AND status = 'active' AND sync_status IN ('pending','syncing','failed')`,
    [workDayLocalId]
  );
  return row?.n ?? 0;
}

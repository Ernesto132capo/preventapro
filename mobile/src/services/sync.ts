import { getDb, getMeta, setMeta } from "../db/client";
import { apiFetch, ApiError } from "./api";
import { enqueue, listPending, markDone, markFailed, markSyncing, deferForDependency, OutboxRow } from "../db/outbox";
import { upsertFromServer as upsertClientFromServer, markClientSynced, resolveServerClientId } from "../db/repositories/clients";
import { upsertProductFromServer, resolveServerPresentationId, resolveServerProductId } from "../db/repositories/products";
import { markOrderSynced, markOrderFailed, upsertOrderFromServer } from "../db/repositories/orders";
import { resolveServerWorkDayId, upsertServerWorkDay, getOrCreateOpenWorkDay } from "../db/repositories/workdays";

export interface SyncResult {
  ok: boolean;
  pulled: { clients: number; products: number };
  pushed: { done: number; deferred: number; failed: number };
  error?: string;
}

/** PULL: trae catálogo/clientes actualizados desde el servidor (Fase 31). */
async function pullCatalog(): Promise<{ clients: number; products: number }> {
  const db = await getDb();
  const prodCount = (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM products WHERE active = 1`))?.n ?? 0;
  const clientCount = (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM clients WHERE active = 1`))?.n ?? 0;

  let since = (await getMeta("last_pull_at")) || "1970-01-01T00:00:00.000Z";
  if (prodCount === 0 || clientCount === 0) {
    since = "1970-01-01T00:00:00.000Z";
  }

  const data = await apiFetch<any>(`/sync/pull?since=${encodeURIComponent(since)}`);

  for (const c of data.clients) await upsertClientFromServer(c);

  // Agrupar presentaciones por producto para reusar upsertProductFromServer
  const presByProduct: Record<string, any[]> = {};
  for (const p of data.presentations) {
    presByProduct[p.product_id] = presByProduct[p.product_id] || [];
    presByProduct[p.product_id].push(p);
  }
  const invByPresentation: Record<string, number> = {};
  for (const inv of data.inventory) invByPresentation[inv.presentation_id] = inv.quantity_available;

  for (const prod of data.products) {
    const presentations = (presByProduct[prod.id] || []).map((p) => ({
      ...p,
      quantity_available: invByPresentation[p.id] ?? 0,
    }));
    await upsertProductFromServer({ ...prod, presentations });
  }

  // Descargar e integrar preventas compartidas del equipo
  if (data.orders && Array.isArray(data.orders)) {
    for (const o of data.orders) {
      await upsertOrderFromServer(o);
    }
  }

  await setMeta("last_pull_at", data.serverTime);
  return { clients: data.clients.length, products: data.products.length };
}

/**
 * Si el backend fue restaurado, los UUID remotos guardados en el teléfono dejan
 * de existir. Antes de subir una preventa detectamos esos enlaces rotos y
 * reenviamos primero el cliente/producto local que la preventa necesita.
 */
async function reconcileResetServerMappings() {
  const [remoteClients, remoteProducts] = await Promise.all([
    apiFetch<any>(`/clients`),
    apiFetch<any>(`/catalog/products`),
  ]);
  const clientIds = new Set((remoteClients.clients || []).map((c: any) => c.id));
  const productIds = new Set((remoteProducts.products || []).map((p: any) => p.id));
  const db = await getDb();

  const localClients = await db.getAllAsync<{ id: string; server_id: string }>(
    `SELECT id, server_id FROM clients WHERE active = 1 AND server_id IS NOT NULL`
  );
  for (const client of localClients) {
    if (!clientIds.has(client.server_id)) {
      await db.runAsync(`UPDATE clients SET server_id = NULL, sync_status = 'pending' WHERE id = ?`, [client.id]);
      await enqueue("client", client.id, 1);
    }
  }

  const localProducts = await db.getAllAsync<{ id: string; server_id: string }>(
    `SELECT id, server_id FROM products WHERE active = 1 AND server_id IS NOT NULL`
  );
  for (const product of localProducts) {
    if (!productIds.has(product.server_id)) {
      await db.withTransactionAsync(async () => {
        await db.runAsync(`UPDATE products SET server_id = NULL, sync_status = 'pending' WHERE id = ?`, [product.id]);
        await db.runAsync(`UPDATE product_presentations SET server_id = NULL WHERE product_id = ?`, [product.id]);
      });
      await enqueue("product", product.id, 1);
    }
  }

  // Recupera preventas que fueron marcadas como fallidas antes de la
  // reconciliación o cuya fila de cola se descartó accidentalmente.
  const unsyncedOrders = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'active' AND sync_status IN ('pending', 'syncing', 'failed')`
  );
  for (const order of unsyncedOrders) {
    const queued = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM outbox WHERE entity_type = 'order' AND local_entity_id = ? AND status IN ('pending', 'syncing', 'failed') LIMIT 1`,
      [order.id]
    );
    if (!queued) await enqueue("order", order.id, 2);
  }
}

/** Asegura que la jornada local de hoy tenga un server_id resuelto antes de subir preventas. */
async function resolveTodayWorkDay(userId: string) {
  const local = await getOrCreateOpenWorkDay(userId);
  const res = await apiFetch<any>(`/workdays/current`);
  // Siempre renovamos el vínculo: si el backend se reinició, el server_id local
  // anterior ya no existe y las preventas recibirían "Jornada no encontrada".
  await upsertServerWorkDay(local.id, res.workDay);
  // Tras volver a iniciar sesión (p. ej. si se restauró el backend), las
  // preventas offline pueden pertenecer a la jornada local del usuario anterior.
  // Las vinculamos a la jornada abierta actual para que no queden bloqueadas.
  const db = await getDb();
  const openLocalDays = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM work_days WHERE work_date = ? AND status = 'open'`,
    [local.work_date]
  );
  for (const day of openLocalDays) await upsertServerWorkDay(day.id, res.workDay);
}

async function pushClient(row: OutboxRow) {
  const db = await getDb();
  const client = await db.getFirstAsync<any>(`SELECT * FROM clients WHERE id = ?`, [row.local_entity_id]);
  if (!client) return markDone(row.id); // se borró localmente, nada que hacer

  // Cliente borrado localmente: si ya existía en el servidor, propagar el borrado; si no, no hay nada que subir.
  if (client.active === 0) {
    if (client.server_id) {
      await apiFetch<any>(`/clients/${client.server_id}`, { method: "DELETE" });
    }
    return markDone(row.id);
  }

  const body = {
    clientLocalId: client.id,
    businessName: client.business_name,
    contactName: client.contact_name ?? undefined,
    phone: client.phone ?? undefined,
    address: client.address ?? undefined,
    lat: client.lat ?? undefined,
    lng: client.lng ?? undefined,
  };

  if (client.server_id) {
    // Ya existía en el servidor: esto es una edición.
    const res = await apiFetch<any>(`/clients/${client.server_id}`, { method: "PUT", body });
    await markClientSynced(client.id, res.client.id);
  } else {
    // Primera vez que sube: alta.
    const res = await apiFetch<any>(`/clients`, { method: "POST", body });
    await markClientSynced(client.id, res.client.id);
  }
  await markDone(row.id);
}

async function pushProduct(row: OutboxRow) {
  const db = await getDb();
  const product = await db.getFirstAsync<any>(`SELECT * FROM products WHERE id = ?`, [row.local_entity_id]);
  if (!product) return markDone(row.id);

  // Producto borrado localmente: si ya existía en el servidor, propagar el borrado; si no, nada que subir.
  if (product.active === 0) {
    if (product.server_id) {
      await apiFetch<any>(`/catalog/products/${product.server_id}`, { method: "DELETE" });
    }
    return markDone(row.id);
  }

  // Solo se envían las presentaciones activas; las borradas localmente se omiten (el servidor las desactiva por ausencia).
  const presentations = await db.getAllAsync<any>(
    `SELECT * FROM product_presentations WHERE product_id = ? AND active = 1 ORDER BY sort_order ASC`,
    [product.id]
  );
  const body = {
    sku: product.sku,
    name: product.name,
    categoryId: product.category_id ?? undefined,
    baseCostCents: product.base_cost_cents,
    baseUnitName: product.base_unit_name,
    presentations: presentations.map((p) => ({
      name: p.name,
      unitEquivalence: p.unit_equivalence,
      priceCents: p.price_cents,
      costCents: p.cost_cents,
      stock: p.quantity_available,
    })),
  };

  let serverProduct: any;
  if (product.server_id) {
    // Ya existía en el servidor: esto es una edición.
    const res = await apiFetch<any>(`/catalog/products/${product.server_id}`, { method: "PUT", body });
    serverProduct = res.product;
  } else {
    // Primera vez que sube: alta.
    const res = await apiFetch<any>(`/catalog/products`, { method: "POST", body });
    serverProduct = res.product;
  }

  await db.runAsync(`UPDATE products SET server_id = ?, sync_status = 'synced' WHERE id = ?`, [
    serverProduct.id,
    product.id,
  ]);
  // Emparejar por nombre (estable entre ediciones) en vez de por posición, para no desalinear
  // los ids si se agregó o quitó alguna presentación en esta misma edición.
  for (const localPres of presentations) {
    const serverPres = serverProduct.presentations.find((sp: any) => sp.name === localPres.name);
    if (serverPres) {
      await db.runAsync(`UPDATE product_presentations SET server_id = ? WHERE id = ?`, [serverPres.id, localPres.id]);
    }
  }
  await markDone(row.id);
}

async function pushOrder(row: OutboxRow, userId: string) {
  const db = await getDb();
  const order = await db.getFirstAsync<any>(`SELECT * FROM orders WHERE id = ?`, [row.local_entity_id]);
  if (!order) return markDone(row.id);
  if (row.operation === "cancel" || order.status === "cancelled") {
    // Si nunca llegó al servidor, basta con descartar sus operaciones locales.
    if (order.server_id) await apiFetch<any>(`/orders/${order.server_id}/cancel`, { method: "POST" });
    return markDone(row.id);
  }

  let workDayServerId = await resolveServerWorkDayId(order.work_day_id);
  if (!workDayServerId) {
    try {
      const res = await apiFetch<any>(`/workdays/current`);
      if (res?.workDay?.id) {
        workDayServerId = res.workDay.id;
        await db.runAsync(`UPDATE work_days SET server_id = ? WHERE id = ?`, [workDayServerId, order.work_day_id]);
      }
    } catch {}
  }

  const clientServerId = await resolveServerClientId(order.client_id);
  if (!workDayServerId || !clientServerId) {
    console.warn(`[pushOrder] Deferring order ${order.id}: workDayServerId=${workDayServerId}, clientServerId=${clientServerId}`);
    return deferForDependency(row.id);
  }

  const items = await db.getAllAsync<any>(`SELECT * FROM order_items WHERE order_id = ?`, [order.id]);
  const resolvedItems = [];
  for (const item of items) {
    const productServerId = await resolveServerProductId(item.product_id);
    const presentationServerId = await resolveServerPresentationId(item.presentation_id);
    if (!productServerId || !presentationServerId) {
      console.warn(`[pushOrder] Deferring order ${order.id}: item ${item.id} missing productServerId=${productServerId}, presentationServerId=${presentationServerId}`);
      return deferForDependency(row.id); // el producto creado offline todavía no sincronizó
    }
    resolvedItems.push({ productId: productServerId, presentationId: presentationServerId, quantity: item.quantity });
  }

  try {
    const body = {
      paymentCondition: order.payment_condition,
      items: resolvedItems,
    };
    const res = row.operation === "update" && order.server_id
      ? await apiFetch<any>(`/orders/${order.server_id}`, { method: "PUT", body })
      : await apiFetch<any>(`/orders`, {
          method: "POST",
          body: { ...body, idempotencyKey: order.id, workDayId: workDayServerId, clientId: clientServerId },
        });
    await markOrderSynced(order.id, res.order.id);
    await markDone(row.id);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Error de sincronización";
    if (err instanceof ApiError && err.status === 0) {
      // Error de red real (no de validación) — reintentar sin marcar como fallo definitivo.
      return deferForDependency(row.id);
    }
    await markOrderFailed(order.id, message);
    await markFailed(row.id, message);
  }
}

/** PUSH: procesa la cola de salida en orden de prioridad (clientes/productos antes que preventas). */
async function pushOutbox(userId: string): Promise<{ done: number; deferred: number; failed: number }> {
  const rows = await listPending();
  let done = 0,
    deferred = 0,
    failed = 0;

  for (const row of rows) {
    await markSyncing(row.id);
    try {
      if (row.entity_type === "client") {
        await pushClient(row);
        done++;
      } else if (row.entity_type === "product") {
        await pushProduct(row);
        done++;
      } else if (row.entity_type === "order") {
        const before = row.status;
        await pushOrder(row, userId);
        // pushOrder decide su propio resultado (done/deferred/failed) internamente
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Error desconocido";
      if (err instanceof ApiError && err.status === 0) {
        await deferForDependency(row.id);
        deferred++;
      } else {
        await markFailed(row.id, message);
        failed++;
      }
      continue;
    }
  }

  // Segunda pasada corta para resolver dependencias que ya se destrabaron en esta misma sincronización
  // (ej: un cliente se sincronizó y ahora su preventa dependiente puede subir).
  const remaining = await listPending();
  for (const row of remaining) {
    if (row.entity_type !== "order") continue;
    try {
      await pushOrder(row, userId);
    } catch {
      /* se maneja dentro de pushOrder */
    }
  }

  return { done, deferred, failed };
}

export async function runSync(userId: string): Promise<SyncResult> {
  try {
    await resolveTodayWorkDay(userId);
    const pulled = await pullCatalog();
    await reconcileResetServerMappings();
    const pushed = await pushOutbox(userId);
    return { ok: true, pulled, pushed };
  } catch (err: any) {
    console.warn("Error detallado en runSync:", err);
    const message = err instanceof ApiError ? err.message : err?.message || "No se pudo sincronizar.";
    return { ok: false, pulled: { clients: 0, products: 0 }, pushed: { done: 0, deferred: 0, failed: 0 }, error: message };
  }
}

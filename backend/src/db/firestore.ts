import { firestore } from "../firebase/admin";

// Colecciones de nivel superior. Los nombres de campo dentro de cada documento
// usan camelCase (convención habitual en Firestore/JS), a diferencia de las
// columnas snake_case que tenías en SQLite.
export const col = {
  users: firestore.collection("users"),
  neighborhoods: firestore.collection("neighborhoods"),
  clients: firestore.collection("clients"),
  categories: firestore.collection("categories"),
  products: firestore.collection("products"),
  workDays: firestore.collection("work_days"),
  orders: firestore.collection("orders"),
  syncLog: firestore.collection("sync_log"),
  counters: firestore.collection("counters"),
};

// ─── Correlativo global de comprobantes/boletas ───────────────────────────────
// Un solo documento (counters/receiptNumber) guarda el último número emitido.
// Se incrementa con una transacción de Firestore para que sea seguro aunque
// dos preventistas creen una preventa al mismo tiempo (nunca se repite ni se
// salta un número por una condición de carrera). Nunca se reinicia por
// jornada: es estrictamente acumulativo desde que existe la app.
const RECEIPT_COUNTER_DOC = "receiptNumber";

export async function getNextReceiptNumber(): Promise<number> {
  const ref = col.counters.doc(RECEIPT_COUNTER_DOC);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data()?.value ?? 0) : 0;
    const next = current + 1;
    tx.set(ref, { value: next, updatedAt: nowIso() }, { merge: true });
    return next;
  });
}

/** Lee el correlativo actual sin incrementarlo (para mostrar estadísticas). */
export async function getReceiptCounterValue(): Promise<number> {
  const snap = await col.counters.doc(RECEIPT_COUNTER_DOC).get();
  return snap.exists ? Number(snap.data()?.value ?? 0) : 0;
}

/**
 * Ajuste manual del correlativo (uso temporal, para alinear el contador con
 * el arrastre histórico de un sistema anterior). Sobrescribe directamente el
 * valor — la siguiente preventa emitirá `value + 1`.
 */
export async function setReceiptCounterValue(value: number): Promise<number> {
  await col.counters.doc(RECEIPT_COUNTER_DOC).set({ value, updatedAt: nowIso() }, { merge: true });
  return value;
}

// product_presentations + inventory se combinan en una subcolección por producto,
// porque en tu esquema original inventory era 1 a 1 con cada presentación
// (UNIQUE presentation_id). En Firestore no hace falta una tabla aparte para eso:
// el campo quantityAvailable vive directo en el documento de la presentación.
export function presentationsCol(productId: string) {
  return col.products.doc(productId).collection("presentations");
}

// order_items = snapshot inmutable, igual que en SQLite. Se guarda como
// subcolección del pedido para poder leer el pedido completo con una sola
// consulta adicional (order + items), tal como hacías con el JOIN.
export function orderItemsCol(orderId: string) {
  return col.orders.doc(orderId).collection("items");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { firestore };

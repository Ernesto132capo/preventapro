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
};

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

import { v4 as uuid } from "uuid";
import { auth } from "../firebase/admin";
import { col, nowIso, presentationsCol } from "./firestore";
import { codeToEmail } from "../services/auth";

async function firstId(collection: FirebaseFirestore.CollectionReference, field?: string, value?: unknown) {
  const query = field ? collection.where(field, "==", value).limit(1) : collection.limit(1);
  const result = await query.get();
  return result.empty ? null : result.docs[0].id;
}

async function seed() {
  const ts = nowIso(), code = "PV001", email = codeToEmail(code);
  let userId: string;
  try { userId = (await auth.getUserByEmail(email)).uid; }
  catch { userId = (await auth.createUser({ email, password: "preventa123", displayName: "Preventista Demo" })).uid; }
  await col.users.doc(userId).set({ code, email, fullName: "Preventista Demo", active: true, updatedAt: ts, createdAt: ts }, { merge: true });

  let neighborhoodId = await firstId(col.neighborhoods, "name", "Centro");
  if (!neighborhoodId) { neighborhoodId = uuid(); await col.neighborhoods.doc(neighborhoodId).set({ name: "Centro", active: true, createdAt: ts, updatedAt: ts }); }
  let categoryId = await firstId(col.categories, "name", "Lácteos");
  if (!categoryId) { categoryId = uuid(); await col.categories.doc(categoryId).set({ name: "Lácteos", active: true, createdAt: ts, updatedAt: ts }); }

  if (!await firstId(col.clients)) {
    const id = uuid(); await col.clients.doc(id).set({ businessName: "Tienda Doña Rosa", contactName: "Rosa Mamani", phone: "77712345", neighborhoodId, address: "Av. Principal 123", assignedUserId: userId, createdBy: userId, visitStatus: "pending", active: true, createdAt: ts, updatedAt: ts });
  }
  if (!await firstId(col.products, "sku", "LEC-001")) {
    const id = uuid(), batch = col.products.firestore.batch();
    batch.set(col.products.doc(id), { sku: "LEC-001", name: "Leche Entera 1L", categoryId, baseCostCents: 500, baseUnitName: "Unidad", active: true, createdAt: ts, updatedAt: ts });
    [{ name: "Unidad", eq: 1, price: 750, cost: 500, stock: 140 }, { name: "Medio Paquete", eq: 3, price: 2150, cost: 1450, stock: 25 }, { name: "Paquete", eq: 6, price: 4100, cost: 2900, stock: 18 }, { name: "Media Caja", eq: 12, price: 8000, cost: 5700, stock: 14 }, { name: "Caja", eq: 24, price: 15600, cost: 11200, stock: 7 }].forEach((p, sortOrder) => batch.set(presentationsCol(id).doc(uuid()), { productId: id, name: p.name, sortOrder, unitEquivalence: p.eq, priceCents: p.price, costCents: p.cost, stock: p.stock, active: true, createdAt: ts, updatedAt: ts }));
    await batch.commit();
  }
  console.log("🌱 Datos demo de Firebase listos: PV001 / preventa123");
}
seed().catch((err) => { console.error(err); process.exit(1); });

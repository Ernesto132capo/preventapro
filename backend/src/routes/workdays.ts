import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col, nowIso } from "../db/firestore";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { invalidatePullCache } from "./sync";

export const workdaysRouter = Router();
workdaysRouter.use(requireAuth);
function today() { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const v = (t: string) => p.find(x => x.type === t)?.value; return `${v("year")}-${v("month")}-${v("day")}`; }
function serial(id: string, d: any) { return { id, server_id: id, user_id: d.userId, work_date: d.workDate, status: d.status, order_count: d.orderCount ?? 0, total_cents: d.totalCents ?? 0, created_at: d.createdAt, closed_at: d.closedAt ?? null }; }
async function recalc(id: string) { const orders = (await col.orders.where("workDayId", "==", id).get()).docs.map(d => d.data()).filter(d => d.status !== "cancelled"); const total = orders.reduce((n, d) => n + (d.totalCents ?? 0), 0); await col.workDays.doc(id).update({ orderCount: orders.length, totalCents: total, updatedAt: nowIso() }); return { orderCount: orders.length, totalCents: total }; }

// ─── Caché en memoria para /workdays/current ─────────────────────────────────
// Evita releer Firestore en cada poll de 60s cuando la jornada no cambió.
// Se invalida en cada mutación de jornada o pedido; por eso no expira por
// tiempo y los polls sin cambios no leen Firestore.
interface WorkdayCache {
  date: string;
  data: object;
}
let workdayCacheEntry: WorkdayCache | null = null;

export function invalidateWorkdayCache() {
  workdayCacheEntry = null;
}

workdaysRouter.get("/current", async (req: AuthedRequest, res) => {
  const date = today();
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  // Devolver caché si pertenece al mismo día y no se solicita verificación fresca.
  // Se invalida al crear, editar o cerrar jornadas y al crear/editar/cancelar pedidos.
  if (!fresh && workdayCacheEntry && workdayCacheEntry.date === date) {
    return res.json(workdayCacheEntry.data);
  }

  // 1. Buscar todas las jornadas de hoy (1 lectura de colección)
  const todayResult = await col.workDays.where("workDate", "==", date).get();
  if (!todayResult.empty) {
    const docs = todayResult.docs.sort((a, b) =>
      (b.data().updatedAt || b.data().createdAt || "").localeCompare(a.data().updatedAt || a.data().createdAt || "")
    );
    const d = docs[0];
    // NOTA: NO llamamos recalc() aquí — recalc es una operación de escritura
    // que debe ocurrir únicamente en mutaciones (crear/cancelar orden, cerrar jornada).
    // Llamarla en cada GET de 60s generaba cientos de lecturas/escrituras extras.
    const payload = { workDay: serial(d.id, d.data()) };
    workdayCacheEntry = { date, data: payload };
    return res.json(payload);
  }

  // 2. Primera vez del día: crear la jornada compartida
  const ref = col.workDays.doc(uuid());
  const ts = nowIso();
  const newWorkDay = { userId: req.userId, workDate: date, status: "open", orderCount: 0, totalCents: 0, createdAt: ts, updatedAt: ts };
  await ref.set(newWorkDay);
  const payload = { workDay: serial(ref.id, newWorkDay) };
  workdayCacheEntry = { date, data: payload };
  invalidatePullCache("workdays");
  res.json(payload);
});

workdaysRouter.get("/history", async (req: AuthedRequest, res) => {
  const s = await col.workDays.where("status", "==", "closed").get();
  res.json({
    workDays: s.docs.map((d) => serial(d.id, d.data())).sort((a, b) => b.work_date.localeCompare(a.work_date)),
  });
});

workdaysRouter.get("/:id/orders", async (req, res) => {
  const s = await col.orders.where("workDayId", "==", req.params.id).get();
  const orders = await Promise.all(
    s.docs
      .filter((d) => d.data().status !== "cancelled")
      .map(async (d) => {
        const c = await col.clients.doc(d.data().clientId).get();
        return {
          id: d.id,
          ...d.data(),
          client_id: d.data().clientId,
          work_day_id: d.data().workDayId,
          business_name: c.data()?.businessName ?? "",
          neighborhood_id: c.data()?.neighborhoodId ?? null,
        };
      })
  );
  res.json({ orders });
});

workdaysRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const ref = col.workDays.doc(req.params.id),
    d = await ref.get();
  if (!d.exists || d.data()?.status !== "closed") return res.status(404).json({ error: "Registro histórico no encontrado." });
  const orders = await col.orders.where("workDayId", "==", ref.id).get();
  const batch = col.workDays.firestore.batch();
  orders.docs.forEach((o) => batch.delete(o.ref));
  batch.delete(ref);
  await batch.commit();
  res.json({ ok: true });
});

workdaysRouter.post("/:id/close", async (req: AuthedRequest, res) => {
  if (req.body?.confirmation !== "CONFIRMAR")
    return res.status(400).json({ error: 'Debes escribir exactamente "CONFIRMAR" para cerrar la jornada.' });
  const ref = col.workDays.doc(req.params.id),
    d = await ref.get();
  if (!d.exists) return res.status(404).json({ error: "Jornada no encontrada." });
  if (d.data()?.status === "closed") return res.status(409).json({ error: "La jornada ya está cerrada." });
  const totals = await recalc(ref.id),
    ts = nowIso();
  await ref.update({ status: "closed", ...totals, closedAt: ts, updatedAt: ts });
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  // Asegurar que cualquier otra jornada huérfana de hoy quede cerrada
  const workDate = d.data()?.workDate;
  if (workDate) {
    const others = await col.workDays.where("workDate", "==", workDate).where("status", "==", "open").get();
    for (const od of others.docs) {
      if (od.id !== ref.id) await od.ref.update({ status: "closed", closedAt: ts, updatedAt: ts });
    }
  }

  res.json({ workDay: serial(ref.id, { ...d.data(), status: "closed", ...totals, closedAt: ts, updatedAt: ts }) });
});

workdaysRouter.post("/:id/reopen", async (req: AuthedRequest, res) => {
  const ref = col.workDays.doc(req.params.id);
  const d = await ref.get();
  if (!d.exists) return res.status(404).json({ error: "Jornada no encontrada." });
  const totals = await recalc(ref.id);
  const ts = nowIso();
  await ref.update({ status: "open", ...totals, closedAt: null, updatedAt: ts });
  invalidateWorkdayCache();
  invalidatePullCache("workdays");

  const workDate = d.data()?.workDate;
  if (workDate) {
    const others = await col.workDays.where("workDate", "==", workDate).get();
    for (const od of others.docs) {
      if (od.id !== ref.id) await od.ref.update({ status: "open", closedAt: null, updatedAt: ts });
    }
  }

  res.json({ workDay: serial(ref.id, { ...d.data(), status: "open", ...totals, closedAt: null, updatedAt: ts }) });
});

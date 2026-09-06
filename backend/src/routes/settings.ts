import { Router } from "express";
import { z } from "zod";
import { getReceiptCounterValue, setReceiptCounterValue } from "../db/firestore";
import { requireAuth } from "../middleware/auth";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// Estadísticas globales para el apartado "Perfil" de la app: el correlativo
// de boletas ES el total histórico de preventas emitidas (nunca se reinicia),
// así que no hace falta un contador aparte.
settingsRouter.get("/stats", async (_req, res) => {
  const totalHistoricalOrders = await getReceiptCounterValue();
  res.json({ totalHistoricalOrders });
});

const counterSchema = z.object({ value: z.number().int().nonnegative() });

// Ajuste manual temporal (ver pedido del cliente): permite alinear el
// correlativo con el arrastre histórico de un sistema anterior. Sobrescribe
// el valor directamente — la siguiente preventa emitirá `value + 1`.
settingsRouter.put("/receipt-counter", async (req, res) => {
  const parsed = counterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  const value = await setReceiptCounterValue(parsed.data.value);
  res.json({ ok: true, value });
});

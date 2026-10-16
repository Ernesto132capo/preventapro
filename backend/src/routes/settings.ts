import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pg";
import { requireAuth, requireRole } from "../middleware/auth";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// Estadísticas globales para el apartado "Perfil" de la app: el correlativo
// de boletas ES el total histórico de preventas emitidas (nunca se reinicia),
// así que no hace falta un contador aparte. Ahora vive en la secuencia nativa
// de Postgres receipt_number_seq en vez del documento counters/receiptNumber.
settingsRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT last_value FROM receipt_number_seq");
    const totalHistoricalOrders = Number(rows[0]?.last_value ?? 0);
    res.json({ totalHistoricalOrders });
  } catch (err) {
    next(err);
  }
});

const counterSchema = z.object({ value: z.number().int().nonnegative().max(2_000_000_000) }).strict();

// Ajuste manual temporal (ver pedido del cliente): permite alinear el
// correlativo con el arrastre histórico de un sistema anterior. Sobrescribe
// el valor directamente — la siguiente preventa emitirá `value + 1`.
settingsRouter.put("/receipt-counter", requireRole("admin"), async (req, res, next) => {
  const parsed = counterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  try {
    const val = parsed.data.value;
    let newSeqVal: number;
    if (val <= 0) {
      // En Postgres, las secuencias con MINVALUE 1 no aceptan 0 en setval('seq', 0).
      // Usamos setval('receipt_number_seq', 1, false) para que el próximo nextval() devuelva 1.
      await pool.query("SELECT setval('receipt_number_seq', 1, false)");
      newSeqVal = 0;
    } else {
      const { rows } = await pool.query("SELECT setval('receipt_number_seq', $1, true)", [val]);
      newSeqVal = Number(rows[0]?.setval ?? val);
    }
    res.json({ ok: true, value: newSeqVal });
  } catch (err) {
    next(err);
  }
});

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pg";
import { requireAuth, requireRole } from "../middleware/auth";
import { lockWorkDays } from "./workdays";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// La secuencia puede tener saltos o arrastre histórico; no equivale a COUNT(orders).
settingsRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT (SELECT COUNT(*)::int FROM orders) AS total_historical_orders,
             GREATEST(CASE WHEN is_called THEN last_value ELSE 0 END,
                      (SELECT COALESCE(MAX(receipt_number), 0) FROM orders)) AS last_receipt_number
      FROM receipt_number_seq
    `);
    res.json({ totalHistoricalOrders: Number(rows[0]?.total_historical_orders ?? 0), lastReceiptNumber: Number(rows[0]?.last_receipt_number ?? 0) });
  } catch (err) {
    next(err);
  }
});

const counterSchema = z.object({ value: z.number().int().nonnegative().max(2_000_000_000) }).strict();

// Ajuste manual temporal (ver pedido del cliente): permite alinear el
// correlativo con el arrastre histórico de un sistema anterior. Nunca reutiliza
// un número emitido y comparte el lock de creación de preventas.
settingsRouter.put("/receipt-counter", requireRole("admin"), async (req, res, next) => {
  const parsed = counterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    await lockWorkDays(client);
    const val = parsed.data.value;
    const { rows: maxRows } = await client.query("SELECT COALESCE(MAX(receipt_number), 0)::int AS max_receipt_number FROM orders");
    const minimum = Number(maxRows[0]?.max_receipt_number ?? 0);
    if (val < minimum) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({ error: `El correlativo no puede ser menor que la última boleta emitida (${minimum}).`, minimum });
    }
    let newSeqVal: number;
    if (val <= 0) {
      // En Postgres, las secuencias con MINVALUE 1 no aceptan 0 en setval('seq', 0).
      // Usamos setval('receipt_number_seq', 1, false) para que el próximo nextval() devuelva 1.
      await client.query("SELECT setval('receipt_number_seq', 1, false)");
      newSeqVal = 0;
    } else {
      const { rows } = await client.query("SELECT setval('receipt_number_seq', $1, true)", [val]);
      newSeqVal = Number(rows[0]?.setval ?? val);
    }
    await client.query("COMMIT");
    inTransaction = false;
    res.json({ ok: true, value: newSeqVal });
  } catch (err) {
    if (client && inTransaction) { try { await client.query("ROLLBACK"); } catch { /* conexión perdida */ } }
    next(err);
  } finally {
    client?.release();
  }
});

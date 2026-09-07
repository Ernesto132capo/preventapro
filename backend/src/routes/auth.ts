import { Router } from "express";
import { z } from "zod";
import { auth } from "../firebase/admin";
import { codeToEmail, createAuthUser } from "../services/auth";
import { pool, nowIso } from "../db/pg";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const authRouter = Router();

// El login YA NO pasa por el backend: el celular llama directo a Firebase
// Authentication (signInWithEmailAndPassword) con el SDK cliente, usando el
// email sintético que devuelve este endpoint. El backend nunca ve la contraseña,
// y el SDK cliente maneja solo la sesión persistida sin conexión.
authRouter.get("/resolve-code/:code", async (req, res) => {
  const code = req.params.code;
  const { rows } = await pool.query(
    "SELECT id FROM users WHERE code = $1 AND active = true LIMIT 1",
    [code]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: "Código de preventista no encontrado." });
  }
  return res.json({ email: codeToEmail(code) });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    "SELECT id, code, real_email, full_name, active FROM users WHERE id = $1",
    [req.userId]
  );
  const d = rows[0];
  return res.json({
    user: { id: d?.id, code: d?.code, email: d?.real_email ?? null, fullName: d?.full_name, active: d?.active },
  });
});

// Utilidad administrativa para crear preventistas (protegida en un entorno real por un
// rol admin; igual que en la versión SQLite, queda simple porque el spec no pide un
// módulo de administración completo).
const createUserSchema = z.object({
  code: z.string().min(2),
  email: z.string().email().optional(), // email real, solo informativo (no se usa para login)
  password: z.string().min(6),
  fullName: z.string().min(2),
});

authRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  }
  const { code, email, password, fullName } = parsed.data;

  const existing = await pool.query("SELECT id FROM users WHERE code = $1 LIMIT 1", [code]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "Ese código de preventista ya existe." });
  }

  let userRecord;
  try {
    userRecord = await createAuthUser({ code, password, fullName });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Ese código de preventista ya existe." });
    }
    throw err;
  }

  const ts = nowIso();
  await pool.query(
    `INSERT INTO users (id, code, real_email, full_name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, $5, $5)`,
    [userRecord.uid, code, email || null, fullName, ts]
  );

  return res.status(201).json({ id: userRecord.uid, code, fullName });
});

// Desactivar un preventista (soft delete: nunca se borra, para no perder su historial de pedidos).
authRouter.patch("/users/:id/deactivate", requireAuth, async (req, res) => {
  await pool.query("UPDATE users SET active = false, updated_at = $2 WHERE id = $1", [req.params.id, nowIso()]);
  await auth.updateUser(req.params.id, { disabled: true });
  return res.json({ ok: true });
});

import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pg";
import { createAccessToken, verifyPassword } from "../services/auth";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const authRouter = Router();

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
}).strict();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ingresa tu código y contraseña válidos." });

  const { identifier, password } = parsed.data;
  const { rows } = await pool.query(
    `SELECT id, code, real_email, full_name, active, password_hash
     FROM users
     WHERE lower(code) = lower($1) OR lower(coalesce(real_email, '')) = lower($1)
     LIMIT 1`,
    [identifier]
  );
  const user = rows[0];
  if (!user || user.active === false || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "Código/correo o contraseña incorrectos." });
  }

  return res.json({
    accessToken: createAccessToken(user.id),
    user: { id: user.id, code: user.code, email: user.real_email ?? null, fullName: user.full_name },
  });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    "SELECT id, code, real_email, full_name, active FROM users WHERE id = $1",
    [req.userId]
  );
  const user = rows[0];
  return res.json({
    user: { id: user.id, code: user.code, email: user.real_email ?? null, fullName: user.full_name, active: user.active },
  });
});

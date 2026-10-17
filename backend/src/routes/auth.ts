import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pg";
import { createAccessToken, verifyPassword } from "../services/auth";
import { requireAuth, AuthedRequest } from "../middleware/auth";

export const authRouter = Router();

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  statusCode: 429,
  message: { error: "Demasiados intentos de inicio de sesión. Por favor, intenta de nuevo más tarde." },
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
  deviceName: z.string().trim().max(100).optional(),
}).strict();

authRouter.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Ingresa tu código y contraseña válidos." });

    const { identifier, password, deviceName } = parsed.data;
    const cleanId = identifier.trim().toLowerCase();
    const alias: Record<string, string> = { pv001: "david", david: "pv001", pv002: "yuma", yuma: "pv002" };
    const candidates = [cleanId, alias[cleanId]].filter(Boolean) as string[];

    const { rows } = await pool.query(
      `SELECT id, code, real_email, full_name, active, password_hash
       FROM users
       WHERE lower(code) = ANY($1) OR lower(coalesce(real_email, '')) = $2
       LIMIT 1`,
      [candidates, cleanId]
    );
    const user = rows[0];
    if (!user || user.active === false || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Código/correo o contraseña incorrectos." });
    }

    const sessionId = randomUUID();
    const resolvedDeviceName = deviceName?.trim() || "Dispositivo Móvil";

    try {
      await pool.query(
        `INSERT INTO user_sessions (id, user_id, device_name, active, created_at, last_seen_at)
         VALUES ($1, $2, $3, true, now(), now())`,
        [sessionId, user.id, resolvedDeviceName]
      );
    } catch (sessionErr) {
      console.warn("No se pudo registrar la sesión en user_sessions:", sessionErr);
    }

    return res.json({
      accessToken: createAccessToken(user.id, sessionId),
      sessionId,
      user: { id: user.id, code: user.code, email: user.real_email ?? null, fullName: user.full_name },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (req.sessionId) {
      await pool.query(
        "UPDATE user_sessions SET active = false, last_seen_at = now() WHERE id = $1 AND user_id = $2",
        [req.sessionId, req.userId]
      );
    }
    return res.json({ ok: true, message: "Sesión cerrada exitosamente." });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/sessions", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_name, active, created_at, last_seen_at
       FROM user_sessions
       WHERE user_id = $1 AND active = true
       ORDER BY created_at DESC`,
      [req.userId]
    );

    const sessions = rows.map((s: any) => ({
      id: s.id,
      deviceName: s.device_name,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      isCurrent: s.id === req.sessionId,
    }));

    return res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/sessions/revoke-others", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (!req.sessionId) {
      return res.status(400).json({ error: "No se puede identificar la sesión actual." });
    }
    const result = await pool.query(
      "UPDATE user_sessions SET active = false, last_seen_at = now() WHERE user_id = $1 AND id != $2 AND active = true",
      [req.userId, req.sessionId]
    );
    return res.json({ ok: true, revokedCount: result.rowCount ?? 0 });
  } catch (err) {
    next(err);
  }
});

authRouter.delete("/sessions/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE user_sessions SET active = false, last_seen_at = now() WHERE id = $1 AND user_id = $2",
      [id, req.userId]
    );
    return res.json({ ok: true, revokedId: id });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, code, real_email, full_name, active FROM users WHERE id = $1",
      [req.userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    return res.json({
      user: { id: user.id, code: user.code, email: user.real_email ?? null, fullName: user.full_name, active: user.active },
      sessionId: req.sessionId ?? null,
    });
  } catch (err) {
    next(err);
  }
});

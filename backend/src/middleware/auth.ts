import { NextFunction, Request, Response } from "express";
import { verifyAccessToken, verifyReportDownloadToken } from "../services/auth";
import { pool } from "../db/pg";

export interface AuthedRequest extends Request {
  userId?: string; // id de la fila en la tabla "users" de Neon
  userCode?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autenticado. Token faltante." });
  }
  const idToken = header.slice("Bearer ".length);
  try {
    const decoded = verifyAccessToken(idToken);
    const { rows } = await pool.query("SELECT active, code FROM users WHERE id = $1", [decoded.uid]);
    const user = rows[0];
    if (!user || user.active === false) {
      return res.status(401).json({ error: "Usuario no encontrado o inactivo." });
    }
    req.userId = decoded.uid;
    req.userCode = user.code;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o expirada." });
  }
}

/** Autoriza enlaces de descarga firmados, breves y limitados a una jornada. */
export function requireReportDownloadAuth(req: Request, res: Response, next: NextFunction) {
  const token = typeof req.query.download_token === "string" ? req.query.download_token : null;
  if (!token) return res.status(401).json({ error: "Enlace de descarga faltante o vencido." });
  try {
    verifyReportDownloadToken(token, req.params.workDayId);
    return next();
  } catch {
    return res.status(401).json({ error: "Enlace de descarga inválido o vencido." });
  }
}

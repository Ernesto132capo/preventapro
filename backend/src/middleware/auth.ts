import { NextFunction, Request, Response } from "express";
import { verifyAccessToken, verifyReportDownloadToken } from "../services/auth";
import { pool } from "../db/pg";

export interface AuthedRequest extends Request {
  userId?: string; // id de la fila en la tabla "users" de Neon
  userCode?: string;
  userRole?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autenticado. Token faltante." });
  }
  const idToken = header.slice("Bearer ".length);
  let decoded: { uid: string };
  try {
    decoded = verifyAccessToken(idToken);
  } catch {
    return res.status(401).json({ error: "Sesión inválida o expirada." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT active, code, COALESCE(role, 'preventista') AS role FROM users WHERE id = $1",
      [decoded.uid]
    );
    const user = rows[0];
    if (!user || user.active === false) {
      return res.status(401).json({ error: "Usuario no encontrado o inactivo." });
    }
    req.userId = decoded.uid;
    req.userCode = user.code;
    req.userRole = user.role || "preventista";
    next();
  } catch (dbErr) {
    console.error("Error de base de datos en requireAuth:", dbErr);
    return res.status(503).json({ error: "Error de conexión con la base de datos. Intente más tarde." });
  }
}

/** Middleware para exigir roles específicos. En Modo Compartido PreventaPro, todos los usuarios autenticados tienen permisos iguales. */
export function requireRole(..._allowedRoles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: "No autenticado." });
    }
    next();
  };
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

import { NextFunction, Request, Response } from "express";
import { verifyIdToken } from "../services/auth";
import { pool } from "../db/pg";

export interface AuthedRequest extends Request {
  userId?: string; // = uid de Firebase Auth = id de la fila en la tabla "users"
  userCode?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autenticado. Token faltante." });
  }
  const idToken = header.slice("Bearer ".length);
  try {
    const decoded = await verifyIdToken(idToken);
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

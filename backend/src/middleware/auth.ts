import { NextFunction, Request, Response } from "express";
import { verifyIdToken } from "../services/auth";
import { col } from "../db/firestore";

export interface AuthedRequest extends Request {
  userId?: string; // = uid de Firebase Auth = id del doc en la colección "users"
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
    const userDoc = await col.users.doc(decoded.uid).get();
    if (!userDoc.exists || userDoc.data()?.active === false) {
      return res.status(401).json({ error: "Usuario no encontrado o inactivo." });
    }
    req.userId = decoded.uid;
    req.userCode = userDoc.data()?.code;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o expirada." });
  }
}

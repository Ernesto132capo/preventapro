import { NextFunction, Request, RequestHandler, Response } from "express";

/** Fallos temporales de conexión no deben parecer errores de validación (4xx). */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: string; message?: string };
  return Boolean(
    (code && (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "40001", "40P01", "55P03", "57014", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code))) ||
    (message && /connection.*(?:terminated|closed|timeout|refused)|timeout.*(?:connect|pool)|too many clients/i.test(message))
  );
}

/** Express 4 requiere reenviar explícitamente los rechazos de handlers async. */
export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch((error: unknown) => {
      if (isDatabaseUnavailable(error) && !res.headersSent) {
        console.error("Base de datos temporalmente no disponible:", error);
        res.status(503).json({ error: "Error de conexión con la base de datos. Intente más tarde." });
        return;
      }
      next(error);
    });
  };
}

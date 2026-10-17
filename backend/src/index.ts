import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { authRouter } from "./routes/auth";
import { clientsRouter } from "./routes/clients";
import { catalogRouter } from "./routes/catalog";
import { workdaysRouter } from "./routes/workdays";
import { ordersRouter } from "./routes/orders";
import { syncRouter } from "./routes/sync";
import { reportsRouter } from "./routes/reports";
import { settingsRouter } from "./routes/settings";
import { ensureClientsSchema } from "./db/pg";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// Registra el path sin query string para no guardar tokens de descarga en los logs.
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path} -> ${res.statusCode}`);
  });
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "preventapro-backend" }));

app.use("/api/auth", authRouter);
app.use("/api/clients", clientsRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/workdays", workdaysRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/sync", syncRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/settings", settingsRouter);

// Manejador de 404 para rutas no existentes
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

// Manejador de errores centralizado — nunca dejar una excepción sin responder al cliente.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("Error en petición HTTP:", err);
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "El cuerpo de la petición excede el tamaño máximo permitido." });
  }
  if (err instanceof SyntaxError && "status" in err && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "JSON inválido en el cuerpo de la petición." });
  }
  const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(statusCode).json({ error: err?.message && statusCode < 500 ? err.message : "Error interno del servidor." });
});

const PORT = Number(process.env.PORT) || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PreventaPro backend escuchando en http://0.0.0.0:${PORT}`);
  ensureClientsSchema().catch((err) => console.warn("Aviso al verificar esquema de clientes:", err));
});

// Protección contra excepciones y rechazos no capturados
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught Exception crítica:", error);
  // Cierre con gracia y terminación del proceso para evitar estados corruptos
  try {
    server.close(() => {
      process.exit(1);
    });
  } catch {}
  setTimeout(() => {
    process.exit(1);
  }, 1000).unref();
});

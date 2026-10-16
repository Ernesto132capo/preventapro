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

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
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

// Manejador de errores centralizado — nunca dejar una excepción sin responder al cliente.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`✅ PreventaPro backend escuchando en http://0.0.0.0:${PORT}`);
});

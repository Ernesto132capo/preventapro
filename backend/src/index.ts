import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import "./firebase/admin"; // inicializa Firebase Admin al arrancar
import { authRouter } from "./routes/auth";
import { clientsRouter } from "./routes/clients";
import { catalogRouter } from "./routes/catalog";
import { workdaysRouter } from "./routes/workdays";
import { ordersRouter } from "./routes/orders";
import { syncRouter } from "./routes/sync";
import { reportsRouter } from "./routes/reports";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Registro local temporal para diagnosticar sincronización durante desarrollo.
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    if (req.originalUrl.startsWith("/api/")) {
      fs.appendFileSync(path.join(__dirname, "../sync-debug.log"), `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode}\n`);
    }
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

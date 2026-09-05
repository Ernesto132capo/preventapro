import { Router } from "express";
import path from "path";
import fs from "fs";
import { requireAuth } from "../middleware/auth";
import { generateClientReceiptsExcel, generateClientSummaryExcel, generateProductListExcel } from "../services/excel";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";

export const reportsRouter = Router();

// Los enlaces se abren en el navegador del teléfono, que no puede adjuntar el
// header Authorization de React Native. Aceptamos el token únicamente en esta
// ruta de descarga, para que el enlace autenticado funcione en desarrollo.
reportsRouter.get("/:workDayId/:fileName", (req, res, next) => {
  const token = typeof req.query.access_token === "string" ? req.query.access_token : null;
  if (token && !req.headers.authorization) req.headers.authorization = `Bearer ${token}`;
  requireAuth(req, res, next);
}, async (req, res) => {
  const { workDayId, fileName } = req.params;
  // Evitar path traversal
  const safeWorkDayId = path.basename(workDayId);
  const safeFileName = path.basename(fileName);
  const filePath = path.join(__dirname, "../../reports", safeWorkDayId, safeFileName);

  // Se regeneran los formatos conocidos para reflejar el diseño actual incluso
  // en jornadas cerradas antes de una actualización.
  if (["lista_de_productos.xlsx", "resumen_clientes.xlsx", "boletas_clientes.xlsx", "boletas_clientes.pdf"].includes(safeFileName)) {
    const reportDir = path.join(__dirname, "../../reports", safeWorkDayId);
    fs.mkdirSync(reportDir, { recursive: true });
    if (safeFileName === "lista_de_productos.xlsx") await generateProductListExcel(safeWorkDayId, reportDir);
    if (safeFileName === "resumen_clientes.xlsx") await generateClientSummaryExcel(safeWorkDayId, reportDir);
    if (safeFileName === "boletas_clientes.xlsx") await generateClientReceiptsExcel(safeWorkDayId, reportDir);
    await generateClientReceiptsPdf(safeWorkDayId, reportDir);
  }
  // También permite descargar los formatos nuevos desde jornadas cerradas antes
  // de esta actualización: los genera al primer acceso.
  if (!fs.existsSync(filePath) && ["lista_de_productos.xlsx", "resumen_clientes.xlsx", "boletas_clientes.xlsx"].includes(safeFileName)) {
    const reportDir = path.join(__dirname, "../../reports", safeWorkDayId);
    fs.mkdirSync(reportDir, { recursive: true });
    if (safeFileName === "lista_de_productos.xlsx") await generateProductListExcel(safeWorkDayId, reportDir);
    if (safeFileName === "resumen_clientes.xlsx") await generateClientSummaryExcel(safeWorkDayId, reportDir);
    if (safeFileName === "boletas_clientes.xlsx") await generateClientReceiptsExcel(safeWorkDayId, reportDir);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Reporte no encontrado." });
  }
  res.download(filePath, safeFileName);
});

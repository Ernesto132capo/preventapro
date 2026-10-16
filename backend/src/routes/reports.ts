import { Router } from "express";
import path from "path";
import fs from "fs";
import { requireAuth } from "../middleware/auth";
import { createReportDownloadToken, verifyReportDownloadToken } from "../services/auth";
import { generateClientReceiptsExcel, generateClientSummaryExcel, generateProductListExcel } from "../services/excel";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";

export const reportsRouter = Router();

// El navegador del teléfono no puede adjuntar el Bearer token de la app.
// Emitimos un enlace firmado, limitado a una jornada y válido por dos minutos.
reportsRouter.post("/:workDayId/download-token", requireAuth, (req, res) => {
  res.json({ downloadToken: createReportDownloadToken(req.params.workDayId) });
});

reportsRouter.get("/:workDayId/:fileName", (req, res, next) => {
  const token = typeof req.query.download_token === "string" ? req.query.download_token : null;
  if (!token) return res.status(401).json({ error: "Enlace de descarga faltante o vencido." });
  try {
    verifyReportDownloadToken(token, req.params.workDayId);
    next();
  } catch {
    return res.status(401).json({ error: "Enlace de descarga inválido o vencido." });
  }
}, async (req, res) => {
  const { workDayId, fileName } = req.params;
  // Evitar path traversal
  const safeWorkDayId = path.basename(workDayId);
  const safeFileName = path.basename(fileName);
  const filePath = path.join(__dirname, "../../reports", safeWorkDayId, safeFileName);

  // Regenera solo el formato solicitado para reflejar el diseño actual y evitar
  // trabajo innecesario, por ejemplo crear un PDF al descargar un Excel.
  const generators: Record<string, (id: string, dir: string) => Promise<string>> = {
    "lista_de_productos.xlsx": generateProductListExcel,
    "resumen_clientes.xlsx": generateClientSummaryExcel,
    "boletas_clientes.xlsx": generateClientReceiptsExcel,
    "boletas_clientes.pdf": generateClientReceiptsPdf,
  };
  const generateReport = generators[safeFileName];
  if (generateReport) {
    const reportDir = path.join(__dirname, "../../reports", safeWorkDayId);
    fs.mkdirSync(reportDir, { recursive: true });
    await generateReport(safeWorkDayId, reportDir);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Reporte no encontrado." });
  }
  res.download(filePath, safeFileName);
});

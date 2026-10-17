import { Router } from "express";
import path from "path";
import fs from "fs";
import { pool } from "../db/pg";
import { requireAuth, requireReportDownloadAuth, AuthedRequest } from "../middleware/auth";
import { createReportDownloadToken } from "../services/auth";
import { generateClientReceiptsExcel, generateClientSummaryExcel, generateProductListExcel } from "../services/excel";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";

export const reportsRouter = Router();

const reportsRoot = path.resolve(__dirname, "../../reports");
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const REPORT_GC_INTERVAL_MS = 60 * 60 * 1000;
let lastReportGcAt = 0;
let reportGcInFlight: Promise<void> | null = null;

// [M-12] Mapa de promesas en vuelo para deduplicar la generación concurrente de reportes
const reportsInFlight = new Map<string, Promise<string>>();

export async function getOrGenerateReport(
  fileName: string,
  workDayId: string,
  reportDir: string,
  generator: (id: string, dir: string) => Promise<string>
): Promise<string> {
  const flightKey = `${workDayId}:${fileName}`;
  const inFlight = reportsInFlight.get(flightKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    return await generator(workDayId, reportDir);
  })().finally(() => {
    reportsInFlight.delete(flightKey);
  });

  reportsInFlight.set(flightKey, task);
  return task;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Elimina reportes vencidos con I/O asíncrono para no bloquear el Event Loop. */
async function cleanupExpiredReportDirectories(): Promise<void> {
  if (reportGcInFlight) return reportGcInFlight;
  if (Date.now() - lastReportGcAt < REPORT_GC_INTERVAL_MS) return;

  const cleanup = (async () => {
    try {
      const entries = await fs.promises.readdir(reportsRoot, { withFileTypes: true });
      const now = Date.now();
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const directoryPath = path.join(reportsRoot, entry.name);
        try {
          const stats = await fs.promises.stat(directoryPath);
          if (now - stats.mtimeMs > REPORT_TTL_MS) {
            await fs.promises.rm(directoryPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            console.warn(`No se pudo limpiar la carpeta de reportes ${entry.name}:`, error);
          }
        }
      }));
    } catch (error) {
      // Es normal que el directorio aún no exista en una instalación nueva.
      if (!isMissingPathError(error)) {
        console.warn("No se pudieron revisar los reportes vencidos:", error);
      }
    }
  })();

  reportGcInFlight = cleanup.finally(() => {
    lastReportGcAt = Date.now();
    reportGcInFlight = null;
  });
  return reportGcInFlight;
}

// Hace una pasada al iniciar y vuelve a revisar, como máximo, una vez por hora
// cuando se solicita generar un reporte.
void cleanupExpiredReportDirectories();

// El navegador del teléfono no puede adjuntar el Bearer token de la app.
// Emitimos un enlace firmado, limitado a una jornada y válido por dos minutos.
reportsRouter.post("/:workDayId/download-token", requireAuth, async (req: AuthedRequest, res) => {
  const { workDayId } = req.params;
  try {
    const { rows } = await pool.query("SELECT id FROM work_days WHERE id = $1", [workDayId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Jornada no encontrada." });
    }
    res.json({ downloadToken: createReportDownloadToken(workDayId) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Error al generar token de descarga." });
  }
});

reportsRouter.get("/:workDayId/:fileName", requireReportDownloadAuth, async (req, res, next) => {
  const { workDayId, fileName } = req.params;
  // Rechazar segmentos de ruta antes de combinarlos con el directorio de reportes.
  const safeWorkDayId = path.basename(workDayId);
  const safeFileName = path.basename(fileName);
  if (safeWorkDayId !== workDayId || safeWorkDayId === "." || safeWorkDayId === "..") {
    return res.status(404).json({ error: "Reporte no encontrado." });
  }

  try {
    const { rows: wdRows } = await pool.query("SELECT id FROM work_days WHERE id = $1", [safeWorkDayId]);
    if (wdRows.length === 0) {
      return res.status(404).json({ error: "Jornada no encontrada." });
    }
  } catch (err) {
    return next(err);
  }

  // Regenera solo el formato solicitado para reflejar el diseño actual y evitar
  // trabajo innecesario, por ejemplo crear un PDF al descargar un Excel.
  const generators: Record<string, (id: string, dir: string) => Promise<string>> = {
    "lista_de_productos.xlsx": generateProductListExcel,
    "resumen_clientes.xlsx": generateClientSummaryExcel,
    "boletas_clientes.xlsx": generateClientReceiptsExcel,
    "boletas_clientes.pdf": generateClientReceiptsPdf,
  };
  // [M-12] Deduplicador de generación concurrente de reportes para evitar colisiones
  const generateReport = generators[safeFileName];
  if (!generateReport || safeFileName !== fileName) {
    return res.status(404).json({ error: "Reporte no encontrado." });
  }

  const reportDir = path.join(reportsRoot, safeWorkDayId);
  const filePath = path.join(reportDir, safeFileName);
  try {
    await cleanupExpiredReportDirectories();
    await fs.promises.mkdir(reportDir, { recursive: true });
    await getOrGenerateReport(safeFileName, safeWorkDayId, reportDir, generateReport);

    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) {
        return res.status(404).json({ error: "El reporte solicitado no está disponible." });
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return res.status(404).json({ error: "El reporte solicitado no está disponible." });
      }
      throw error;
    }

    return res.download(filePath, safeFileName, (error) => {
      if (!error) return;
      if (isMissingPathError(error) && !res.headersSent) {
        return res.status(404).json({ error: "El reporte solicitado ya no está disponible." });
      }
      next(error);
    });
  } catch (error) {
    return next(error);
  }
});

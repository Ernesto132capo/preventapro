import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import { getUniqueSheetName } from "../services/excel";
import { sanitizePdfText } from "../services/receipts-pdf";
import { getOrGenerateReport } from "../routes/reports";

describe("Reportes Hardening: PDFKit Unicode, ExcelJS Unique Sheets y Concurrencia", () => {
  describe("sanitizePdfText [M-04]", () => {
    it("elimina emojis de WhatsApp y símbolos fuera de Latin-1", () => {
      const input = "Tienda María 🛒📦 ✨ ¡Gran Oferta! 🔥";
      const sanitized = sanitizePdfText(input);
      expect(sanitized).toBe("Tienda María ¡Gran Oferta!");
      expect(sanitized).not.toContain("🛒");
      expect(sanitized).not.toContain("🔥");
    });

    it("preserva caracteres en español con tildes, diéresis y signos de apertura", () => {
      const input = "¿Quién pidió café con leche y azúcar en Güéjar? ¡Ñandú!";
      const sanitized = sanitizePdfText(input);
      expect(sanitized).toBe("¿Quién pidió café con leche y azúcar en Güéjar? ¡Ñandú!");
    });

    it("reemplaza flechas y comillas tipográficas por equivalentes compatibles", () => {
      const input = 'Combo “Fiesta” ➔ Opción ‘A’';
      const sanitized = sanitizePdfText(input);
      expect(sanitized).toBe('Combo "Fiesta" -> Opción \'A\'');
    });

    it("preserva viñetas (bullet points) utilizadas en los desgloses de combos", () => {
      const input = "   • Cereal Chocolate 300g";
      const sanitized = sanitizePdfText(input);
      expect(sanitized).toBe("• Cereal Chocolate 300g");
    });

    it("maneja entradas nulas o vacías de forma segura", () => {
      expect(sanitizePdfText(null)).toBe("");
      expect(sanitizePdfText(undefined)).toBe("");
      expect(sanitizePdfText("   ")).toBe("");
    });
  });

  describe("getUniqueSheetName [M-03]", () => {
    it("limpia caracteres prohibidos por Excel (* ? : \\ / [ ])", () => {
      const wb = new ExcelJS.Workbook();
      const raw = "Tienda [1] / Don? Pepe* : 2";
      const clean = getUniqueSheetName(wb, raw);
      expect(clean).not.toMatch(/[*?:\\/\[\]]/);
      expect(clean).toBe("Tienda 1 Don Pepe 2");
    });

    it("trunca nombres largos para no superar los 31 caracteres máximos de Excel", () => {
      const wb = new ExcelJS.Workbook();
      const longName = "Esta es una razón social sumamente larga que sobrepasa el límite";
      const sheetName = getUniqueSheetName(wb, longName);
      expect(sheetName.length).toBeLessThanOrEqual(31);
    });

    it("genera sufijos únicos incrementales (2), (3) para nombres duplicados case-insensitive", () => {
      const wb = new ExcelJS.Workbook();
      const name1 = getUniqueSheetName(wb, "Boleta 000001");
      wb.addWorksheet(name1);

      const name2 = getUniqueSheetName(wb, "boleta 000001"); // colisión case-insensitive detectada
      wb.addWorksheet(name2);

      const name3 = getUniqueSheetName(wb, "BOLETA 000001");
      wb.addWorksheet(name3);

      expect(name1).toBe("Boleta 000001");
      expect(name2.toLowerCase()).toBe("boleta 000001 (2)");
      expect(name3.toLowerCase()).toBe("boleta 000001 (3)");
    });

    it("respeta el límite de 31 caracteres incluso al añadir sufijos a nombres largos", () => {
      const wb = new ExcelJS.Workbook();
      const longName = "Supermercado Hipermaxi Central 123";
      const name1 = getUniqueSheetName(wb, longName);
      wb.addWorksheet(name1);

      const name2 = getUniqueSheetName(wb, longName);
      wb.addWorksheet(name2);

      expect(name1.length).toBeLessThanOrEqual(31);
      expect(name2.length).toBeLessThanOrEqual(31);
      expect(name2).toContain("(2)");
    });
  });

  describe("getOrGenerateReport Deduplicación Concurrente [M-12]", () => {
    it("deduplica peticiones en vuelo simultáneas y ejecuta el generador una sola vez", async () => {
      let executions = 0;
      const generator = vi.fn().mockImplementation(async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 20));
        return "/tmp/reports/wd-1/boletas.pdf";
      });

      // Tres llamadas concurrentes al mismo reporte
      const [res1, res2, res3] = await Promise.all([
        getOrGenerateReport("boletas.pdf", "wd-1", "/tmp/reports/wd-1", generator),
        getOrGenerateReport("boletas.pdf", "wd-1", "/tmp/reports/wd-1", generator),
        getOrGenerateReport("boletas.pdf", "wd-1", "/tmp/reports/wd-1", generator),
      ]);

      expect(res1).toBe("/tmp/reports/wd-1/boletas.pdf");
      expect(res2).toBe("/tmp/reports/wd-1/boletas.pdf");
      expect(res3).toBe("/tmp/reports/wd-1/boletas.pdf");
      expect(executions).toBe(1);
      expect(generator).toHaveBeenCalledTimes(1);
    });

    it("permite una nueva ejecución tras completarse la anterior", async () => {
      let executions = 0;
      const generator = vi.fn().mockImplementation(async () => {
        executions++;
        return `/tmp/reports/wd-1/run-${executions}.pdf`;
      });

      const first = await getOrGenerateReport("boletas.pdf", "wd-1", "/tmp/reports/wd-1", generator);
      const second = await getOrGenerateReport("boletas.pdf", "wd-1", "/tmp/reports/wd-1", generator);

      expect(first).toBe("/tmp/reports/wd-1/run-1.pdf");
      expect(second).toBe("/tmp/reports/wd-1/run-2.pdf");
      expect(executions).toBe(2);
    });
  });
});

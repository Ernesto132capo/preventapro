import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import fs from "fs";
import os from "os";
import path from "path";
import { inflateSync } from "zlib";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db/pg", () => ({ pool: { query: mocks.query } }));

import { generateClientReceiptsExcel, generateClientSummaryExcel, generateProductListExcel } from "../services/excel";
import { generateClientReceiptsPdf } from "../services/receipts-pdf";

let tempDir: string;
const common = {
  client_id: "client", business_name: "Tienda", contact_name: null, address: "Calle 1",
  presentation_name_snapshot: "Unidad", order_id: "order", receipt_number: 1,
  order_subtotal_cents: 704, order_tax_cents: 0, order_total_cents: 704,
  subtotal_cents_order: 704, tax_cents_order: 0, total_cents: 704,
  created_at: "2026-10-23T02:00:00.000Z",
};
const lines = [
  { ...common, order_item_id: "tiny", product_name_snapshot: "Combo Micro", quantity: 1, unit_price_cents_snapshot: 2, subtotal_cents: 2 },
  { ...common, order_item_id: "second", product_name_snapshot: "Combo Micro", quantity: 2, unit_price_cents_snapshot: 101, subtotal_cents: 202 },
  { ...common, order_item_id: "normal", product_name_snapshot: "A", quantity: 2, unit_price_cents_snapshot: 250, subtotal_cents: 500 },
];
const selections = [
  ...["A", "B", "C", "D"].map((name, index) => ({
    id: `tiny-${index}`, order_item_id: "tiny", product_name_snapshot: name,
    presentation_name_snapshot: "Unidad", quantity: 1, sort_order: index,
  })),
  { id: "second-A", order_item_id: "second", product_name_snapshot: "A", presentation_name_snapshot: "Unidad", quantity: 2, sort_order: 0 },
  { id: "second-B", order_item_id: "second", product_name_snapshot: "B", presentation_name_snapshot: "Unidad", quantity: 1, sort_order: 1 },
];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preventapro-report-finance-"));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM order_item_selections")) return { rows: selections };
    expect(sql).toContain("o.status = 'active'");
    if (sql.includes("GROUP BY")) return { rows: [{ ...common, total_cents: 704 }] };
    return { rows: lines };
  });
});

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

function pdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  const pattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try { streams.push(inflateSync(buffer.subarray(start, end)).toString("latin1")); } catch { /* no es un stream Flate */ }
    pattern.lastIndex = end + 9;
  }
  return streams.flatMap((stream) => Array.from(stream.matchAll(/\[([^\]]*)\]\s*TJ/g), (text) =>
    Array.from(text[1].matchAll(/<([0-9a-f]+)>/gi), (hex) => Buffer.from(hex[1], "hex").toString("latin1")).join("")
  )).join("\n");
}

describe("Reportes: centavos de combos y carpetas recién desplegadas", () => {
  it("desglosa combos de pocos centavos sin negativos y conserva unidades e importe combinado", async () => {
    const file = await generateProductListExcel("day", path.join(tempDir, "products", "new"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const products = new Map<string, { subtotal: number; units: number }>();
    workbook.worksheets[0].eachRow((row) => {
      const name = String(row.getCell(1).value);
      if (["A", "B", "C", "D"].includes(name)) {
        products.set(name, { subtotal: Math.round(Number(row.getCell(3).value) * 100), units: Number(row.getCell(4).value) });
      }
    });
    expect([...products.values()].every((product) => product.subtotal >= 0)).toBe(true);
    expect([...products.values()].reduce((sum, product) => sum + product.subtotal, 0)).toBe(704);
    expect(products.get("A")).toEqual({ subtotal: 636, units: 7 });
    expect(products.get("B")).toEqual({ subtotal: 68, units: 3 });
    expect(products.get("C")).toEqual({ subtotal: 0, units: 1 });
    expect(products.get("D")).toEqual({ subtotal: 0, units: 1 });
  });

  it("aclara cantidades por combo en Excel sin cambiar columnas ni el total del pedido", async () => {
    const file = await generateClientReceiptsExcel("day", path.join(tempDir, "receipts", "new"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const sheet = workbook.worksheets[0];
    const quantities: unknown[] = [];
    let total: unknown;
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value).includes("(por combo)")) quantities.push(row.getCell(3).value);
      if (row.getCell(4).value === "TOTAL") total = row.getCell(5).value;
    });
    expect(sheet.columnCount).toBe(5);
    expect(quantities).toEqual([1, 1, 1, 1, 2, 1]);
    expect(total).toBe(7.04);
  });

  it("crea el resumen en carpeta vacía y conserva su total financiero", async () => {
    const file = await generateClientSummaryExcel("day", path.join(tempDir, "summary", "new"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(sheet.rowCount).getCell(3).value).toBe(7.04);
  });

  it("conserva total, fecha boliviana y etiqueta por combo en el PDF real", async () => {
    const file = await generateClientReceiptsPdf("day", path.join(tempDir, "pdf", "new"));
    const text = pdfText(await fs.promises.readFile(file));
    expect(text).toContain("TOTAL: Bs. 7.04");
    expect(text).toContain("Bs. 0.02");
    expect(text).toContain("Bs. 2.02");
    expect(text).toContain("Bs. 5.00");
    expect(text).toContain("(por combo)");
    expect(text).toContain("22/10/2026");
  });
});

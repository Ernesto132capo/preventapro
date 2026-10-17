import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { pool } from "../db/pg";
import { formatBoliviaDate } from "./dates";
import { formatClientDisplayName } from "./client-display";

export interface OrderSelectionSnapshot {
  id: string;
  order_item_id: string;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  sort_order: number;
}

export interface ProductLineRow {
  order_item_id: string;
  client_id?: string;
  business_name: string;
  contact_name?: string | null;
  address: string | null;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  unit_price_cents_snapshot: number;
  subtotal_cents: number;
  order_id: string;
  order_subtotal_cents: number;
  order_tax_cents: number;
  order_total_cents: number;
  created_at: string;
  receipt_number: number;
  selections: OrderSelectionSnapshot[];
}

const headerFill = "001428";
const accentFill = "0F766E";
// Solo números: formatos personalizados con texto en algunas versiones de Excel
// se interpretan erróneamente como fechas. La moneda queda explícita en los encabezados.
const moneyFormat = "#,##0.00";

/**
 * [M-03] Genera un nombre de hoja único y seguro para ExcelJS.
 * - Limpia caracteres prohibidos: * ? : \ / [ ]
 * - Limita la longitud máxima a 31 caracteres (límite de especificación de Excel)
 * - Evita colisiones de nombres (case-insensitive) agregando sufijos " (2)", " (3)", etc.
 */
export function getUniqueSheetName(workbook: ExcelJS.Workbook, rawName: string): string {
  let cleanName = (rawName || "Hoja")
    .replace(/[*?:\\/\[\]]/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleanName) cleanName = "Hoja";

  const existingNames = new Set(
    workbook.worksheets.map((ws) => ws.name.toLowerCase().trim())
  );

  let candidate = cleanName.slice(0, 31).trim();
  if (!existingNames.has(candidate.toLowerCase())) {
    return candidate;
  }

  const base = cleanName.slice(0, 26).trim() || "Hoja";
  let counter = 2;
  while (true) {
    const suffix = ` (${counter})`;
    const allowedLen = 31 - suffix.length;
    candidate = `${base.slice(0, allowedLen).trim()}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    counter++;
  }
}

/**
 * [M-12] Escritura atómica a archivo temporal con rename para evitar archivos corruptos en concurrencia.
 */
async function writeWorkbookAtomic(wb: ExcelJS.Workbook, filePath: string): Promise<string> {
  const tmpFilePath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await wb.xlsx.writeFile(tmpFilePath);
    await fs.promises.rename(tmpFilePath, filePath);
    return filePath;
  } catch (err) {
    await fs.promises.unlink(tmpFilePath).catch(() => {});
    throw err;
  }
}

async function productRowsForWorkDay(workDayId: string): Promise<ProductLineRow[]> {
  // Filtro estricto por status = 'active' para que preventas anuladas/canceladas
  // jamás sumen unidades ni montos en los reportes.
  // [M-02] Incluye c.id para distinguir clientes homónimos
  const { rows } = await pool.query(
    `SELECT
       oi.id AS order_item_id,
       c.id AS client_id,
       c.business_name, c.contact_name, c.address,
       oi.product_name_snapshot, oi.presentation_name_snapshot, oi.quantity,
       oi.unit_price_cents_snapshot, oi.subtotal_cents,
       o.id AS order_id, o.subtotal_cents AS order_subtotal_cents, o.tax_cents AS order_tax_cents,
       o.total_cents AS order_total_cents, o.created_at, o.receipt_number
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.work_day_id = $1 AND o.status = 'active'
     ORDER BY c.business_name, c.id, o.created_at, oi.id`,
    [workDayId]
  );

  const orderItemIds = rows.map((r: any) => r.order_item_id);
  const selectionsByItem = new Map<string, OrderSelectionSnapshot[]>();

  if (orderItemIds.length > 0) {
    const { rows: selRows } = await pool.query(
      `SELECT
         id, order_item_id, product_name_snapshot, presentation_name_snapshot, quantity, sort_order
       FROM order_item_selections
       WHERE order_item_id = ANY($1)
       ORDER BY sort_order, id`,
      [orderItemIds]
    );
    for (const sel of selRows) {
      const list = selectionsByItem.get(sel.order_item_id) || [];
      list.push({
        id: sel.id,
        order_item_id: sel.order_item_id,
        product_name_snapshot: sel.product_name_snapshot,
        presentation_name_snapshot: sel.presentation_name_snapshot,
        quantity: Number(sel.quantity),
        sort_order: Number(sel.sort_order ?? 0),
      });
      selectionsByItem.set(sel.order_item_id, list);
    }
  }

  return rows.map((row: any) => ({
    order_item_id: row.order_item_id,
    client_id: row.client_id,
    business_name: row.business_name,
    contact_name: row.contact_name,
    address: row.address,
    product_name_snapshot: row.product_name_snapshot,
    presentation_name_snapshot: row.presentation_name_snapshot,
    quantity: Number(row.quantity),
    unit_price_cents_snapshot: Number(row.unit_price_cents_snapshot),
    subtotal_cents: Number(row.subtotal_cents),
    order_id: row.order_id,
    order_subtotal_cents: Number(row.order_subtotal_cents ?? row.order_total_cents),
    order_tax_cents: Number(row.order_tax_cents ?? 0),
    order_total_cents: Number(row.order_total_cents),
    created_at: row.created_at,
    receipt_number: Number(row.receipt_number),
    selections: selectionsByItem.get(row.order_item_id) || [],
  }));
}

function styleTableHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFill } };
  row.alignment = { vertical: "middle" };
}

function styleClientHeading(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accentFill } };
}

/**
 * Lista consolidada de productos pedidos en la jornada (excluyendo cancelados/anulados):
 * 4 columnas exactas:
 * 1. Producto (nombre del producto / presentación)
 * 2. Precio Unitario
 * 3. Precio Total (subtotal acumulado de ese producto)
 * 4. Total de Unidades Pedidas
 * Fila final: TOTAL GENERAL (suma de Precio Total y Total de Unidades)
 */
export async function generateProductListExcel(workDayId: string, outDir: string): Promise<string> {
  const rawRows = await productRowsForWorkDay(workDayId);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(getUniqueSheetName(wb, "Lista de Productos"));
  sheet.columns = [
    { width: 38 }, // Producto
    { width: 22 }, // Precio Unitario
    { width: 22 }, // Precio Total
    { width: 26 }, // Total de Unidades Pedidas
  ];
  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = "LISTA DE PRODUCTOS PEDIDOS";
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFill } };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.addRow([]);

  styleTableHeader(sheet.addRow([
    "Producto",
    "Precio Unitario",
    "Precio Total",
    "Total de Unidades Pedidas",
  ]));

  interface AggregatedProduct {
    displayName: string;
    unitPriceCents: number;
    totalSubtotalCents: number;
    totalUnits: number;
  }
  const map = new Map<string, AggregatedProduct>();

  for (const row of rawRows) {
    const isCombo = row.selections && row.selections.length > 0;
    if (isCombo) {
      // Desglosar el combo en sus productos individuales componentes
      const comboQty = Number(row.quantity || 0);
      const comboSubtotal = Number(row.subtotal_cents ?? (row.unit_price_cents_snapshot * comboQty));
      const totalSelQty = row.selections.reduce((sum, s) => sum + (Number(s.quantity) || 1), 0);

      let allocatedSubtotal = 0;
      for (let i = 0; i < row.selections.length; i++) {
        const sel = row.selections[i];
        const selFactor = Number(sel.quantity) || 1;
        const itemUnits = comboQty * selFactor;

        let itemSubtotal: number;
        if (i === row.selections.length - 1) {
          itemSubtotal = comboSubtotal - allocatedSubtotal;
        } else {
          itemSubtotal = totalSelQty > 0
            ? Math.round((comboSubtotal * selFactor) / totalSelQty)
            : Math.round(comboSubtotal / row.selections.length);
          allocatedSubtotal += itemSubtotal;
        }

        const isSpecialPres = sel.presentation_name_snapshot &&
          sel.presentation_name_snapshot !== "Unidad" &&
          sel.presentation_name_snapshot !== "Default" &&
          sel.presentation_name_snapshot !== sel.product_name_snapshot;
        const displayName = isSpecialPres
          ? `${sel.product_name_snapshot} (${sel.presentation_name_snapshot})`
          : sel.product_name_snapshot;

        const key = `${sel.product_name_snapshot}__${sel.presentation_name_snapshot}`;
        const existing = map.get(key);
        if (existing) {
          existing.totalUnits += itemUnits;
          existing.totalSubtotalCents += itemSubtotal;
          existing.unitPriceCents = existing.totalUnits > 0
            ? Math.round(existing.totalSubtotalCents / existing.totalUnits)
            : 0;
        } else {
          map.set(key, {
            displayName,
            totalSubtotalCents: itemSubtotal,
            totalUnits: itemUnits,
            unitPriceCents: itemUnits > 0 ? Math.round(itemSubtotal / itemUnits) : 0,
          });
        }
      }
    } else {
      const qty = Number(row.quantity || 0);
      const subtotal = Number(row.subtotal_cents ?? (row.unit_price_cents_snapshot * qty));
      const isSpecialPres = row.presentation_name_snapshot &&
        row.presentation_name_snapshot !== "Unidad" &&
        row.presentation_name_snapshot !== "Default" &&
        row.presentation_name_snapshot !== row.product_name_snapshot;
      const displayName = isSpecialPres
        ? `${row.product_name_snapshot} (${row.presentation_name_snapshot})`
        : row.product_name_snapshot;

      const key = `${row.product_name_snapshot}__${row.presentation_name_snapshot}`;
      const existing = map.get(key);
      if (existing) {
        existing.totalUnits += qty;
        existing.totalSubtotalCents += subtotal;
        existing.unitPriceCents = existing.totalUnits > 0
          ? Math.round(existing.totalSubtotalCents / existing.totalUnits)
          : 0;
      } else {
        map.set(key, {
          displayName,
          totalSubtotalCents: subtotal,
          totalUnits: qty,
          unitPriceCents: Number(row.unit_price_cents_snapshot || 0),
        });
      }
    }
  }

  let grandTotalCents = 0;
  let grandTotalUnits = 0;

  for (const item of map.values()) {
    grandTotalCents += item.totalSubtotalCents;
    grandTotalUnits += item.totalUnits;

    const row = sheet.addRow([
      item.displayName,
      item.unitPriceCents / 100,
      item.totalSubtotalCents / 100,
      item.totalUnits,
    ]);
    row.getCell(2).numFmt = moneyFormat;
    row.getCell(3).numFmt = moneyFormat;
    row.getCell(4).numFmt = "#,##0";
    row.getCell(4).alignment = { horizontal: "center" };
  }

  if (map.size === 0) {
    sheet.addRow(["No hay productos pedidos en esta jornada.", "", "", ""]);
  } else {
    sheet.addRow([]);
    const totalRow = sheet.addRow([
      "TOTAL GENERAL",
      "",
      grandTotalCents / 100,
      grandTotalUnits,
    ]);
    totalRow.font = { bold: true };
    totalRow.getCell(3).numFmt = moneyFormat;
    totalRow.getCell(4).numFmt = "#,##0";
    totalRow.getCell(4).alignment = { horizontal: "center" };
  }

  const filePath = path.join(outDir, "lista_de_productos.xlsx");
  return await writeWorkbookAtomic(wb, filePath);
}

/** Resumen compacto: una fila por cliente sin órdenes canceladas. */
export async function generateClientSummaryExcel(workDayId: string, outDir: string): Promise<string> {
  // [M-02] Agrupación por c.id para evitar fusionar clientes homónimos
  const { rows: summaryRows } = await pool.query(
    `SELECT c.id AS client_id, c.business_name, c.contact_name, COALESCE(SUM(o.total_cents), 0)::text AS total_cents
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     WHERE o.work_day_id = $1 AND o.status = 'active'
     GROUP BY c.id, c.business_name, c.contact_name
     ORDER BY COALESCE(NULLIF(c.business_name, ''), c.contact_name), c.id`,
    [workDayId]
  );
  const rows = summaryRows.map((row: any) => ({
    client_id: row.client_id,
    business_name: row.business_name,
    contact_name: row.contact_name,
    total_cents: Number(row.total_cents),
  }));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(getUniqueSheetName(wb, "Resumen de Clientes"));
  sheet.columns = [{ width: 10 }, { width: 35 }, { width: 20 }];
  styleTableHeader(sheet.addRow(["Nro.", "Cliente", "Total (Bs.)"]));
  let grandTotal = 0;
  rows.forEach((r, index) => {
    grandTotal += r.total_cents;
    const { primary, secondary } = formatClientDisplayName(r);
    const clientLabel = secondary ? `${primary} (${secondary})` : primary;
    const row = sheet.addRow([index + 1, clientLabel, r.total_cents / 100]);
    row.getCell(3).numFmt = moneyFormat;
  });
  const total = sheet.addRow(["", "TOTAL GENERAL", grandTotal / 100]);
  total.font = { bold: true };
  total.getCell(3).numFmt = moneyFormat;
  const filePath = path.join(outDir, "resumen_clientes.xlsx");
  return await writeWorkbookAtomic(wb, filePath);
}

/** Boletas: una hoja por preventa activa para entregar al cliente. */
export async function generateClientReceiptsExcel(workDayId: string, outDir: string): Promise<string> {
  const rows = await productRowsForWorkDay(workDayId);
  const wb = new ExcelJS.Workbook();
  const byOrder = new Map<string, ProductLineRow[]>();
  for (const row of rows) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) || []), row]);

  for (const lines of byOrder.values()) {
    const first = lines[0];
    const receiptCode = String(first.receipt_number).padStart(6, "0");
    const sheet = wb.addWorksheet(getUniqueSheetName(wb, `Boleta ${receiptCode}`));
    sheet.columns = [{ width: 32 }, { width: 22 }, { width: 12 }, { width: 20 }, { width: 20 }];
    sheet.mergeCells("A1:E1");
    sheet.getCell("A1").value = "BOLETA DE PREVENTA";
    sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFill } };
    sheet.getCell("A1").alignment = { horizontal: "center" };
    sheet.addRow(["Nro. de boleta", receiptCode]);
    const { primary, secondary } = formatClientDisplayName(first);
    sheet.addRow(["Cliente", primary]);
    if (secondary) {
      sheet.addRow(["Propietario", secondary]);
    }
    sheet.addRow(["Fecha", formatBoliviaDate(first.created_at)]);
    if (first.address) sheet.addRow(["Dirección", first.address]);
    sheet.addRow([]);
    styleTableHeader(sheet.addRow(["Producto", "Presentación", "Cantidad", "Precio unitario", "Subtotal"]));

    for (const line of lines) {
      const isCombo = line.selections && line.selections.length > 0;
      const displayName = isCombo ? `${line.product_name_snapshot} (Combo)` : line.product_name_snapshot;
      const row = sheet.addRow([
        displayName,
        line.presentation_name_snapshot,
        line.quantity,
        line.unit_price_cents_snapshot / 100,
        line.subtotal_cents / 100,
      ]);
      row.getCell(4).numFmt = moneyFormat;
      row.getCell(5).numFmt = moneyFormat;

      // Desglose de opciones del combo
      if (isCombo) {
        for (const sel of line.selections) {
          const selRow = sheet.addRow([
            `   • ${sel.product_name_snapshot}`,
            sel.presentation_name_snapshot,
            sel.quantity,
            "",
            "",
          ]);
          selRow.font = { italic: true, color: { argb: "FF4B5563" } };
        }
      }
    }

    const total = sheet.addRow(["", "", "", "TOTAL", first.order_total_cents / 100]);
    total.font = { bold: true };
    total.getCell(5).numFmt = moneyFormat;
  }

  if (byOrder.size === 0) wb.addWorksheet(getUniqueSheetName(wb, "Sin boletas")).getCell("A1").value = "No hay preventas activas.";
  const filePath = path.join(outDir, "boletas_clientes.xlsx");
  return await writeWorkbookAtomic(wb, filePath);
}

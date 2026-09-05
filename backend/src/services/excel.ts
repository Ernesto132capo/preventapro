import ExcelJS from "exceljs";
import path from "path";
import { col, orderItemsCol } from "../db/firestore";

interface ProductLineRow {
  business_name: string; address: string | null; product_name_snapshot: string;
  presentation_name_snapshot: string; quantity: number; unit_price_cents_snapshot: number;
  subtotal_cents: number; order_id: string; order_total_cents: number; created_at: string;
}

const headerFill = "001428";
const accentFill = "0F766E";
// Solo números: algunas versiones de Excel/LibreOffice interpretan formatos
// personalizados con "Bs." como fecha (por ejemplo 1/1/1). La moneda queda
// explícita en los encabezados de columna y el valor nunca se vuelve fecha.
const moneyFormat = "#,##0.00";

async function productRowsForWorkDay(workDayId: string): Promise<ProductLineRow[]> {
  const orders = (await col.orders.where("workDayId", "==", workDayId).get()).docs.filter(d => d.data().status !== "cancelled");
  const rows = (await Promise.all(orders.map(async o => { const d=o.data(), client=(await col.clients.doc(d.clientId).get()).data(); const items=await orderItemsCol(o.id).get(); return items.docs.map(i => ({ business_name:client?.businessName??"",address:client?.address??null,order_id:o.id,order_total_cents:d.totalCents,created_at:d.createdAt,...i.data() })); }))).flat() as ProductLineRow[];
  return rows.sort((a,b)=>a.business_name.localeCompare(b.business_name)||a.created_at.localeCompare(b.created_at));
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

/** Lista por cliente, sin SKU/barrio ni datos repetidos por cada producto. */
export async function generateProductListExcel(workDayId: string, outDir: string): Promise<string> {
  const rows = await productRowsForWorkDay(workDayId);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Lista de Productos");
  sheet.columns = [{ width: 30 }, { width: 20 }, { width: 12 }, { width: 18 }, { width: 18 }];
  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").value = "Lista de productos por cliente";
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFill } };
  sheet.getCell("A1").alignment = { horizontal: "center" };
  sheet.addRow([]);

  const byOrder = new Map<string, ProductLineRow[]>();
  for (const row of rows) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) || []), row]);
  for (const [orderId, lines] of byOrder) {
    const first = lines[0];
    const clientRow = sheet.addRow([`Cliente: ${first.business_name}`]);
    sheet.mergeCells(`A${clientRow.number}:E${clientRow.number}`);
    styleClientHeading(clientRow);
    styleTableHeader(sheet.addRow(["Producto", "Presentación", "Cantidad", "Precio unitario (Bs.)", "Subtotal (Bs.)"]));
    for (const line of lines) {
      const row = sheet.addRow([line.product_name_snapshot, line.presentation_name_snapshot, line.quantity, line.unit_price_cents_snapshot / 100, line.subtotal_cents / 100]);
      row.getCell(4).numFmt = moneyFormat; row.getCell(5).numFmt = moneyFormat;
    }
    const total = sheet.addRow(["", "", "", "Total del cliente", first.order_total_cents / 100]);
    total.font = { bold: true }; total.getCell(5).numFmt = moneyFormat;
    sheet.addRow([]);
  }
  const filePath = path.join(outDir, "lista_de_productos.xlsx");
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

/** Resumen compacto: una fila por cliente sin barrio. */
export async function generateClientSummaryExcel(workDayId: string, outDir: string): Promise<string> {
  const lines = await productRowsForWorkDay(workDayId); const totals = new Map<string, number>();
  lines.forEach(r => totals.set(r.business_name, r.order_total_cents));
  const rows = [...totals].map(([business_name,total_cents])=>({business_name,total_cents})).sort((a,b)=>a.business_name.localeCompare(b.business_name));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Resumen de Clientes");
  sheet.columns = [{ width: 10 }, { width: 35 }, { width: 20 }];
  styleTableHeader(sheet.addRow(["Nro.", "Cliente", "Total (Bs.)"]));
  let grandTotal = 0;
  rows.forEach((r, index) => {
    grandTotal += r.total_cents;
    const row = sheet.addRow([index + 1, r.business_name, r.total_cents / 100]);
    row.getCell(3).numFmt = moneyFormat;
  });
  const total = sheet.addRow(["", "TOTAL GENERAL", grandTotal / 100]);
  total.font = { bold: true }; total.getCell(3).numFmt = moneyFormat;
  const filePath = path.join(outDir, "resumen_clientes.xlsx");
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

/** Boletas: una hoja por preventa para entregar al cliente. */
export async function generateClientReceiptsExcel(workDayId: string, outDir: string): Promise<string> {
  const rows = await productRowsForWorkDay(workDayId);
  const wb = new ExcelJS.Workbook();
  const byOrder = new Map<string, ProductLineRow[]>();
  for (const row of rows) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) || []), row]);
  let number = 1;
  for (const lines of byOrder.values()) {
    const first = lines[0];
    const sheet = wb.addWorksheet(`Boleta ${String(number).padStart(3, "0")}`);
    sheet.columns = [{ width: 30 }, { width: 20 }, { width: 12 }, { width: 18 }, { width: 18 }];
    sheet.mergeCells("A1:E1");
    sheet.getCell("A1").value = "BOLETA DE PREVENTA";
    sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFill } };
    sheet.getCell("A1").alignment = { horizontal: "center" };
    sheet.addRow(["Nro. de boleta", `B-${String(number).padStart(4, "0")}`]);
    sheet.addRow(["Cliente", first.business_name]);
    sheet.addRow(["Fecha", first.created_at]);
    if (first.address) sheet.addRow(["Dirección", first.address]);
    sheet.addRow([]);
    styleTableHeader(sheet.addRow(["Producto", "Presentación", "Cantidad", "Precio unitario", "Subtotal"]));
    for (const line of lines) {
      const row = sheet.addRow([line.product_name_snapshot, line.presentation_name_snapshot, line.quantity, line.unit_price_cents_snapshot / 100, line.subtotal_cents / 100]);
      row.getCell(4).numFmt = moneyFormat; row.getCell(5).numFmt = moneyFormat;
    }
    const total = sheet.addRow(["", "", "", "TOTAL", first.order_total_cents / 100]);
    total.font = { bold: true }; total.getCell(5).numFmt = moneyFormat;
    number++;
  }
  if (byOrder.size === 0) wb.addWorksheet("Sin boletas").getCell("A1").value = "No hay preventas activas.";
  const filePath = path.join(outDir, "boletas_clientes.xlsx");
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

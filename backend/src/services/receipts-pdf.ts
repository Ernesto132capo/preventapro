import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { col, orderItemsCol, getNextReceiptNumber } from "../db/firestore";

interface ReceiptLine {
  order_id: string;
  created_at: string;
  total_cents: number;
  business_name: string;
  address: string | null;
  receipt_number: number;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  unit_price_cents_snapshot: number;
  subtotal_cents: number;
}

function money(cents: number) {
  return `Bs. ${(cents / 100).toFixed(2)}`;
}

function localDate(value: string) {
  return new Intl.DateTimeFormat("es-BO", { timeZone: "America/La_Paz", dateStyle: "short" }).format(new Date(value));
}

/** Un PDF imprimible: varias boletas por página, separadas por línea de corte. */
export async function generateClientReceiptsPdf(workDayId: string, outDir: string): Promise<string> {
  const orders = (await col.orders.where("workDayId", "==", workDayId).get()).docs.filter(d => d.data().status !== "cancelled");

  // Compatibilidad hacia atrás: una preventa creada antes de existir el
  // correlativo (o restaurada desde un respaldo previo a este cambio) recibe
  // su número recién acá, de forma perezosa, y queda persistido para
  // siempre — nunca se vuelve a recalcular en el próximo reporte.
  const receiptNumbers = new Map<string, number>();
  for (const order of orders) {
    const existing = order.data().receiptNumber;
    if (existing) { receiptNumbers.set(order.id, existing); continue; }
    const assigned = await getNextReceiptNumber();
    await order.ref.update({ receiptNumber: assigned });
    receiptNumbers.set(order.id, assigned);
  }

  const lines = (await Promise.all(orders.map(async order => { const d=order.data(), client=(await col.clients.doc(d.clientId).get()).data(), items=await orderItemsCol(order.id).get(); return items.docs.map(i => ({ order_id:order.id, created_at:d.createdAt, total_cents:d.totalCents, business_name:client?.businessName??"", address:client?.address??null, receipt_number: receiptNumbers.get(order.id)!, ...i.data() })); }))).flat() as ReceiptLine[];

  const byOrder = new Map<string, ReceiptLine[]>();
  for (const line of lines) byOrder.set(line.order_id, [...(byOrder.get(line.order_id) || []), line]);

  const filePath = path.join(outDir, "boletas_clientes.pdf");
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);

    for (const order of byOrder.values()) {
      const first = order[0];
      // Cada línea necesita ~21 pt; calculamos el alto antes de dibujarla para
      // no partir una boleta entre dos hojas.
      const receiptHeight = 160 + order.length * 21;
      if (doc.y + receiptHeight > 752) doc.addPage();
      // text() con x y width explícitos evita que el centrado herede el ancho
      // de la columna anterior al imprimir varios comprobantes en una página.
      doc.fillColor("#001428").font("Helvetica-Bold").fontSize(13)
        .text("COMPROBANTE DE VENTA", 42, doc.y, { width: 511, align: "center" });
      doc.moveDown(0.35);
      doc.fillColor("#111827").font("Helvetica").fontSize(10);
      doc.text(`Nro. de comprobante: ${String(first.receipt_number).padStart(6, "0")}`, 42, doc.y, { width: 511 });
      doc.text(`Cliente: ${first.business_name}`);
      doc.text(`Fecha: ${localDate(first.created_at)}`);
      if (first.address) doc.text(`Dirección: ${first.address}`);
      doc.moveDown(0.45);

      const x = [42, 215, 315, 380, 470];
      const widths = [173, 100, 65, 90, 83];
      const headerY = doc.y;
      doc.rect(42, headerY, 511, 18).fill("#001428");
      doc.fillColor("white").font("Helvetica-Bold").fontSize(8);
      const headerAlignments: PDFKit.Mixins.TextOptions["align"][] = ["left", "left", "center", "right", "right"];
      ["Producto", "Presentación", "Cantidad", "Precio unitario", "Subtotal"].forEach((label, i) =>
        doc.text(label, x[i] + 4, headerY + 5, { width: widths[i] - 8, align: headerAlignments[i] })
      );
      doc.y = headerY + 23;

      doc.fillColor("#111827").font("Helvetica").fontSize(9);
      for (const line of order) {
        const rowY = doc.y;
        doc.text(line.product_name_snapshot, x[0] + 4, rowY, { width: widths[0] - 8 });
        doc.text(line.presentation_name_snapshot, x[1] + 4, rowY, { width: widths[1] - 8 });
        doc.text(String(line.quantity), x[2] + 4, rowY, { width: widths[2] - 8, align: "center" });
        doc.text(money(line.unit_price_cents_snapshot), x[3] + 4, rowY, { width: widths[3] - 8, align: "right" });
        doc.text(money(line.subtotal_cents), x[4] + 4, rowY, { width: widths[4] - 8, align: "right" });
        doc.moveTo(42, rowY + 15).lineTo(553, rowY + 15).strokeColor("#D1D5DB").stroke();
        doc.y = rowY + 19;
      }
      doc.moveDown(0.25);
      doc.font("Helvetica-Bold").fontSize(10).text(`TOTAL: ${money(first.total_cents)}`, { align: "right" });
      doc.moveDown(0.45);
      doc.dash(3, { space: 3 }).moveTo(42, doc.y).lineTo(553, doc.y).strokeColor("#6B7280").stroke().undash();
      doc.moveDown(0.55);
    }
    if (byOrder.size === 0) doc.fontSize(14).text("No hay preventas activas para esta jornada.");
    doc.end();
  });
  return filePath;
}

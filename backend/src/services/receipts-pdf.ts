import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { pool } from "../db/pg";
import { formatBoliviaDate } from "./dates";
import { formatClientDisplayName } from "./client-display";

export interface ReceiptSelection {
  id: string;
  order_item_id: string;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  sort_order: number;
}

export interface ReceiptLine {
  order_id: string;
  order_item_id: string;
  created_at: string;
  total_cents: number;
  subtotal_cents_order: number;
  tax_cents_order: number;
  business_name: string | null;
  contact_name: string | null;
  address: string | null;
  receipt_number: number;
  product_name_snapshot: string;
  presentation_name_snapshot: string;
  quantity: number;
  unit_price_cents_snapshot: number;
  subtotal_cents: number;
  selections: ReceiptSelection[];
}

function money(cents: number) {
  return `Bs. ${(cents / 100).toFixed(2)}`;
}

/**
 * [M-04] Sanitiza texto para fuentes estándar de PDFKit (Helvetica / WinAnsi).
 * Normaliza a NFC, reemplaza símbolos comunes y elimina emojis/glifos fuera del rango Latin-1
 * para evitar que PDFKit lance excepciones o corrompa el archivo PDF.
 */
export function sanitizePdfText(text: string | null | undefined): string {
  if (text == null) return "";
  let str = String(text).normalize("NFC");

  // Reemplazar caracteres de control no permitidos
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Reemplazar comillas, guiones y flechas por equivalentes compatibles
  str = str
    .replace(/[—–]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[→➔➜]/g, "->")
    .replace(/[←]/g, "<-");

  // Eliminar emojis (surrogate pairs y bloques Unicode emoji)
  str = str.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu,
    ""
  );

  // Mantener solo caracteres en rango WinAnsi (ASCII, Latin-1 suplementario, saltos y viñeta •)
  str = str.replace(/[^\x20-\x7E\xA0-\xFF\u2022\n\r\t]/g, "");

  return str.replace(/[ \t]+/g, " ").trim();
}

/** Un PDF imprimible: varias boletas por página, separadas por línea de corte. */
export async function generateClientReceiptsPdf(workDayId: string, outDir: string): Promise<string> {
  // Filtro estricto por status = 'active' para excluir pedidos anulados de la impresión
  const { rows } = await pool.query(
    `SELECT
       o.id AS order_id, o.created_at, o.subtotal_cents AS subtotal_cents_order,
       o.tax_cents AS tax_cents_order, o.total_cents, o.receipt_number,
       c.business_name, c.contact_name, c.address,
       oi.id AS order_item_id,
       oi.product_name_snapshot, oi.presentation_name_snapshot, oi.quantity,
       oi.unit_price_cents_snapshot, oi.subtotal_cents
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.work_day_id = $1 AND o.status = 'active'
     ORDER BY o.created_at, oi.id`,
    [workDayId]
  );

  const orderItemIds = rows.map((r: any) => r.order_item_id);
  const selectionsByItem = new Map<string, ReceiptSelection[]>();

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

  const lines: ReceiptLine[] = rows.map((r: any) => ({
    order_id: r.order_id,
    order_item_id: r.order_item_id,
    created_at: r.created_at,
    total_cents: Number(r.total_cents),
    subtotal_cents_order: Number(r.subtotal_cents_order ?? r.total_cents),
    tax_cents_order: Number(r.tax_cents_order ?? 0),
    business_name: r.business_name ?? null,
    contact_name: r.contact_name ?? null,
    address: r.address,
    receipt_number: Number(r.receipt_number),
    product_name_snapshot: r.product_name_snapshot,
    presentation_name_snapshot: r.presentation_name_snapshot,
    quantity: Number(r.quantity),
    unit_price_cents_snapshot: Number(r.unit_price_cents_snapshot),
    subtotal_cents: Number(r.subtotal_cents),
    selections: selectionsByItem.get(r.order_item_id) || [],
  }));

  const byOrder = new Map<string, ReceiptLine[]>();
  for (const line of lines) byOrder.set(line.order_id, [...(byOrder.get(line.order_id) || []), line]);

  const filePath = path.join(outDir, "boletas_clientes.pdf");
  await fs.promises.mkdir(outDir, { recursive: true });
  // [M-12] y [A-11] Escritura atómica a archivo temporal con manejo robusto de errores
  const tmpFilePath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let finished = false;
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const stream = fs.createWriteStream(tmpFilePath);

    const cleanup = (err: any) => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      fs.promises.unlink(tmpFilePath).catch(() => {});
      reject(err);
    };

    doc.on("error", cleanup);
    stream.on("error", cleanup);

    // Esperar al cierre del descriptor permite renombrar también en Windows.
    stream.on("finish", () => { finished = true; });
    stream.on("close", () => {
      if (settled) return;
      if (!finished) return cleanup(new Error("La escritura del PDF se cerró antes de completarse."));
      settled = true;
      resolve();
    });

    try {
      doc.pipe(stream);

      for (const order of byOrder.values()) {
        const first = order[0];
        const pageBottom = () => doc.page.height - doc.page.margins.bottom;
        const { primary, secondary } = formatClientDisplayName(first);
        const x = [42, 215, 315, 380, 470];
        const widths = [173, 100, 65, 90, 83];
        const alignments: PDFKit.Mixins.TextOptions["align"][] = ["left", "left", "center", "right", "right"];

        const drawTableHeader = () => {
          const headerY = doc.y;
          doc.rect(42, headerY, 511, 18).fill("#001428");
          doc.fillColor("white").font("Helvetica-Bold").fontSize(8);
          ["Producto", "Presentación", "Cantidad", "Precio unitario", "Subtotal"].forEach((label, i) =>
            doc.text(label, x[i] + 4, headerY + 5, { width: widths[i] - 8, align: alignments[i], lineBreak: false })
          );
          doc.y = headerY + 23;
        };
        const continueReceipt = () => {
          doc.addPage();
          doc.fillColor("#001428").font("Helvetica-Bold").fontSize(11)
            .text("COMPROBANTE DE VENTA (continuación)", 42, doc.y, { width: 511, align: "center" });
          doc.fillColor("#111827").font("Helvetica").fontSize(9)
            .text(`Nro. de comprobante: ${String(first.receipt_number).padStart(6, "0")}`, 42, doc.y, { width: 511 })
            .text(`Cliente: ${sanitizePdfText(primary)}`, 42, doc.y, { width: 511 });
          doc.moveDown(0.4);
          drawTableHeader();
        };

        // Divide incluso palabras largas sin espacios. Así ninguna celda puede
        // forzar saltos automáticos de PDFKit mientras se dibujan otras columnas.
        const wrapCell = (value: string, width: number): string[] => {
          const result: string[] = [];
          for (const paragraph of value.split(/\r?\n/)) {
            let current = "";
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
              const candidate = current ? `${current} ${word}` : word;
              if (doc.widthOfString(candidate) <= width) { current = candidate; continue; }
              if (current) { result.push(current); current = ""; }
              for (const char of word) {
                if (current && doc.widthOfString(current + char) > width) {
                  result.push(current);
                  current = "";
                }
                current += char;
              }
            }
            result.push(current);
          }
          return result.length ? result : [""];
        };
        const drawRow = (cells: string[], selection = false) => {
          const font = selection ? "Helvetica-Oblique" : "Helvetica";
          const size = selection ? 8 : 9;
          doc.font(font).fontSize(size);
          const wrapped = cells.map((cell, i) => wrapCell(cell, widths[i] - 8));
          const lineHeight = doc.currentLineHeight(true);
          const totalLines = Math.max(...wrapped.map((cell) => cell.length));
          let offset = 0;
          while (offset < totalLines) {
            let availableLines = Math.floor((pageBottom() - doc.y - 8) / lineHeight);
            // Mantener una fila normal completa cuando puede caber en una página;
            // filas excepcionalmente altas se continúan sin perder texto.
            if (availableLines < 1 || (offset === 0 && totalLines > availableLines && totalLines * lineHeight + 8 < 570)) {
              continueReceipt();
              availableLines = Math.floor((pageBottom() - doc.y - 8) / lineHeight);
            }
            const count = Math.min(totalLines - offset, Math.max(1, availableLines));
            const rowY = doc.y;
            const rowHeight = Math.max(selection ? 17 : 19, count * lineHeight + 8);
            doc.fillColor(selection ? "#4B5563" : "#111827").font(font).fontSize(size);
            wrapped.forEach((cell, i) => {
              const text = cell.slice(offset, offset + count).join("\n");
              if (text) doc.text(text, x[i] + 4, rowY, {
                width: widths[i] - 8, height: count * lineHeight + 1,
                align: alignments[i], lineGap: 0, paragraphGap: 0,
              });
            });
            doc.moveTo(42, rowY + rowHeight - 4).lineTo(553, rowY + rowHeight - 4)
              .strokeColor(selection ? "#E5E7EB" : "#D1D5DB").stroke();
            doc.y = rowY + rowHeight;
            offset += count;
            if (offset < totalLines) continueReceipt();
          }
        };

        // Reservar encabezado y primera fila; el resto pagina fila por fila.
        doc.font("Helvetica").fontSize(10);
        const headerHeight = 100 + doc.heightOfString(`Cliente: ${sanitizePdfText(primary)}`, { width: 511 })
          + (secondary ? doc.heightOfString(`Propietario: ${sanitizePdfText(secondary)}`, { width: 511 }) : 0)
          + (first.address ? doc.heightOfString(`Dirección: ${sanitizePdfText(first.address)}`, { width: 511 }) : 0);
        if (doc.y > doc.page.margins.top && doc.y + headerHeight + 25 > pageBottom()) doc.addPage();

        // text() con x y width explícitos evita que el centrado herede el ancho
        // de la columna anterior al imprimir varios comprobantes en una página.
        doc.fillColor("#001428").font("Helvetica-Bold").fontSize(13)
          .text("COMPROBANTE DE VENTA", 42, doc.y, { width: 511, align: "center" });
        doc.moveDown(0.35);
        doc.fillColor("#111827").font("Helvetica").fontSize(10);
        doc.text(`Nro. de comprobante: ${String(first.receipt_number).padStart(6, "0")}`, 42, doc.y, { width: 511 });
        doc.text(`Cliente: ${sanitizePdfText(primary)}`);
        if (secondary) {
          doc.text(`Propietario: ${sanitizePdfText(secondary)}`);
        }
        doc.text(`Fecha: ${formatBoliviaDate(first.created_at)}`);
        if (first.address) doc.text(`Dirección: ${sanitizePdfText(first.address)}`);
        doc.moveDown(0.45);

        drawTableHeader();

        for (const line of order) {
          const isCombo = line.selections && line.selections.length > 0;
          const rawName = isCombo ? `${line.product_name_snapshot} (Combo)` : line.product_name_snapshot;
          const displayName = sanitizePdfText(rawName);
          drawRow([displayName, sanitizePdfText(line.presentation_name_snapshot), String(line.quantity),
            money(line.unit_price_cents_snapshot), money(line.subtotal_cents)]);

          // Desglose de ítems incluidos en el combo
          if (isCombo) {
            for (const sel of line.selections) {
              drawRow([`   • ${sanitizePdfText(sel.product_name_snapshot)} (por combo)`, sanitizePdfText(sel.presentation_name_snapshot),
                String(sel.quantity), "-", "-"], true);
            }
          }
        }

        if (doc.y + 45 > pageBottom()) continueReceipt();
        doc.moveDown(0.25);
        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(`TOTAL: ${money(first.total_cents)}`, 42, doc.y, { width: 511, align: "right" });
        doc.moveDown(0.45);
        doc.dash(3, { space: 3 }).moveTo(42, doc.y).lineTo(553, doc.y).strokeColor("#6B7280").stroke().undash();
        doc.moveDown(0.55);
      }

      if (byOrder.size === 0) {
        doc.fillColor("#111827").font("Helvetica").fontSize(14).text("No hay preventas activas para esta jornada.");
      }
      doc.end();
    } catch (err) {
      cleanup(err);
    }
  });

  await fs.promises.rename(tmpFilePath, filePath);
  return filePath;
}

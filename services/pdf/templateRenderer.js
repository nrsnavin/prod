"use strict";

// ══════════════════════════════════════════════════════════════
//  TEMPLATE PDF RENDERER
//
//  renderTemplatePdf(template, context) -> Promise<Buffer>
//
//  template : { pageSize, orientation, elements:[...] }  (PdfTemplate)
//  context  : { fields:{key:value}, rows:[{...}], logo:"data:..." }
//
//  Non-table elements are drawn once (the letterhead). The single
//  `table` element renders context.rows and paginates: on overflow it
//  starts a new page and repeats the column header, so multi-page
//  documents stay readable.
//
//  All geometry is in PDF points (1pt = 1/72"), origin top-left —
//  matching the web canvas editor, so what you design is what prints.
// ══════════════════════════════════════════════════════════════

const PDFDocument = require("pdfkit");

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PAGE = {
  A4: { portrait: [595.28, 841.89], landscape: [841.89, 595.28] },
  LETTER: { portrait: [612, 792], landscape: [792, 612] },
};

function safeColor(c, fallback) {
  return c && HEX.test(c) ? c : fallback;
}
function inr(n) { return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
function num(n) {
  const v = Number(n) || 0;
  return (Math.round(v * 100) / 100).toLocaleString("en-IN");
}
function fmtCell(value, format) {
  if (value === null || value === undefined || value === "") return "";
  if (format === "currency") return inr(value);
  if (format === "number") return num(value);
  return String(value);
}

function font(doc, el) {
  const b = el.bold, i = el.italic;
  const name = b && i ? "Helvetica-BoldOblique" : b ? "Helvetica-Bold" : i ? "Helvetica-Oblique" : "Helvetica";
  doc.font(name);
}

function renderTemplatePdf(template, context = {}) {
  return new Promise((resolve, reject) => {
    try {
      const size = PAGE[template.pageSize] ? template.pageSize : "A4";
      const orient = template.orientation === "landscape" ? "landscape" : "portrait";
      const [pw, ph] = PAGE[size][orient];

      const doc = new PDFDocument({ size: [pw, ph], margin: 0 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const fields = context.fields || {};
      const rows = Array.isArray(context.rows) ? context.rows : [];
      const elements = Array.isArray(template.elements) ? template.elements : [];
      const tableEl = elements.find((e) => e.type === "table");
      const others = elements.filter((e) => e.type !== "table");

      const resolveText = (el) => {
        if (el.type === "field") {
          const v = fields[el.field];
          return v === undefined || v === null ? "" : String(v);
        }
        return el.text || "";
      };

      // ── Non-table elements (letterhead) — page 1 only ──
      for (const el of others) {
        if (el.type === "text" || el.type === "field") {
          const txt = resolveText(el);
          if (!txt) continue;
          font(doc, el);
          doc.fontSize(el.fontSize || 10).fillColor(safeColor(el.color, "#0D1B2A"));
          doc.text(txt, el.x, el.y, {
            width: el.w || undefined,
            align: el.align || "left",
            lineBreak: true,
          });
        } else if (el.type === "line") {
          doc.moveTo(el.x, el.y).lineTo(el.x + (el.w || 0), el.y + (el.h || 0))
            .lineWidth(el.lineWidth || 1).strokeColor(safeColor(el.color, "#0D1B2A")).stroke();
        } else if (el.type === "box") {
          doc.rect(el.x, el.y, el.w || 0, el.h || 0).lineWidth(el.lineWidth || 1);
          if (el.fill && HEX.test(el.fill)) doc.fillAndStroke(el.fill, safeColor(el.color, "#0D1B2A"));
          else doc.strokeColor(safeColor(el.color, "#0D1B2A")).stroke();
        } else if (el.type === "image") {
          const logo = context.logo || "";
          const m = /^data:image\/[a-zA-Z.+-]+;base64,(.+)$/.exec(logo);
          if (m) {
            try {
              const buf = Buffer.from(m[1], "base64");
              doc.image(buf, el.x, el.y, { fit: [el.w || 100, el.h || 50] });
            } catch (_) { /* bad image data — skip, never break the PDF */ }
          }
        }
      }

      // ── Table element (paginates) ──
      if (tableEl) {
        const cols = Array.isArray(tableEl.columns) ? tableEl.columns : [];
        const totalWeight = cols.reduce((s, c) => s + (Number(c.width) || 1), 0) || 1;
        const tableW = tableEl.w || (pw - tableEl.x - 40);
        const widths = cols.map((c) => ((Number(c.width) || 1) / totalWeight) * tableW);
        const xAt = (i) => tableEl.x + widths.slice(0, i).reduce((a, b) => a + b, 0);
        const fs = tableEl.fontSize || 9;
        const HEAD_H = fs + 10;
        const ROW_H = fs + 8;
        const headerBg = safeColor(tableEl.headerBg, "#1D6FEB");
        const pageBottom = ph - 40;

        const drawHead = (y) => {
          doc.rect(tableEl.x, y, tableW, HEAD_H).fill(headerBg);
          doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(fs);
          cols.forEach((c, i) => {
            doc.text(String(c.header || ""), xAt(i) + 4, y + 5, {
              width: widths[i] - 8, align: c.align || "left", lineBreak: false,
            });
          });
          return y + HEAD_H;
        };

        let y = drawHead(tableEl.y);
        rows.forEach((row, idx) => {
          if (y + ROW_H > pageBottom) {
            doc.addPage();
            y = drawHead(40);
          }
          if (tableEl.zebra && idx % 2 === 1) {
            doc.rect(tableEl.x, y, tableW, ROW_H).fill("#F4F7FC");
          }
          doc.fillColor("#33415C").font("Helvetica").fontSize(fs);
          cols.forEach((c, i) => {
            doc.text(fmtCell(row[c.field], c.format), xAt(i) + 4, y + 4, {
              width: widths[i] - 8, align: c.align || "left", lineBreak: false,
            });
          });
          doc.moveTo(tableEl.x, y + ROW_H).lineTo(tableEl.x + tableW, y + ROW_H)
            .lineWidth(0.5).strokeColor("#DDE3EE").stroke();
          y += ROW_H;
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderTemplatePdf };

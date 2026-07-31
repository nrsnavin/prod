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
// "Rs." rather than ₹ (U+20B9): pdfkit's built-in Helvetica is WinAnsi-only,
// and the rupee sign is outside that set — it came out as a stray "¹" on
// every currency cell. Same convention as the payslip PDF (api/payroll.js).
function inr(n) { return "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
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

      // bufferPages keeps every page addressable after the fact, which is
      // what a "Page 1 of 3" stamp needs — the total is not known until the
      // table has finished paginating.
      const doc = new PDFDocument({ size: [pw, ph], margin: 0, bufferPages: true });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const fields = context.fields || {};
      const rows = Array.isArray(context.rows) ? context.rows : [];
      const elements = Array.isArray(template.elements) ? template.elements : [];
      const tableEl = elements.find((e) => e.type === "table");

      // Anything sitting below the table is the footer band — totals, terms,
      // signatures. It belongs on the LAST page: drawn on page 1 it would be
      // overrun by a table that paginates past it, and a two-page challan
      // would carry its signature strip on the wrong page.
      const tableBottom = tableEl ? tableEl.y + (tableEl.h || 0) : Infinity;
      const isFooter = (e) =>
        e.type !== "table" && e.type !== "pageNumber" && e.y >= tableBottom;

      const others = elements.filter(
        (e) => e.type !== "table" && e.type !== "pageNumber" && !isFooter(e)
      );
      const footers = elements.filter(isFooter);

      const resolveText = (el) => {
        if (el.type === "field") {
          const v = fields[el.field];
          return v === undefined || v === null ? "" : String(v);
        }
        return el.text || "";
      };

      const drawElements = (list) => {
      for (const el of list) {
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
      };

      // ── Letterhead + party panes — page 1 ──
      drawElements(others);

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
        // White on a strong fill is the default; a light header needs dark
        // text, so a monochrome form can set it explicitly.
        const headerColor = safeColor(tableEl.headerColor, "#FFFFFF");
        const gridColor = safeColor(tableEl.gridColor, "#DDE3EE");
        // Ruled columns and an outer frame. Off by default so existing
        // templates keep the lighter look they were designed against.
        const grid = tableEl.grid === true;
        // The designer gives the table a height; honour it. Using the page
        // edge instead is what let rows print straight through the totals
        // and signature blocks below.
        const designedBottom = tableEl.h ? tableEl.y + tableEl.h : ph - 40;
        const pageBottom = Math.min(designedBottom, ph - 40);
        // Continuation pages have no letterhead above the table, so the body
        // may use the full height from the top margin down.
        const contBottom = ph - 40;

        const vRules = (top, bottom) => {
          if (!grid) return;
          doc.lineWidth(0.5).strokeColor(gridColor);
          for (let i = 1; i < cols.length; i++) {
            doc.moveTo(xAt(i), top).lineTo(xAt(i), bottom).stroke();
          }
          // Outer left/right edges.
          doc.moveTo(tableEl.x, top).lineTo(tableEl.x, bottom).stroke();
          doc.moveTo(tableEl.x + tableW, top).lineTo(tableEl.x + tableW, bottom).stroke();
        };

        const drawHead = (y) => {
          doc.rect(tableEl.x, y, tableW, HEAD_H).fill(headerBg);
          doc.fillColor(headerColor).font("Helvetica-Bold").fontSize(fs);
          cols.forEach((c, i) => {
            doc.text(String(c.header || ""), xAt(i) + 4, y + 5, {
              width: widths[i] - 8, align: c.align || "left", lineBreak: false,
            });
          });
          if (grid) {
            doc.rect(tableEl.x, y, tableW, HEAD_H)
              .lineWidth(0.5).strokeColor(gridColor).stroke();
            vRules(y, y + HEAD_H);
          }
          return y + HEAD_H;
        };

        let y = drawHead(tableEl.y);
        // Where the current page's body starts, so its column rules can be
        // drawn in one pass when the page is finished.
        let bodyTop = y;

        let limit = pageBottom;
        rows.forEach((row, idx) => {
          if (y + ROW_H > limit) {
            vRules(bodyTop, y);
            doc.addPage();
            y = drawHead(40);
            bodyTop = y;
            // Leave room on the final page for the footer band; a
            // continuation page that ends the document still needs it.
            limit = contBottom - (footers.length ? ph - tableBottom : 0);
          }
          if (tableEl.zebra && idx % 2 === 1) {
            doc.rect(tableEl.x, y, tableW, ROW_H).fill(safeColor(tableEl.zebraBg, "#F4F7FC"));
          }
          doc.fillColor(safeColor(tableEl.bodyColor, "#33415C")).font("Helvetica").fontSize(fs);
          cols.forEach((c, i) => {
            doc.text(fmtCell(row[c.field], c.format), xAt(i) + 4, y + 4, {
              width: widths[i] - 8, align: c.align || "left", lineBreak: false,
            });
          });
          doc.moveTo(tableEl.x, y + ROW_H).lineTo(tableEl.x + tableW, y + ROW_H)
            .lineWidth(0.5).strokeColor(gridColor).stroke();
          y += ROW_H;
        });
        vRules(bodyTop, y);
      }

      // ── Footer band — last page only ──
      if (footers.length) drawElements(footers);

      // ── Page numbering ──
      // Stamped last because the total page count is only known once the
      // table has paginated. Opt-in: a template without a pageNumber element
      // prints exactly as it did before.
      const pageEl = elements.find((e) => e.type === "pageNumber");
      if (pageEl) {
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(range.start + i);
          font(doc, pageEl);
          doc.fontSize(pageEl.fontSize || 8).fillColor(safeColor(pageEl.color, "#8895A7"));
          const label = (pageEl.text || "Page {{n}} of {{total}}")
            .replace("{{n}}", String(i + 1))
            .replace("{{total}}", String(range.count));
          doc.text(label, pageEl.x, pageEl.y, {
            width: pageEl.w || 200,
            align: pageEl.align || "right",
            lineBreak: false,
          });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderTemplatePdf };

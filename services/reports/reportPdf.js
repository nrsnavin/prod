"use strict";
// ═════════════════════════════════════════════════════════════════
//  Report PDF renderer (pdfkit).
//
//  Turns any report's { title, rangeLabel, summaryLine, columns, rows }
//  into a clean, tabular A4 PDF in the Zoho-Books style: a titled
//  header block with the period, a one-line summary, then a striped
//  data table with a coloured header row, right-aligned numeric /
//  currency columns, and automatic pagination (the header row and a
//  page footer repeat on every page).
//
//  Columns carry a `format` hint (text | number | currency) so the
//  same values shown on screen / in CSV are formatted identically here.
//
//  renderReportPdf(opts) -> Promise<Buffer>
// ═════════════════════════════════════════════════════════════════

const PDFDocument = require("pdfkit");

const BRAND = "#1D6FEB";
const INK = "#0D1B2A";
const MUTE = "#5A6A85";
const STRIPE = "#F4F7FC";
const LINE = "#DDE3EE";

function inr(n) { return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
function num(n) {
  const v = Number(n) || 0;
  return (Math.round(v * 100) / 100).toLocaleString("en-IN");
}
function fmtCell(value, format) {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "currency") return inr(value);
  if (format === "number") return num(value);
  return String(value);
}

/**
 * @param {object} o
 * @param {string} o.title        e.g. "Dispatch & Customer Sales"
 * @param {string} o.rangeLabel   e.g. "This month" / "01 Jul – 31 Jul 2026"
 * @param {string} [o.summaryLine] one-line key figures
 * @param {string} [o.company]    header company name
 * @param {Array<{key,header,format}>} o.columns
 * @param {Array<object>} o.rows
 * @returns {Promise<Buffer>}
 */
function renderReportPdf({ title, rangeLabel, summaryLine, company = "Balu Elastics", accent, columns, rows }) {
  // Accent (header + table-header colour) is configurable via Document
  // Settings; fall back to the built-in brand blue.
  const brand = accent && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent) ? accent : BRAND;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentW = right - left;

    // ── Column geometry: first (label) column wide, the rest equal ──
    const cols = columns || [];
    const numCols = Math.max(1, cols.length - 1);
    const labelW = Math.round(contentW * 0.40);
    const otherW = Math.floor((contentW - labelW) / numCols);
    const widths = cols.map((_, i) => (i === 0 ? labelW : otherW));
    const xAt = (i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0);
    const isNum = (c) => c.format === "number" || c.format === "currency";

    // ── Header block ────────────────────────────────────────────────
    function drawDocHeader() {
      doc.fillColor(brand).font("Helvetica-Bold").fontSize(16).text(company, left, 40);
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(title, left, 62);
      doc.fillColor(MUTE).font("Helvetica").fontSize(9)
        .text(`Period: ${rangeLabel || "—"}`, left, 84)
        .text(`Generated: ${new Date().toLocaleString("en-IN")}`, left, 96);
      if (summaryLine) {
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(summaryLine, left, 114, { width: contentW });
      }
      doc.moveTo(left, 132).lineTo(right, 132).strokeColor(LINE).lineWidth(1).stroke();
      return 140;
    }

    const HEADER_H = 22;
    const ROW_H = 20;
    const bottom = doc.page.height - doc.page.margins.bottom - 20;

    function drawTableHeader(y) {
      doc.rect(left, y, contentW, HEADER_H).fill(brand);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9);
      cols.forEach((c, i) => {
        doc.text(String(c.header || ""), xAt(i) + 6, y + 6, {
          width: widths[i] - 12,
          align: isNum(c) ? "right" : "left",
          lineBreak: false,
        });
      });
      return y + HEADER_H;
    }

    let pageNo = 1;
    function drawFooter() {
      doc.fillColor(MUTE).font("Helvetica").fontSize(8)
        .text(`Page ${pageNo}`, left, doc.page.height - doc.page.margins.bottom - 6, { width: contentW, align: "right" });
    }

    // ── Render ──────────────────────────────────────────────────────
    let y = drawDocHeader();
    y = drawTableHeader(y);

    if (!rows || rows.length === 0) {
      doc.fillColor(MUTE).font("Helvetica-Oblique").fontSize(10)
        .text("No data for this period.", left, y + 12, { width: contentW, align: "center" });
      drawFooter();
      doc.end();
      return;
    }

    rows.forEach((row, idx) => {
      if (y + ROW_H > bottom) {
        drawFooter();
        doc.addPage();
        pageNo += 1;
        y = 40;
        y = drawTableHeader(y);
      }
      if (idx % 2 === 1) doc.rect(left, y, contentW, ROW_H).fill(STRIPE);
      doc.fillColor(INK).font("Helvetica").fontSize(9);
      cols.forEach((c, i) => {
        doc.fillColor(i === 0 ? INK : "#33415C").text(fmtCell(row[c.key], c.format), xAt(i) + 6, y + 6, {
          width: widths[i] - 12,
          align: isNum(c) ? "right" : "left",
          lineBreak: false,
        });
      });
      doc.moveTo(left, y + ROW_H).lineTo(right, y + ROW_H).strokeColor(LINE).lineWidth(0.5).stroke();
      y += ROW_H;
    });

    drawFooter();
    doc.end();
  });
}

module.exports = { renderReportPdf };

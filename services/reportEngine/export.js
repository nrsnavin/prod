'use strict';
// ══════════════════════════════════════════════════════════════════
//  A REPORT AS A FILE: Excel, PDF or CSV
//
//  toXlsx(result, meta) → Buffer   a real spreadsheet: typed cells
//    (numbers stay numbers), Indian number and rupee formats, a bold
//    header that stays put, filters on, a totals row, and the title,
//    period and filters above it.
//  toPdf(result, meta)  → Buffer   A4, landscape when the columns need
//    it; header row on every page, long text cut with "…", totals at the
//    end, "Page n of m", the rupee sign in a font that has it.
//  toCsv(result)        → string
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { drawLine, hasOtherScript } = require('../../utils/pdfScripts');
const { toCsv: csvOf } = require('../reports/csv');

const BRAND = '#1D6FEB';
const INK = '#0D1B2A';
const MUTE = '#5A6A85';
const STRIPE = '#F4F7FC';
const LINE = '#DDE3EE';

const isNum = (c) => c.type === 'number' || c.type === 'money';
const fmt = (v, type) => {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (type === 'number') return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) { const [y, m, d] = String(v).split('-'); return `${d}/${m}/${y}`; }
  return String(v);
};

async function toXlsx(result, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.company || 'Factory';
  wb.created = new Date();
  const ws = wb.addWorksheet((meta.title || 'Report').replace(/[\\/*?:[\]]/g, ' ').slice(0, 31));
  const cols = result.columns;
  const head = [meta.company, meta.title, [meta.rangeLabel, meta.filterLine].filter(Boolean).join(' · ')].filter(Boolean);
  head.forEach((line, i) => { const r = ws.addRow([line]); r.font = { bold: i < 2, size: i === 1 ? 14 : 11, color: { argb: i === 0 ? 'FF1D6FEB' : 'FF0D1B2A' } }; });
  ws.addRow([]);
  const headerRow = ws.addRow(cols.map((c) => c.label));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D6FEB' } }; cell.alignment = { vertical: 'middle' }; });
  const first = headerRow.number + 1;
  for (const r of result.rows) {
    ws.addRow(cols.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined || v === '') return null;
      if (isNum(c)) return Number(v);
      if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return new Date(`${v}T00:00:00Z`);
      return String(v);
    }));
  }
  const last = ws.lastRow.number;
  if (Object.keys(result.totals || {}).length && result.rows.length) {
    const t = ws.addRow(cols.map((c, i) => {
      if (i === 0 && !(c.key in result.totals)) return 'Total';
      if (!(c.key in result.totals)) return null;
      const L = ws.getColumn(i + 1).letter;
      // A formula, so a row edited in Excel still adds up; the server's total is the cached value.
      return result.truncated ? result.totals[c.key] : { formula: `SUM(${L}${first}:${L}${last})`, result: result.totals[c.key] };
    }));
    t.font = { bold: true };
    t.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
  }
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'money') col.numFmt = '[$₹-4009] #,##,##0.00';
    else if (c.type === 'number') col.numFmt = '#,##,##0.###';
    else if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
    const widest = Math.max(c.label.length, ...result.rows.slice(0, 500).map((r) => fmt(r[c.key], c.type).length));
    col.width = Math.min(Math.max(widest + 2, 10), 60);
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow.number }];
  ws.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number, column: cols.length } };
  if (result.truncated) ws.addRow([`Showing ${result.rows.length} of ${result.rowCount} rows — narrow the filters for the rest.`]).font = { italic: true, color: { argb: 'FF5A6A85' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(result, meta = {}) {
  const cols = result.columns;
  const landscape = cols.length > 5;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let REG = 'Helvetica'; let BOLD = 'Helvetica-Bold';
    try {
      doc.registerFont('EngBody', path.join(__dirname, '../../utils/fonts/DejaVuSans.ttf'));
      doc.registerFont('EngBold', path.join(__dirname, '../../utils/fonts/DejaVuSans-Bold.ttf'));
      REG = 'EngBody'; BOLD = 'EngBold';
    } catch { /* built-in fonts */ }
    const brand = meta.accent && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(meta.accent) ? meta.accent : BRAND;
    const left = doc.page.margins.left;
    const W = doc.page.width - left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Widths: text columns share what the numbers leave, by how wide their text runs.
    const sample = result.rows.slice(0, 300);
    const want = cols.map((c) => {
      const len = Math.max(c.label.length, ...sample.map((r) => fmt(r[c.key], c.type).length), 4);
      return isNum(c) || c.type === 'date' ? Math.min(len, 16) : Math.min(len, 40);
    });
    const sum = want.reduce((a, b) => a + b, 0);
    const widths = want.map((w) => (w / sum) * W);
    const xAt = (i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0);
    const cut = (text, width, font, size) => {
      doc.font(font).fontSize(size);
      let t = String(text);
      if (doc.widthOfString(t) <= width) return t;
      while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
      return `${t}…`;
    };

    let y = doc.page.margins.top;
    const header = () => {
      doc.fillColor(brand).font(BOLD).fontSize(13).text(meta.company || '', left, y, { width: W });
      y += 18;
      doc.fillColor(INK).font(BOLD).fontSize(15).text(meta.title || 'Report', left, y, { width: W });
      y += 20;
      const sub = [meta.rangeLabel, meta.filterLine].filter(Boolean).join(' · ');
      if (sub) { doc.fillColor(MUTE).font(REG).fontSize(9).text(sub, left, y, { width: W }); y += doc.heightOfString(sub, { width: W }) + 4; }
      y += 6;
    };
    const tableHead = () => {
      doc.rect(left, y, W, 18).fill(brand);
      cols.forEach((c, i) => doc.fillColor('#FFFFFF').font(BOLD).fontSize(8).text(cut(c.label, widths[i] - 8, BOLD, 8), xAt(i) + 4, y + 5, { width: widths[i] - 8, align: isNum(c) ? 'right' : 'left', lineBreak: false }));
      y += 18;
    };
    const newPage = () => { doc.addPage(); y = doc.page.margins.top; tableHead(); };

    header();
    tableHead();
    if (!result.rows.length) {
      doc.fillColor(MUTE).font(REG).fontSize(10).text('Nothing matches for this period and these filters.', left, y + 14, { width: W, align: 'center' });
    }
    result.rows.forEach((r, n) => {
      if (y + 16 > bottom) newPage();
      if (n % 2) doc.rect(left, y, W, 16).fill(STRIPE);
      cols.forEach((c, i) => {
        const cell = fmt(r[c.key], c.type);
        // A name in Tamil or Hindi: this sheet's font has neither, and
        // printed a row of empty boxes (utils/pdfScripts.js).
        if (!isNum(c) && hasOtherScript(cell)) {
          drawLine(doc, cell, xAt(i) + 4, y + 4, { latinFont: REG, clean: (t) => t, size: 8, width: widths[i] - 8, color: INK });
          return;
        }
        doc.fillColor(INK).font(REG).fontSize(8).text(cut(cell, widths[i] - 8, REG, 8), xAt(i) + 4, y + 4, { width: widths[i] - 8, align: isNum(c) ? 'right' : 'left', lineBreak: false });
      });
      y += 16;
    });
    if (result.rows.length && Object.keys(result.totals || {}).length) {
      if (y + 20 > bottom) newPage();
      doc.moveTo(left, y).lineTo(left + W, y).strokeColor(LINE).stroke();
      cols.forEach((c, i) => {
        const v = c.key in result.totals ? fmt(result.totals[c.key], c.type) : i === 0 ? 'Total' : '';
        doc.fillColor(INK).font(BOLD).fontSize(8).text(cut(v, widths[i] - 8, BOLD, 8), xAt(i) + 4, y + 5, { width: widths[i] - 8, align: isNum(c) ? 'right' : 'left', lineBreak: false });
      });
      y += 20;
    }
    if (result.truncated) {
      if (y + 16 > bottom) newPage();
      doc.fillColor(MUTE).font(REG).fontSize(8).text(`Showing ${result.rows.length} of ${result.rowCount} rows — narrow the filters for the rest. Totals are over all ${result.rowCount}.`, left, y + 4, { width: W });
    }
    const range = doc.bufferedPageRange();
    const printed = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      // Written inside the bottom margin: lift it for the footer, or pdfkit starts a blank page.
      const keep = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      const fy = doc.page.height - keep + 10;
      doc.fillColor(MUTE).font(REG).fontSize(7).text(`Printed ${printed}`, left, fy, { width: W / 2, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

function toCsv(result) {
  return csvOf(result.columns.map((c) => ({ key: c.key, header: c.label })), result.rows);
}

module.exports = { toXlsx, toPdf, toCsv, fmt };

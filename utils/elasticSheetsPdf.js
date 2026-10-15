'use strict';
//
// ELASTIC SPEC SHEETS AND PRICE LIST — for sending to a customer.
//
// Pure over plain objects prepared by api/elastic.js, so they are
// unit-testable without a database. Same monochrome ruled form as the
// challan and the ledger (utils/sapForm.js).
//
//   buildElasticSpecPdf({ branding, elastics })   one page per elastic
//   buildElasticPriceListPdf({ branding, rows, customerName, gstPercent,
//                              validTill, date })  one table
//
// Neither prints a cost. The spec sheet is what the product IS; the
// price list prints the rate it is offered at, worked out by the route.

const PDFDocument = require('pdfkit');
const { INK, MUTED, RULE, HEADER_BG, boxLabel, boxValue, box, titleBox } = require('./sapForm');

const _num = (v, dp = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: dp });
};
const _money = (v) => {
  const n = Number(v);
  // "Rs." not the rupee sign: the built-in Helvetica has no glyph for it
  // and prints "¹" (see utils/orderPnlPdf.js).
  return Number.isFinite(n) ? `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
};
const _date = (d) => {
  const dt = d ? new Date(d) : new Date();
  return Number.isNaN(dt.getTime()) ? '—'
    : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

function _buffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function _letterhead(doc, brand, title, subtitle) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
    .text(brand.company || 'Balu Elastics', left, 40, { width: 300, lineBreak: false });
  const sub = [brand.addressLines?.join(', '), brand.gstin && `GSTIN ${brand.gstin}`, brand.phone]
    .filter(Boolean).join(' · ');
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text(sub || subtitle || '', left, 58, { width: 320, lineBreak: false });
  titleBox(doc, title, right - 175, 38, 175);
  doc.strokeColor(INK).lineWidth(1.2).moveTo(left, 80).lineTo(right, 80).stroke();
  return 92;
}

/** Label / value rows inside one ruled box, two columns. */
function _fieldGrid(doc, x, y, w, fields) {
  const colW = w / 2;
  const rowH = 26;
  const rows = Math.ceil(fields.length / 2);
  box(doc, x, y, w, rows * rowH);
  fields.forEach((f, i) => {
    const cx = x + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * rowH;
    if (i % 2 === 1) doc.moveTo(cx, cy).lineTo(cx, cy + rowH).lineWidth(0.6).strokeColor(RULE).stroke();
    if (i >= 2 && i % 2 === 0) doc.moveTo(x, cy).lineTo(x + w, cy).lineWidth(0.6).strokeColor(RULE).stroke();
    boxLabel(doc, f.label, cx + 6, cy + 4, colW - 12);
    boxValue(doc, f.value, cx + 6, cy + 13, colW - 12, { bold: true, fontSize: 9, lineBreak: false });
  });
  return y + rows * rowH;
}

/** A simple ruled table; returns the y below it. */
function _table(doc, x, y, w, columns, rows) {
  const headH = 18;
  const rowH = 17;
  doc.rect(x, y, w, headH).fill(HEADER_BG);
  box(doc, x, y, w, headH + rows.length * rowH);
  let cx = x;
  for (const c of columns) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text(c.label.toUpperCase(), cx + 5, y + 6, { width: c.w - 10, align: c.align || 'left', lineBreak: false });
    cx += c.w;
  }
  rows.forEach((r, i) => {
    const ry = y + headH + i * rowH;
    doc.moveTo(x, ry).lineTo(x + w, ry).lineWidth(0.4).strokeColor(RULE).stroke();
    let rx = x;
    columns.forEach((c, j) => {
      doc.font(j === 0 || c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK)
        .text(String(r[j] ?? ''), rx + 5, ry + 5, { width: c.w - 10, align: c.align || 'left', lineBreak: false, ellipsis: true });
      rx += c.w;
    });
  });
  let vx = x;
  for (const c of columns.slice(0, -1)) {
    vx += c.w;
    doc.moveTo(vx, y).lineTo(vx, y + headH + rows.length * rowH).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  return y + headH + rows.length * rowH;
}

async function buildElasticSpecPdf({ branding = {}, elastics = [] } = {}) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 60, left: 42, right: 42 } });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  elastics.forEach((e, idx) => {
    if (idx > 0) doc.addPage();
    let y = _letterhead(doc, branding, 'SPECIFICATION', 'Elastic specification');

    box(doc, left, y, width, 34);
    boxLabel(doc, 'Elastic', left + 6, y + 5, width - 12);
    boxValue(doc, e.name || '—', left + 6, y + 15, width - 12, { bold: true, fontSize: 12, lineBreak: false });
    y += 44;

    const t = e.testingParameters || {};
    y = _fieldGrid(doc, left, y, width, [
      { label: 'Weave type', value: e.weaveType || '—' },
      { label: 'Width (mm)', value: _num(t.width) },
      { label: 'Weight (g/m)', value: _num(e.weight, 3) },
      { label: 'Pick', value: _num(e.pick) },
      { label: 'Hooks', value: _num(e.noOfHook, 0) },
      { label: 'Spandex ends', value: _num(e.spandexEnds, 0) },
      { label: 'Yarn ends', value: _num(e.yarnEnds, 0) },
      { label: 'Elongation (%)', value: _num(t.elongation) },
      { label: 'Recovery (%)', value: _num(t.recovery) },
      { label: 'Stretch', value: t.strech || '—' },
    ]) + 14;

    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('COMPOSITION', left, y);
    y += 12;
    const comp = (e.composition || []).map((c) => [c.role, c.material, _num(c.weight, 3)]);
    y = _table(doc, left, y, width, [
      { label: 'Part', w: width * 0.3 },
      { label: 'Material', w: width * 0.5 },
      { label: 'g / m', w: width * 0.2, align: 'right' },
    ], comp.length ? comp : [['—', 'No composition recorded', '']]);

    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`Issued ${_date()}. Specifications are nominal; tolerances as agreed per order.`, left, y + 12, { width });
  });
  if (!elastics.length) _letterhead(doc, branding, 'SPECIFICATION');
  return _buffer(doc);
}

async function buildElasticPriceListPdf({
  branding = {}, rows = [], customerName = '', gstPercent = null, validTill = null, date = null,
} = {}) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 60, left: 42, right: 42 } });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  let y = _letterhead(doc, branding, 'PRICE LIST', 'Price list');

  y = _fieldGrid(doc, left, y, width, [
    { label: 'For', value: customerName || 'All customers' },
    { label: 'Date', value: _date(date) },
    { label: 'Valid till', value: validTill ? _date(validTill) : '—' },
    { label: 'Taxes', value: gstPercent != null ? `Rates exclude GST @ ${gstPercent}%` : 'Rates exclude GST' },
  ]) + 14;

  const bottom = doc.page.height - doc.page.margins.bottom;
  const columns = [
    { label: '#', w: width * 0.06, align: 'right' },
    { label: 'Elastic', w: width * 0.44 },
    { label: 'Width (mm)', w: width * 0.14, align: 'right' },
    { label: 'Weight (g/m)', w: width * 0.16, align: 'right' },
    { label: 'Rate / metre', w: width * 0.2, align: 'right', bold: true },
  ];
  // Split across pages so a long list never runs off the bottom.
  const perPage = Math.max(1, Math.floor((bottom - y - 40) / 17));
  for (let i = 0; i < rows.length; i += perPage) {
    if (i > 0) { doc.addPage(); y = _letterhead(doc, branding, 'PRICE LIST'); }
    const slice = rows.slice(i, i + perPage).map((r, j) => [
      i + j + 1, r.name, _num(r.width), _num(r.weight, 3), _money(r.rate),
    ]);
    y = _table(doc, left, y, width, columns, slice);
  }
  if (!rows.length) y = _table(doc, left, y, width, columns, [['', 'No elastics', '', '', '']]);
  doc.font('Helvetica').fontSize(7).fillColor(MUTED)
    .text('Rates per metre, ex-works. Quantities, delivery and payment terms as agreed per order.', left, y + 12, { width });
  return _buffer(doc);
}

module.exports = { buildElasticSpecPdf, buildElasticPriceListPdf };

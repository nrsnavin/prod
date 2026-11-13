'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICE (PDF)
//
//  One ruled sheet, the way a neat spreadsheet looks: every cell has a
//  thin border, header rows are lightly shaded, item rows are banded,
//  and the figures sit right-aligned in digits of equal width. Top to
//  bottom:
//
//    the title, across the sheet
//    the letterhead: the logo left, the company centred, and once the
//      invoice is registered, the portal's signed QR right
//    the particulars: number, date, due date, P.O., challans, order,
//      place of supply, reverse charge, the tax, the boxes (an export
//      adds the LUT, currency, port and shipping bill)
//    the IRN and acknowledgement, once registered
//    Bill To / Ship To
//    the lines: HSN, boxes, quantity, rate, taxable value, the CGST and
//      SGST (or IGST) rate and amount, and the line's total, with a
//      totals row that sums each column
//    the amount in words beside the tax totals and the grand total
//    the HSN/SAC summary the auditor reads
//    the notes and the declaration
//    the bank with a scan-to-pay QR, then two places to sign: the
//      receiver's (with their seal) and ours
//
//  An invoice of a dozen lines goes on one A4 sheet: it is laid out at
//  the normal spacing first, and if that runs past a page, again at a
//  compact one, which is kept when it fits on a single page. A longer
//  invoice carries on over pages at the normal spacing; each new page
//  repeats the title (marked "continued") and the table's header, and
//  the end of the invoice moves over as one piece, so the signatures
//  never sit on a page of their own.
//
//  A credit or debit note brings its own title and particulars
//  (services/noteDocument.js). A cancelled one is stamped across every
//  page.
//
//  Pure: buildInvoicePdf({ invoice, branding, settings }) → Buffer.
//  Rendered in a worker (utils/renderPdf.js). Set in Carlito, Calibri's
//  metric twin (narrow enough for a dozen columns, with the rupee sign
//  and tabular digits); DejaVu Sans if it cannot be loaded; Helvetica
//  and "Rs." if neither can.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { stateName } = require('../services/gst');

// ── A light spreadsheet ──────────────────────────────────────────
const INK = '#1E2A36';
const MUTED = '#5C6B7A';
const ACCENT = '#1F4E79'; // the title, the company, section labels
const GRID = '#C3CCD6';   // every cell's border
const FRAME = '#8593A1';  // the sheet's outer border
const HEAD = '#E6EDF5';   // header rows
const LABEL = '#F3F6F9';  // label cells
const BAND = '#F4F7FB';   // every other item row
const TOTAL = '#DCE6F1';  // the grand total
const ALERT = '#A02020';

// The two spacings. Sizes in points.
const DENSITY = {
  normal: {
    title: 26, titleSize: 14, nameSize: 16, headPad: 14, headMin: 58, logoBox: 72, qr: 80,
    row: 15.5, partyHead: 16, partyPad: 10, partyName: 10,
    tier: 12.5, item: 16, itemPad: 6, sumRow: 15, grand: 20, hsnRow: 15,
    upi: 52, sigBox: 32, text: 8.5, body: 8.5, head: 8, label: 8,
  },
  compact: {
    title: 22, titleSize: 13, nameSize: 14.5, headPad: 9, headMin: 50, logoBox: 60, qr: 74,
    row: 13.5, partyHead: 14, partyPad: 6, partyName: 9.5,
    tier: 11, item: 13.5, itemPad: 4, sumRow: 13, grand: 17, hsnRow: 13,
    upi: 46, sigBox: 24, text: 8, body: 8, head: 7.5, label: 7.5,
  },
};

const FONT_DIR = path.join(__dirname, 'fonts');
const FACES = [
  { regular: 'Carlito-Regular.ttf', bold: 'Carlito-Bold.ttf', tnum: true },
  { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf', tnum: false },
];

const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const pct = (n) => `${Number(n) || 0}%`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const ddmmyyyy = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()}`;
};
const when = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${ddmmyyyy(t)} ${p(t.getHours())}:${p(t.getMinutes())}`;
};
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

async function buildInvoicePdf({ invoice, branding = {}, settings = {} } = {}) {
  const inv = invoice || {};
  const t = inv.totals || {};
  const bank = (settings.invoice || {}).bank || {};
  const company = inv.seller?.name || branding.company || 'Balu Elastics';
  const registered = inv.einvoice?.status === 'registered' && inv.einvoice?.irn;
  // The QR codes, made once for both layouts.
  const qrs = {
    signed: registered && inv.einvoice.signedQr
      ? await QRCode.toBuffer(String(inv.einvoice.signedQr), { margin: 0, width: 480, errorCorrectionLevel: 'M' })
      : null,
    // A credit note, or a note we send a supplier, asks for no payment; a
    // buyer abroad cannot pay by UPI.
    upi: bank.upiId && !inv.hideUpi && inv.supplyType !== 'export'
      ? await QRCode.toBuffer(
          `upi://pay?pa=${encodeURIComponent(bank.upiId)}&pn=${encodeURIComponent(company.slice(0, 40))}` +
          `&am=${(Number(t.grand) || 0).toFixed(2)}&cu=INR&tn=${encodeURIComponent(String(inv.invoiceNumber || 'Invoice').slice(0, 40))}`,
          { margin: 0, width: 300, errorCorrectionLevel: 'M' })
      : null,
  };
  const normal = render({ inv, branding, settings, qrs, D: DENSITY.normal });
  if (normal.pages > 1) {
    const compact = render({ inv, branding, settings, qrs, D: DENSITY.compact });
    if (compact.pages === 1) return compact.done;
  }
  return normal.done;
}

/** One layout of the invoice at spacing D: { pages, done → Buffer }. */
function render({ inv, branding, settings, qrs, D }) {
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  // IGST (or nothing, zero-rated) on anything that is not an in-state sale.
  const inter = inv.supplyType !== 'intra';
  const exp = inv.export?.kind ? inv.export : null;
  const exportSupply = require('../services/exportSupply');
  const zero = exportSupply.isZeroRated(exp);
  const cancelled = inv.status === 'cancelled';
  const registered = inv.einvoice?.status === 'registered' && inv.einvoice?.irn;
  const invSettings = settings.invoice || {};
  const bank = invSettings.bank || {};
  const seller = inv.seller || {};
  const buyer = inv.buyer || {};
  const t = inv.totals || {};
  const company = seller.name || branding.company || 'Balu Elastics';
  const title = inv.docTitle || 'TAX INVOICE';

  const M = 28;
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 12 }, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // ── Fonts ─────────────────────────────────────────────────────
  let F = 'Helvetica';
  let FB = 'Helvetica-Bold';
  let RS = 'Rs. ';
  let tnum = false;
  for (const face of FACES) {
    const reg = path.join(FONT_DIR, face.regular);
    const bold = path.join(FONT_DIR, face.bold);
    try {
      if (!fs.existsSync(reg) || !fs.existsSync(bold)) continue;
      const name = face.regular.replace(/\W/g, '');
      doc.registerFont(`${name}R`, reg);
      doc.registerFont(`${name}B`, bold);
      // Load both now: a file that will not parse falls through to the next face.
      doc.font(`${name}R`);
      doc.font(`${name}B`);
      F = `${name}R`; FB = `${name}B`; RS = '₹'; tnum = face.tnum;
      break;
    } catch { /* the next face */ }
  }

  const L = M;
  const W = doc.page.width - M * 2;
  const R = L + W;
  const BOTTOM = doc.page.height - 32; // the sheet stops here; the page line sits below
  const PAD = 5;
  const TP = 4; // inside the item table's cells
  let y = M;

  const setFont = (bold, size) => doc.font(bold ? FB : F).fontSize(size);
  const features = (num) => (num && tnum ? { features: ['tnum'] } : {});
  const lh = (size = D.text, bold = false) => { setFont(bold, size); return doc.currentLineHeight(); };
  const hOf = (s, w, size = D.text, bold = false) => { setFont(bold, size); return doc.heightOfString(String(s ?? ''), { width: w }); };
  const wOf = (s, size = D.text, bold = false, num = false) => { setFont(bold, size); return doc.widthOfString(String(s ?? ''), features(num)); };
  /**
   * Text in a cell. One line unless `wrap`: a single line is held to its
   * height, so a value too long for its cell ends in "…" rather than
   * spilling into the row below (or opening a page of its own).
   */
  const txt = (s, x, yy, o = {}) => {
    const size = o.size || D.text;
    setFont(o.bold, size);
    doc.fillColor(o.color || INK).text(String(s ?? ''), x, yy, {
      width: o.width,
      align: o.align || 'left',
      characterSpacing: o.spacing || 0,
      ...(o.wrap ? {} : { height: lh(size, o.bold) + 1, ellipsis: true }),
      ...features(o.num),
    });
  };
  // Where one line of text sits to look centred in a cell of height h.
  const mid = (yy, h, size = D.text, bold = false) => yy + (h - lh(size, bold)) / 2 + 0.6;

  const fillRect = (x, yy, w, h, color) => { doc.save(); doc.rect(x, yy, w, h).fillColor(color).fill(); doc.restore(); };
  const strokeRect = (x, yy, w, h, color = GRID, lw = 0.5) => { doc.save(); doc.rect(x, yy, w, h).lineWidth(lw).strokeColor(color).stroke(); doc.restore(); };
  const rule = (x1, y1, x2, y2, color = GRID, lw = 0.5) => { doc.save(); doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(lw).strokeColor(color).stroke(); doc.restore(); };
  const cell = (x, yy, w, h, fill) => { if (fill) fillRect(x, yy, w, h, fill); strokeRect(x, yy, w, h); };
  // A label cell and its value cell, as one row of a form.
  const pair = (x, yy, labW, valW, h, label, value, o = {}) => {
    cell(x, yy, labW, h, LABEL);
    cell(x + labW, yy, valW, h);
    txt(label, x + PAD, mid(yy, h, D.label), { size: D.label, color: MUTED, width: labW - 2 * PAD });
    const size = o.size || D.text;
    if (o.wrap) {
      const vh = hOf(value, valW - 2 * PAD, size, true);
      txt(value, x + labW + PAD, yy + (h - vh) / 2 + 0.6, { bold: true, size, width: valW - 2 * PAD, wrap: true });
    } else {
      txt(value, x + labW + PAD, mid(yy, h, size, true), { bold: true, size, width: valW - 2 * PAD, align: o.align, num: o.num });
    }
  };

  // ── Pages: one framed sheet each ──────────────────────────────
  let frameTop = y;
  const closeFrame = () => { if (y > frameTop) strokeRect(L, frameTop, W, y - frameTop, FRAME, 0.9); };
  const titleBand = (continued) => {
    const h = continued ? 20 : D.title;
    const size = continued ? 10 : D.titleSize;
    cell(L, y, W, h, HEAD);
    const label = continued ? `${title}  ·  ${inv.invoiceNumber || ''}  ·  continued` : title;
    txt(label, L, mid(y, h, size, true), { bold: true, size, color: ACCENT, width: W, align: 'center', spacing: continued ? 0.5 : 2 });
    if (cancelled) txt('CANCELLED', L + PAD, mid(y, h, 9, true), { bold: true, size: 9, color: ALERT, width: W - 2 * PAD, align: 'right', spacing: 0.8 });
    y += h;
  };
  const newPage = () => { closeFrame(); doc.addPage(); y = M; frameTop = y; titleBand(true); };
  const room = (h) => y + h <= BOTTOM;

  let logo = null;
  if (branding.logo) {
    try { logo = doc.openImage(branding.logo); } catch { logo = null; } // a bad logo never blocks an invoice
  }

  titleBand(false);

  // ── Letterhead ────────────────────────────────────────────────
  {
    const qrSize = D.qr;
    // The same width each side, so the company stays centred on the sheet.
    const side = logo || qrs.signed ? 100 : 0;
    const cx = L + side + PAD;
    const cw = W - side * 2 - PAD * 2;
    const addressLines = Array.isArray(branding.addressLines) && branding.addressLines.length
      ? branding.addressLines.filter(Boolean)
      : (seller.address ? [seller.address] : []);
    const cityPart = [[seller.city, seller.stateCode ? stateName(seller.stateCode) : ''].filter(Boolean).join(', '), seller.pincode].filter(Boolean).join(' - ');
    const rows = [
      [[...addressLines, cityPart].filter(Boolean).join(', '), false, INK],
      [[seller.gstin && `GSTIN: ${seller.gstin}`, seller.stateCode && `State Code: ${seller.stateCode}`].filter(Boolean).join('     '), true, INK],
      [[seller.phone && `Phone: ${seller.phone}`, seller.email && `Email: ${seller.email}`].filter(Boolean).join('     '), false, MUTED],
    ].filter(([s]) => s);
    const nameH = hOf(company, cw, D.nameSize, true);
    const rowsH = rows.reduce((a, [s, b]) => a + hOf(s, cw, D.text, b) + 1.5, 0);
    const contentH = nameH + 3 + rowsH;
    const h = Math.max(contentH + D.headPad, qrs.signed ? qrSize + 20 : 0, logo ? D.logoBox : 0, D.headMin);
    cell(L, y, W, h);
    if (logo) {
      const fitH = Math.min(60, h - 14);
      doc.image(logo, L + 10, y + (h - fitH) / 2, { fit: [side - 20, fitH], align: 'center', valign: 'center' });
    }
    let cy = y + (h - contentH) / 2 + 1;
    txt(company, cx, cy, { bold: true, size: D.nameSize, color: ACCENT, width: cw, align: 'center', wrap: true });
    cy += nameH + 3;
    for (const [s, b, color] of rows) {
      txt(s, cx, cy, { bold: b, size: D.text, color, width: cw, align: 'center', wrap: true });
      cy += hOf(s, cw, D.text, b) + 1.5;
    }
    if (qrs.signed) {
      const qx = R - side + (side - qrSize) / 2;
      const qy = y + (h - qrSize - 11) / 2;
      doc.image(qrs.signed, qx, qy, { width: qrSize, height: qrSize });
      txt('e-Invoice QR', R - side, qy + qrSize + 2, { size: 7, color: MUTED, width: side, align: 'center' });
    }
    y += h;
  }

  // ── Particulars ───────────────────────────────────────────────
  const half = W / 2;
  const labW = 96;
  const valW = half - labW;
  // Short enough for its cell; the LUT number gets a row of its own.
  const taxLabel = zero ? 'Zero-rated under LUT, no IGST'
    : inv.supplyType === 'export' ? 'IGST (export, with payment)' : inv.supplyType === 'sez' ? 'IGST (SEZ, with payment)'
    : inter ? `IGST (inter-state)${exp?.kind === 'DEXP' ? ', deemed export' : ''}` : `CGST + SGST (intra-state)${exp?.kind === 'DEXP' ? ', deemed export' : ''}`;
  // A credit or debit note brings its own rows (the invoice it is against).
  const leftRows = inv.detailRows?.left || [
    ['Invoice No.', inv.invoiceNumber || '—'],
    ['Invoice Date', ddmmyyyy(inv.invoiceDate)],
    ['Due Date', ddmmyyyy(inv.dueDate)],
    ['Customer P.O. No.', inv.customerPo || '—'],
    ['Delivery Challan', (inv.dcs || []).map((d) => d.dcNumber).join(', ') || '—'],
  ];
  const rightRows = inv.detailRows?.right || [
    ['Place of Supply', inv.supplyType === 'export' ? `Other Country (96)${exp?.countryCode ? ` — ${exp.countryCode}` : ''}` : inv.placeOfSupply ? `${stateName(inv.placeOfSupply)} (${inv.placeOfSupply})` : '—'],
    ['Reverse Charge', 'No'],
    ['Tax', taxLabel],
    ['Order No.', inv.orderNo != null ? `#${inv.orderNo}` : '—'],
    ['Total Boxes', Number(inv.totalBoxes) > 0 ? String(inv.totalBoxes) : '—'],
    ...(zero && exp?.lut?.number ? [['LUT No.', exp.lut.number]] : []),
    ...(inv.supplyType === 'export' ? [
      ['Currency', exp?.currency && exp.currency !== 'INR' ? `${exp.currency} @ ₹${exp.exchangeRate} · ${exp.currency} ${(exportSupply.fxValue(exp, inv.totals?.grand) ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'INR'],
      ['Port / Ship. bill', [exp?.portCode, exp?.shippingBill?.number ? `${exp.shippingBill.number}${exp.shippingBill.date ? ` dt ${ddmmyyyy(exp.shippingBill.date)}` : ''}` : ''].filter(Boolean).join(' · ') || '—'],
    ] : []),
  ];
  // A note's rows, in the invoice's words.
  const SAME = { 'Place Of Supply': 'Place of Supply', Order: 'Order No.' };
  const relabel = (k) => (k === '#' ? `${titleCase(title)} No.` : SAME[k] || k);
  for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
    const a = leftRows[i];
    const b = rightRows[i];
    const need = (row) => (row ? hOf(row[1], valW - 2 * PAD, D.text, true) + 6 : 0);
    const h = Math.max(D.row, need(a), need(b));
    for (const [row, x] of [[a, L], [b, L + half]]) {
      if (row) pair(x, y, labW, valW, h, relabel(row[0]), row[1], { wrap: true });
      else cell(x, y, half, h);
    }
    y += h;
  }

  // ── e-Invoice particulars ─────────────────────────────────────
  if (registered) {
    const h = D.row;
    pair(L, y, labW, W - labW, h, 'IRN', inv.einvoice.irn);
    y += h;
    pair(L, y, labW, valW, h, 'Ack No.', inv.einvoice.ackNo || '—');
    pair(L + half, y, labW, valW, h, 'Ack Date', when(inv.einvoice.ackDate));
    y += h;
  }

  // ── Bill To / Ship To ─────────────────────────────────────────
  {
    const headH = D.partyHead;
    cell(L, y, half, headH, HEAD);
    cell(L + half, y, half, headH, HEAD);
    txt('Bill To', L + PAD, mid(y, headH, D.text, true), { bold: true, size: D.text, color: ACCENT, width: half - 2 * PAD });
    txt('Ship To', L + half + PAD, mid(y, headH, D.text, true), { bold: true, size: D.text, color: ACCENT, width: half - 2 * PAD });
    y += headH;
    const pw = half - 2 * PAD;
    const name = buyer.name || '—';
    const bill = [
      [buyer.address, false],
      [[buyer.city, buyer.pincode].filter(Boolean).join(' - '), false],
      [buyer.stateCode ? `State: ${stateName(buyer.stateCode)} (${buyer.stateCode})` : exp?.countryCode ? `Country: ${exp.countryCode}` : '', false],
      [buyer.gstin ? `GSTIN: ${buyer.gstin}` : '', true],
    ].filter(([s]) => s);
    const ship = inv.shipTo || [buyer.address, [buyer.city, buyer.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', ');
    const nameH = hOf(name, pw, D.partyName, true);
    const billH = nameH + 2 + bill.reduce((a, [s, b]) => a + hOf(s, pw, D.text, b) + 1, 0);
    const shipH = nameH + 2 + hOf(ship || '—', pw, D.text);
    const h = Math.max(billH, shipH) + D.partyPad;
    const top = y + D.partyPad / 2;
    cell(L, y, half, h);
    cell(L + half, y, half, h);
    let by = top;
    txt(name, L + PAD, by, { bold: true, size: D.partyName, width: pw, wrap: true });
    by += nameH + 2;
    for (const [s, b] of bill) { txt(s, L + PAD, by, { bold: b, size: D.text, width: pw, wrap: true }); by += hOf(s, pw, D.text, b) + 1; }
    txt(name, L + half + PAD, top, { bold: true, size: D.partyName, width: pw, wrap: true });
    txt(ship || '—', L + half + PAD, top + nameH + 2, { size: D.text, width: pw, wrap: true });
    y += h;
  }

  // ── Lines ─────────────────────────────────────────────────────
  const showBoxes = lines.some((l) => Number(l.boxes) > 0);
  const units = [...new Set(lines.map((l) => l.unit || ''))];
  const taxableOf = (l) => (l.taxable != null && l.taxable !== ''
    ? Number(l.taxable) || 0
    : r2((Number(l.amount) || 0) - (Number(l.cgst) || 0) - (Number(l.sgst) || 0) - (Number(l.igst) || 0)));
  const rowsData = lines.map((l, i) => ({
    sno: String(i + 1), desc: l.name || '—', hsn: l.hsn || '—', boxes: Number(l.boxes) > 0 ? String(l.boxes) : '',
    qty: `${qty(l.quantity)} ${l.unit || ''}`.trim(), rate: money(l.rate), taxable: money(taxableOf(l)),
    ipct: pct(l.gstPercent), iamt: money(l.igst),
    cpct: pct((Number(l.gstPercent) || 0) / 2), camt: money(l.cgst), spct: pct((Number(l.gstPercent) || 0) / 2), samt: money(l.sgst),
    total: money(l.amount),
  }));
  const sumOf = (k) => r2(lines.reduce((a, l) => a + (Number(l[k]) || 0), 0));
  const totalsRow = {
    desc: 'Total',
    boxes: showBoxes ? String(lines.reduce((a, l) => a + (Number(l.boxes) || 0), 0)) : '',
    qty: units.length === 1 ? `${qty(r3(lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0)))} ${units[0]}`.trim() : '',
    taxable: money(r2(lines.reduce((a, l) => a + taxableOf(l), 0))),
    iamt: money(sumOf('igst')), camt: money(sumOf('cgst')), samt: money(sumOf('sgst')),
    total: money(sumOf('amount')),
  };
  const cols = [
    { k: 'sno', h: ['#'], a: 'center', min: 18 },
    { k: 'desc', h: ['Item & Description'], a: 'left', flex: true },
    { k: 'hsn', h: ['HSN/SAC'], a: 'center', min: 40 },
    ...(showBoxes ? [{ k: 'boxes', h: ['Boxes'], a: 'right', num: true, min: 30 }] : []),
    { k: 'qty', h: ['Qty'], a: 'right', num: true, min: 44 },
    { k: 'rate', h: ['Rate'], a: 'right', num: true, min: 36 },
    { k: 'taxable', h: ['Taxable', 'Value'], a: 'right', num: true, min: 48 },
    ...(inter
      ? [{ k: 'ipct', h: ['%'], g: 'IGST', a: 'right', num: true, min: 28 }, { k: 'iamt', h: ['Amount'], g: 'IGST', a: 'right', num: true, min: 46 }]
      : [{ k: 'cpct', h: ['%'], g: 'CGST', a: 'right', num: true, min: 26 }, { k: 'camt', h: ['Amount'], g: 'CGST', a: 'right', num: true, min: 42 },
         { k: 'spct', h: ['%'], g: 'SGST', a: 'right', num: true, min: 26 }, { k: 'samt', h: ['Amount'], g: 'SGST', a: 'right', num: true, min: 42 }]),
    { k: 'total', h: ['Total'], a: 'right', num: true, min: 50 },
  ];
  const headSize = D.head;
  let bodySize = D.body;
  // Each column as wide as its widest entry, like a spreadsheet's autofit;
  // the description takes what is left.
  const fit = () => {
    for (const c of cols) {
      if (c.flex) continue;
      const head = Math.max(...c.h.map((s) => wOf(s, headSize, true)));
      const body = Math.max(0, ...rowsData.map((r) => wOf(r[c.k], bodySize, false, c.num)), wOf(totalsRow[c.k] || '', bodySize, true, c.num));
      c.w = Math.ceil(Math.max(c.min || 0, Math.max(head, body) + 2 * TP + 1));
    }
    for (const g of ['CGST', 'SGST', 'IGST']) {
      const gc = cols.filter((c) => c.g === g);
      if (!gc.length) continue;
      const need = wOf(g, headSize, true) + 2 * TP;
      const have = gc.reduce((a, c) => a + c.w, 0);
      if (have < need) gc[gc.length - 1].w += Math.ceil(need - have);
    }
    cols.find((c) => c.flex).w = W - cols.reduce((a, c) => a + (c.flex ? 0 : c.w), 0);
  };
  fit();
  while (cols.find((c) => c.flex).w < 120 && bodySize > 7.5) { bodySize -= 0.5; fit(); }
  const xs = [];
  cols.reduce((x, c) => { xs.push(x); return x + c.w; }, L);
  const descW = cols.find((c) => c.flex).w - 2 * TP;

  const tier = D.tier;
  const headH = tier * 2;
  const tableHeader = () => {
    fillRect(L, y, W, headH, HEAD);
    cols.forEach((c, i) => {
      const x = xs[i];
      if (c.g) {
        // The group's name over its two columns; the rule between them
        // runs through the lower tier only, never through the name.
        if (cols.findIndex((d) => d.g === c.g) === i) {
          const gw = cols.filter((d) => d.g === c.g).reduce((a, d) => a + d.w, 0);
          strokeRect(x, y, gw, tier);
          txt(c.g, x, mid(y, tier, headSize, true), { bold: true, size: headSize, width: gw, align: 'center' });
        }
        strokeRect(x, y + tier, c.w, tier);
        txt(c.h[0], x + TP, mid(y + tier, tier, headSize, true), { bold: true, size: headSize, width: c.w - 2 * TP, align: c.a });
      } else {
        strokeRect(x, y, c.w, headH);
        const lineH = lh(headSize, true);
        let ty = y + (headH - c.h.length * lineH) / 2 + 0.6;
        for (const s of c.h) { txt(s, x + TP, ty, { bold: true, size: headSize, width: c.w - 2 * TP, align: c.a }); ty += lineH; }
      }
    });
    y += headH;
  };
  // Rules are drawn once a page's rows are down, over the bands, so a
  // shaded row never covers half of the line above it.
  let bodyTop = 0;
  let rowRules = [];
  const closeBody = () => {
    for (const ry of rowRules) rule(L, ry, R, ry);
    cols.forEach((c, i) => rule(xs[i], bodyTop, xs[i], y));
    rule(R, bodyTop, R, y);
    rowRules = [];
  };
  const continueTable = () => { closeBody(); newPage(); tableHeader(); bodyTop = y; };

  tableHeader();
  bodyTop = y;
  rowsData.forEach((r, i) => {
    const textH = hOf(r.desc, descW, bodySize);
    const h = Math.max(D.item, textH + D.itemPad);
    if (!room(h)) continueTable();
    if (i % 2 === 1) fillRect(L, y, W, h, BAND);
    cols.forEach((c, k) => {
      if (c.flex) txt(r.desc, xs[k] + TP, y + (h - textH) / 2 + 0.6, { size: bodySize, width: descW, wrap: true });
      else txt(r[c.k], xs[k] + TP, mid(y, h, bodySize), { size: bodySize, width: c.w - 2 * TP, align: c.a, num: c.num });
    });
    y += h;
    rowRules.push(y);
  });
  if (!lines.length) {
    txt('No lines.', L + PAD, mid(y, D.item), { color: MUTED, width: W - 2 * PAD });
    y += D.item;
    rowRules.push(y);
  }
  {
    const h = D.item;
    if (!room(h)) continueTable();
    fillRect(L, y, W, h, HEAD);
    cols.forEach((c, k) => {
      const v = totalsRow[c.k];
      if (v) txt(v, xs[k] + TP, mid(y, h, bodySize, true), { bold: true, size: bodySize, width: c.w - 2 * TP, align: c.flex ? 'right' : c.a, num: c.num });
    });
    y += h;
    rowRules.push(y);
  }
  closeBody();

  // ── The end of the invoice, kept together ────────────────────
  // The amount in words beside the totals, the HSN summary, the notes and
  // declaration, the bank and the two signatures (and a cancelled one's
  // reason). When they do not all fit under the table they start the
  // next page together, so the signatures never sit on a page alone.
  const blocks = [];

  // Amount in words | tax totals and the grand total.
  {
    const rates = [...new Set(lines.map((l) => Number(l.gstPercent) || 0))].sort((a, b) => a - b);
    const sumBy = (rate, k) => r2(lines.filter((l) => (Number(l.gstPercent) || 0) === rate).reduce((a, l) => a + (Number(l[k]) || 0), 0));
    const rows = [['Taxable Value', money(t.taxable)]];
    for (const rate of rates) {
      if (zero) rows.push(['IGST (zero-rated)', money(0)]);
      else if (inter) rows.push([`IGST @ ${rate}%`, money(sumBy(rate, 'igst'))]);
      else {
        rows.push([`CGST @ ${rate / 2}%`, money(sumBy(rate, 'cgst'))]);
        rows.push([`SGST @ ${rate / 2}%`, money(sumBy(rate, 'sgst'))]);
      }
    }
    if (Number(t.roundOff)) rows.push(['Round Off', money(t.roundOff)]);
    const totW = 228;
    const valT = 96;
    const labT = totW - valT;
    const lw = W - totW;
    const lpw = lw - 2 * PAD;
    const rowH = D.sumRow;
    const words = inv.amountInWords || '—';
    const wordsH = 11 + hOf(words, lpw, 9.5, true);
    const h = Math.max(rows.length * rowH + D.grand, wordsH + 12);
    blocks.push({ h, draw: () => {
      cell(L, y, lw, h);
      txt('Amount in Words', L + PAD, y + 5, { bold: true, size: D.label, color: ACCENT, width: lpw });
      txt(words, L + PAD, y + 16, { bold: true, size: 9.5, width: lpw, wrap: true });
      let ty = y;
      for (const [k, v] of rows) { pair(L + lw, ty, labT, valT, rowH, k, v, { align: 'right', num: true }); ty += rowH; }
      const gh = h - (ty - y);
      cell(L + lw, ty, labT, gh, TOTAL);
      cell(L + lw + labT, ty, valT, gh, TOTAL);
      txt('Grand Total', L + lw + PAD, mid(ty, gh, 10, true), { bold: true, size: 10, color: ACCENT, width: labT - 2 * PAD });
      txt(`${RS}${money(t.grand)}`, L + lw + labT + PAD, mid(ty, gh, 10.5, true), { bold: true, size: 10.5, width: valT - 2 * PAD, align: 'right', num: true });
      y += h;
    } });
  }

  // The HSN / SAC summary.
  {
    const groups = new Map();
    for (const l of lines) {
      const key = `${l.hsn || '—'}|${Number(l.gstPercent) || 0}`;
      const g = groups.get(key) || { hsn: l.hsn || '—', rate: Number(l.gstPercent) || 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      g.taxable += taxableOf(l); g.cgst += Number(l.cgst) || 0; g.sgst += Number(l.sgst) || 0; g.igst += Number(l.igst) || 0;
      groups.set(key, g);
    }
    const rows = [...groups.values()];
    const total = (k) => r2(rows.reduce((a, g) => a + g[k], 0));
    const sCols = inter
      ? [['HSN/SAC', 1.2, 'left'], ['Taxable Value', 1.4, 'right'], ['IGST %', 0.9, 'right'], ['IGST Amount', 1.3, 'right'], ['Total Tax', 1.3, 'right']]
      : [['HSN/SAC', 1.1, 'left'], ['Taxable Value', 1.3, 'right'], ['CGST %', 0.8, 'right'], ['CGST Amount', 1.2, 'right'], ['SGST %', 0.8, 'right'], ['SGST Amount', 1.2, 'right'], ['Total Tax', 1.3, 'right']];
    const unit = W / sCols.reduce((a, c) => a + c[1], 0);
    const sw = sCols.map((c) => c[1] * unit);
    const sx = sw.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + sw[i - 1] : L); return acc; }, []);
    const rowH = D.hsnRow;
    const size = D.label;
    blocks.push({ h: rowH * (rows.length + 3), draw: () => {
      cell(L, y, W, rowH, LABEL);
      txt('HSN/SAC Summary', L + PAD, mid(y, rowH, size, true), { bold: true, size, color: ACCENT, width: W - 2 * PAD });
      y += rowH;
      const drawRow = (cells, { fill, bold } = {}) => {
        cells.forEach((v, i) => {
          cell(sx[i], y, sw[i], rowH, fill);
          txt(v, sx[i] + PAD, mid(y, rowH, size, bold), { bold, size, width: sw[i] - 2 * PAD, align: sCols[i][2], num: i > 0 });
        });
        y += rowH;
      };
      drawRow(sCols.map((c) => c[0]), { fill: HEAD, bold: true });
      for (const g of rows) {
        drawRow(inter
          ? [g.hsn, money(g.taxable), pct(g.rate), money(g.igst), money(g.igst)]
          : [g.hsn, money(g.taxable), pct(g.rate / 2), money(g.cgst), pct(g.rate / 2), money(g.sgst), money(g.cgst + g.sgst)]);
      }
      drawRow(inter
        ? ['Total', money(total('taxable')), '', money(total('igst')), money(total('igst'))]
        : ['Total', money(total('taxable')), '', money(total('cgst')), '', money(total('sgst')), money(total('cgst') + total('sgst'))], { fill: HEAD, bold: true });
    } });
  }

  // Notes and the declaration, a form row each, across the sheet.
  {
    const declaration = [exportSupply.declaration(exp), invSettings.declaration].filter(Boolean).join('\n');
    const notes = String(inv.notes || '').trim();
    const tw = W - labW - 2 * PAD;
    for (const [label, text] of [['Notes', notes], ['Declaration', declaration]]) {
      if (!text) continue;
      const th = hOf(text, tw, 7.5);
      const h = Math.max(D.row, th + 6);
      blocks.push({ h, draw: () => {
        cell(L, y, labW, h, LABEL);
        cell(L + labW, y, W - labW, h);
        txt(label, L + PAD, mid(y, h, D.label), { size: D.label, color: MUTED, width: labW - 2 * PAD });
        txt(text, L + labW + PAD, y + (h - th) / 2 + 0.6, { size: 7.5, width: tw, wrap: true });
        y += h;
      } });
    }
  }

  // The bank, with a scan-to-pay code | the receiver's signature and
  // seal | ours. Each signature has a dashed box to sign (and stamp) in.
  {
    const sigW = 150;
    const bw = W - 2 * sigW;
    const qr = qrs.upi ? D.upi : 0;
    const textW = bw - 2 * PAD - (qr ? qr + 10 : 0);
    const bankRows = [
      ['Bank', [bank.name, bank.branch].filter(Boolean).join(', ')],
      ['A/c No.', bank.account],
      ['IFSC', bank.ifsc],
      ['UPI ID', bank.upiId],
    ].filter(([, v]) => v);
    const step = D.text + 3;
    const bankH = bankRows.length ? 5 + 11 + bankRows.length * step + 4 : 0;
    const qrH = qr ? 5 + qr + 10 + 4 : 0;
    const sigH = 5 + 10 + 3 + D.sigBox + 3 + 10 + 4;
    const h = Math.max(bankH, qrH, sigH);
    const goods = !inv.docTitle || inv.docTitle === 'TAX INVOICE';
    const place = (x, top, bottom, strong) => {
      if (top) txt(top, x + PAD, y + 5, { bold: strong, size: strong ? D.text : 7, color: strong ? INK : MUTED, width: sigW - 2 * PAD, align: 'center' });
      const boxTop = y + 5 + 10 + 3;
      const boxH = h - (boxTop - y) - (3 + 10 + 4);
      doc.save().rect(x + 12, boxTop, sigW - 24, boxH).dash(2, { space: 2 }).lineWidth(0.5).strokeColor(GRID).stroke().undash().restore();
      txt(bottom, x + PAD, y + h - 4 - 10, { size: D.label, color: MUTED, width: sigW - 2 * PAD, align: 'center' });
    };
    blocks.push({ h, draw: () => {
      cell(L, y, bw, h);
      cell(L + bw, y, sigW, h);
      cell(L + bw + sigW, y, sigW, h);
      if (bankRows.length) {
        let by = y + 5;
        txt('Bank Details', L + PAD, by, { bold: true, size: D.label, color: ACCENT, width: textW });
        by += 11;
        for (const [k, v] of bankRows) {
          txt(k, L + PAD, by, { size: D.label, color: MUTED, width: 44 });
          // A long bank name steps down a size before it is cut short.
          const vs = wOf(v, D.text, true) > textW - 44 ? D.text - 1 : D.text;
          txt(v, L + PAD + 44, by, { bold: true, size: vs, width: textW - 44 });
          by += step;
        }
      }
      if (qrs.upi) {
        const qx = L + bw - PAD - qr;
        const qy = y + (h - qr - 10) / 2;
        doc.image(qrs.upi, qx, qy, { width: qr, height: qr });
        txt('Scan to pay', qx - 6, qy + qr + 1, { size: 7, color: MUTED, width: qr + 12, align: 'center' });
      }
      place(L + bw, goods ? 'Received the above goods in good condition' : '', "Receiver's Signature & Seal", false);
      place(L + bw + sigW, `For ${company}`, 'Authorised Signatory', true);
      y += h;
    } });
  }

  if (cancelled) {
    const reason = `Cancelled${inv.cancel?.reason ? `: ${inv.cancel.reason}` : ''}`;
    const rh = hOf(reason, W - 2 * PAD, D.text, true);
    const h = Math.max(D.row, rh + 6);
    blocks.push({ h, draw: () => {
      cell(L, y, W, h);
      txt(reason, L + PAD, y + (h - rh) / 2 + 0.6, { bold: true, size: D.text, color: ALERT, width: W - 2 * PAD, wrap: true });
      y += h;
    } });
  }

  if (!room(blocks.reduce((a, b) => a + b.h, 0))) newPage();
  for (const b of blocks) {
    if (!room(b.h)) newPage();
    b.draw();
  }
  closeFrame();

  // ── Page line, the footer note, the cancelled stamp ──────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 26;
    txt(`${inv.invoiceNumber || ''}  ·  Page ${i - range.start + 1} of ${range.count}`, L, fy, { size: 7, color: MUTED, width: W, align: 'right' });
    if (branding.footerNote && i === range.start + range.count - 1) {
      txt(branding.footerNote, L, fy, { size: 7, color: MUTED, width: W - 150 });
    }
    if (cancelled) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font(FB).fontSize(72).fillColor(ALERT).opacity(0.1)
        .text('CANCELLED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
        .opacity(1).restore();
    }
  }

  doc.end();
  return { pages: range.count, done };
}

module.exports = { buildInvoicePdf };

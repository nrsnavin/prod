'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICE (PDF)
//
//  Laid out the way the company's invoices have always looked: the
//  letterhead with the logo top-left and TAX INVOICE top-right; the
//  invoice number, date, P.O., place of supply and box count in a
//  ruled grid; Bill To / Ship To; the lines with HSN, quantity, rate
//  and the CGST / SGST (or IGST) split per line; the total in words,
//  the notes and the bank with a scan-to-pay QR on the left, the
//  totals and the signature on the right; and the HSN summary the
//  auditor reads at the bottom.
//
//  An e-invoice adds what the portal requires on the print: the IRN,
//  the acknowledgement number and date, and the portal's signed QR,
//  top right under the title.
//
//  Pure: buildInvoicePdf({ invoice, branding, settings }) → Buffer.
//  Rendered in a worker (utils/renderPdf.js). The rupee sign needs a
//  font that has it — DejaVu Sans is bundled in utils/fonts; if it
//  cannot be loaded the sheet falls back to Helvetica and "Rs.".
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { stateName } = require('../services/gst');

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#8A8A8A';
const BAND = '#E9E9E9';
const ALERT = '#A02020';

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
};
const hasFonts = () => { try { return fs.existsSync(FONTS.regular) && fs.existsSync(FONTS.bold); } catch { return false; } };

const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const pct = (n) => `${Number(n) || 0}%`;
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

async function buildInvoicePdf({ invoice, branding = {}, settings = {} } = {}) {
  const inv = invoice || {};
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

  const doc = new PDFDocument({ size: 'A4', margin: 30, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // ── Fonts ─────────────────────────────────────────────────────
  let F = 'Helvetica';
  let FB = 'Helvetica-Bold';
  let RS = 'Rs.';
  if (hasFonts()) {
    try {
      doc.registerFont('Body', FONTS.regular);
      doc.registerFont('BodyBold', FONTS.bold);
      F = 'Body'; FB = 'BodyBold'; RS = '₹';
    } catch { /* Helvetica and "Rs." */ }
  }

  const L = 30;
  const W = doc.page.width - L * 2;
  const R = L + W;
  const bottom = doc.page.height - 40;
  let y = 30;
  const text = (s, x, yy, opts = {}) => {
    doc.font(opts.bold ? FB : F).fontSize(opts.size || 8.5).fillColor(opts.color || INK)
      .text(String(s ?? ''), x, yy, { lineBreak: opts.lineBreak ?? false, width: opts.width, align: opts.align || 'left', height: opts.height });
  };
  const hline = (yy, x1 = L, x2 = R, w = 0.6) => doc.moveTo(x1, yy).lineTo(x2, yy).lineWidth(w).strokeColor(RULE).stroke();
  const vline = (x, y1, y2, w = 0.6) => doc.moveTo(x, y1).lineTo(x, y2).lineWidth(w).strokeColor(RULE).stroke();
  const box = (x, yy, w, h) => doc.rect(x, yy, w, h).lineWidth(0.6).strokeColor(RULE).stroke();
  const band = (x, yy, w, h) => { doc.rect(x, yy, w, h).fillColor(BAND).fill(); doc.rect(x, yy, w, h).lineWidth(0.6).strokeColor(RULE).stroke(); };
  const newPage = () => { doc.addPage(); y = 30; };

  // ── QRs, made before drawing ──────────────────────────────────
  const signedQr = registered && inv.einvoice.signedQr
    ? await QRCode.toBuffer(String(inv.einvoice.signedQr), { margin: 0, width: 400, errorCorrectionLevel: 'M' })
    : null;
  // A credit note, or a note we send a supplier, asks for no payment.
  const upi = bank.upiId && !inv.hideUpi
    ? await QRCode.toBuffer(
        `upi://pay?pa=${encodeURIComponent(bank.upiId)}&pn=${encodeURIComponent(company.slice(0, 40))}` +
        `&am=${(Number(t.grand) || 0).toFixed(2)}&cu=INR&tn=${encodeURIComponent(String(inv.invoiceNumber || 'Invoice').slice(0, 40))}`,
        { margin: 0, width: 300, errorCorrectionLevel: 'M' })
    : null;

  // ── Letterhead ────────────────────────────────────────────────
  const logoW = 70;
  let logoDrawn = false;
  if (branding.logo) {
    try { doc.image(branding.logo, L + 4, y + 2, { fit: [logoW, 60] }); logoDrawn = true; } catch { /* a bad logo never blocks an invoice */ }
  }
  const nameX = logoDrawn ? L + logoW + 16 : L;
  const nameW = W - (logoDrawn ? logoW + 16 : 0) - 180;
  text(company, nameX, y, { bold: true, size: 12, width: nameW });
  let ly = y + 16;
  const addressLines = Array.isArray(branding.addressLines) && branding.addressLines.length
    ? branding.addressLines.filter(Boolean)
    : (seller.address ? [seller.address] : []);
  const cityLine = [seller.city, seller.stateCode ? stateName(seller.stateCode) : '', seller.pincode].filter(Boolean).join(' ');
  const head = [...addressLines, cityLine, 'India', seller.gstin && `GSTIN ${seller.gstin}`, seller.email && `Email: ${seller.email}`, seller.phone && `Mobile: ${seller.phone}`].filter(Boolean);
  for (const s of head) { text(s, nameX, ly, { size: 8.5, width: nameW }); ly += 11; }

  // Title and, for an e-invoice, the portal's signed QR above it.
  const titleW = 180;
  let ty = y;
  if (signedQr) {
    doc.image(signedQr, R - 64, ty, { width: 64, height: 64 });
    text('e-Invoice', R - titleW, ty + 24, { size: 7.5, color: MUTED, width: titleW - 70, align: 'right' });
    text('signed QR', R - titleW, ty + 34, { size: 7.5, color: MUTED, width: titleW - 70, align: 'right' });
    ty += 70;
  }
  text(inv.docTitle || 'TAX INVOICE', R - titleW, Math.max(ty, ly - 26), { bold: true, size: 22, width: titleW, align: 'right' });
  if (cancelled) text('CANCELLED', R - titleW, Math.max(ty, ly - 26) + 26, { bold: true, size: 9, color: ALERT, width: titleW, align: 'right' });
  y = Math.max(ly, Math.max(ty, ly - 26) + 30, logoDrawn ? y + 66 : 0) + 4;

  // ── Invoice detail grid ───────────────────────────────────────
  const rowH = 14;
  const half = W / 2;
  // A credit or debit note brings its own rows (the invoice it is against).
  const leftRows = inv.detailRows?.left || [
    ['#', inv.invoiceNumber || '—'],
    ['Invoice Date', ddmmyyyy(inv.invoiceDate)],
    ['P.O.#', inv.customerPo || (inv.orderNo != null ? `Order #${inv.orderNo}` : '—')],
    ['Delivery Challan', (inv.dcs || []).map((d) => d.dcNumber).join(', ') || '—'],
  ];
  const taxLabel = zero ? `Zero-rated under LUT${exp.lut?.number ? ` ${exp.lut.number}` : ''} — no IGST`
    : inv.supplyType === 'export' ? 'IGST (export, with payment)' : inv.supplyType === 'sez' ? 'IGST (SEZ, with payment)'
    : inter ? `IGST (inter-state)${exp?.kind === 'DEXP' ? ', deemed export' : ''}` : `CGST + SGST (intra-state)${exp?.kind === 'DEXP' ? ', deemed export' : ''}`;
  const rightRows = inv.detailRows?.right || [
    ['Place Of Supply', inv.supplyType === 'export' ? `Other Country (96)${exp?.countryCode ? ` — ${exp.countryCode}` : ''}` : inv.placeOfSupply ? `${stateName(inv.placeOfSupply)} (${inv.placeOfSupply})` : '—'],
    ['Total Boxes', Number(inv.totalBoxes) > 0 ? String(inv.totalBoxes) : '—'],
    ['Tax', taxLabel],
    ['Order', inv.orderNo != null ? `#${inv.orderNo}` : '—'],
    ...(inv.supplyType === 'export' ? [
      ['Currency', exp?.currency && exp.currency !== 'INR' ? `${exp.currency} @ ₹${exp.exchangeRate} · ${exp.currency} ${(exportSupply.fxValue(exp, inv.totals?.grand) ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'INR'],
      ['Port / Ship. bill', [exp?.portCode, exp?.shippingBill?.number ? `${exp.shippingBill.number}${exp.shippingBill.date ? ` dt ${ddmmyyyy(exp.shippingBill.date)}` : ''}` : ''].filter(Boolean).join(' · ') || '—'],
    ] : []),
  ];
  const gridH = rowH * Math.max(leftRows.length, rightRows.length) + 6;
  hline(y, L, R, 0.8);
  const grid = (rows, x, w) => {
    let gy = y + 4;
    for (const [k, v] of rows) {
      text(k, x + 4, gy, { size: 8.5, width: 92 });
      text(`: ${v}`, x + 96, gy, { bold: true, size: 8.5, width: w - 100 });
      gy += rowH;
    }
  };
  grid(leftRows, L, half);
  grid(rightRows, L + half, half);
  vline(L + half, y, y + gridH);
  y += gridH;
  hline(y, L, R, 0.8);

  // ── e-Invoice particulars ─────────────────────────────────────
  if (registered) {
    const h = 30;
    text('IRN', L + 4, y + 4, { size: 8.5, width: 60 });
    text(`: ${inv.einvoice.irn}`, L + 40, y + 4, { bold: true, size: 7.5, width: W - 44 });
    text('Ack No.', L + 4, y + 16, { size: 8.5, width: 60 });
    text(`: ${inv.einvoice.ackNo || '—'}`, L + 40, y + 16, { bold: true, size: 8.5, width: 200 });
    text('Ack Date', L + half + 4, y + 16, { size: 8.5, width: 92 });
    text(`: ${when(inv.einvoice.ackDate)}`, L + half + 96, y + 16, { bold: true, size: 8.5, width: half - 100 });
    y += h;
    hline(y, L, R, 0.8);
  }

  // ── Bill To / Ship To ─────────────────────────────────────────
  band(L, y, half, 16); band(L + half, y, half, 16);
  text('Bill To', L + 4, y + 4, { bold: true, size: 9 });
  text('Ship To', L + half + 4, y + 4, { bold: true, size: 9 });
  y += 16;
  const billLines = [
    buyer.address,
    buyer.city,
    [buyer.pincode, buyer.stateCode ? stateName(buyer.stateCode) : ''].filter(Boolean).join(' '),
    'India',
    buyer.gstin && `GSTIN ${buyer.gstin}`,
  ].filter(Boolean);
  const partyH = Math.max(14 + billLines.length * 11, 60) + 8;
  text(buyer.name || '—', L + 4, y + 4, { bold: true, size: 10, width: half - 8 });
  let by = y + 18;
  for (const s of billLines) { text(s, L + 4, by, { size: 8.5, width: half - 8 }); by += 11; }
  const ship = inv.shipTo || [buyer.address, buyer.city, buyer.pincode].filter(Boolean).join(', ');
  doc.font(F).fontSize(8.5).fillColor(INK).text(ship || '—', L + half + 4, y + 4, { width: half - 8, height: partyH - 8 });
  vline(L + half, y - 16, y + partyH);
  y += partyH;
  hline(y, L, R, 0.8);
  y += 4;

  // ── Lines ─────────────────────────────────────────────────────
  const showBoxes = lines.some((l) => Number(l.boxes) > 0);
  const cols = [
    { k: 'sno', h: '#', w: 18, a: 'right' },
    { k: 'desc', h: 'Item & Description', w: 0, a: 'left' },
    ...(showBoxes ? [{ k: 'boxes', h: 'Boxes', w: 36, a: 'right' }] : []),
    { k: 'hsn', h: 'HSN/SAC', w: 46, a: 'left' },
    { k: 'qty', h: 'Qty', w: 62, a: 'right' },
    { k: 'rate', h: 'Rate', w: 48, a: 'right' },
    ...(inter
      ? [{ k: 'ipct', h: '%', w: 36, a: 'right', g: 'IGST' }, { k: 'iamt', h: 'Amt', w: 58, a: 'right', g: 'IGST' }]
      : [{ k: 'cpct', h: '%', w: 32, a: 'right', g: 'CGST' }, { k: 'camt', h: 'Amt', w: 52, a: 'right', g: 'CGST' },
         { k: 'spct', h: '%', w: 32, a: 'right', g: 'SGST' }, { k: 'samt', h: 'Amt', w: 52, a: 'right', g: 'SGST' }]),
    { k: 'amount', h: 'Amount', w: 66, a: 'right' },
  ];
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  cols.find((c) => c.k === 'desc').w = W - fixed;
  const xOf = (i) => L + cols.slice(0, i).reduce((a, c) => a + c.w, 0);

  const tableHeader = () => {
    const h = 28;
    band(L, y, W, h);
    cols.forEach((c, i) => {
      const x = xOf(i);
      if (i > 0) vline(x, y, y + h);
      if (c.g) {
        // Group label across the % and Amt pair, once per group.
        const first = cols.findIndex((d) => d.g === c.g);
        if (first === i) {
          const gw = cols.filter((d) => d.g === c.g).reduce((a, d) => a + d.w, 0);
          text(c.g, x, y + 2, { bold: true, size: 8, width: gw, align: 'center' });
          hline(y + 13, x, x + gw);
        }
        text(c.h, x + 2, y + 17, { bold: true, size: 8, width: c.w - 4, align: c.a });
      } else {
        text(c.h, x + 2, y + 15, { bold: true, size: 8, width: c.w - 4, align: c.a });
      }
    });
    y += h;
  };

  const cellsOf = (l, i) => ({
    sno: String(i + 1), desc: l.name || '—', boxes: Number(l.boxes) > 0 ? String(l.boxes) : '',
    hsn: l.hsn || '—', qty: `${qty(l.quantity)} ${l.unit || ''}`.trim(), rate: money(l.rate),
    ipct: pct(l.gstPercent), iamt: money(l.igst),
    cpct: pct((Number(l.gstPercent) || 0) / 2), camt: money(l.cgst), spct: pct((Number(l.gstPercent) || 0) / 2), samt: money(l.sgst),
    amount: money(l.amount),
  });

  tableHeader();
  let tableTop = y - 28;
  const closeTable = () => { box(L, tableTop, W, y - tableTop); cols.forEach((c, i) => { if (i > 0) vline(xOf(i), tableTop, y); }); };
  lines.forEach((l, i) => {
    const cells = cellsOf(l, i);
    const descW = cols.find((c) => c.k === 'desc').w - 6;
    doc.font(F).fontSize(8.5);
    const h = Math.max(18, doc.heightOfString(cells.desc, { width: descW }) + 8);
    if (y + h > bottom - 20) { closeTable(); newPage(); tableHeader(); tableTop = y - 28; }
    cols.forEach((c, k) => {
      const x = xOf(k);
      if (c.k === 'desc') {
        doc.font(F).fontSize(8.5).fillColor(INK).text(cells.desc, x + 3, y + 4, { width: descW });
      } else {
        text(cells[c.k], x + 2, y + 4, { size: 8.5, width: c.w - 4, align: c.a });
      }
    });
    y += h;
    hline(y, L, R, 0.4);
  });
  if (!lines.length) { text('No lines.', L + 4, y + 4, { color: MUTED }); y += 18; }
  closeTable();
  y += 6;

  // ── Totals (right) and words / notes / bank (left) ────────────
  const totalsW = 230;
  const tx = R - totalsW;
  const leftW = W - totalsW - 12;
  const rates = [...new Set(lines.map((l) => Number(l.gstPercent) || 0))].sort((a, b) => a - b);
  const sumBy = (rate, k) => Math.round(lines.filter((l) => (Number(l.gstPercent) || 0) === rate).reduce((a, l) => a + (Number(l[k]) || 0), 0) * 100) / 100;
  const totalRows = [
    ['Sub Total', money(t.taxable)],
    ['Total Taxable Amount', money(t.taxable)],
  ];
  for (const r of rates) {
    if (inter) totalRows.push([`IGST${r} (${r}%)`, money(sumBy(r, 'igst'))]);
    else {
      totalRows.push([`CGST${r / 2} (${r / 2}%)`, money(sumBy(r, 'cgst'))]);
      totalRows.push([`SGST${r / 2} (${r / 2}%)`, money(sumBy(r, 'sgst'))]);
    }
  }
  if (Number(t.roundOff)) totalRows.push(['Round Off', money(t.roundOff)]);
  const totalsH = totalRows.length * 13 + 24;
  const totalQty = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
  const leftNeeded = 150 + (upi ? 80 : 0);
  if (y + Math.max(totalsH + 70, leftNeeded) > bottom) newPage();

  // Right column.
  let ry = y + 6;
  for (const [k, v] of totalRows) {
    text(k, tx, ry, { size: 8.5, width: totalsW - 90, align: 'right' });
    text(v, tx + totalsW - 86, ry, { size: 8.5, width: 86, align: 'right' });
    ry += 13;
  }
  hline(ry + 1, tx, R, 0.8);
  text('Total', tx, ry + 6, { bold: true, size: 9.5, width: totalsW - 90, align: 'right' });
  text(`${RS}${money(t.grand)}`, tx + totalsW - 96, ry + 6, { bold: true, size: 9.5, width: 96, align: 'right' });
  ry += 24;
  hline(ry, tx, R, 0.8);
  const sigH = 70;
  box(tx, ry, totalsW, sigH);
  text(`For ${company}`, tx + 4, ry + 6, { size: 8, color: MUTED, width: totalsW - 8 });
  text('Authorized Signature', tx, ry + sigH - 14, { size: 8.5, width: totalsW, align: 'center' });
  vline(tx, y, ry + sigH);
  const rightEnd = ry + sigH;

  // Left column.
  let lx = L;
  let ly2 = y + 6;
  text('Items in Total', lx, ly2, { size: 8, color: MUTED, width: 70 });
  text(`${qty(totalQty)} ${lines[0]?.unit || 'm'}`, lx + 66, ly2 - 1, { size: 10, width: leftW - 66 });
  ly2 += 16;
  text('Total In Words', lx, ly2, { size: 9, color: MUTED, width: leftW });
  ly2 += 11;
  doc.font(FB).fontSize(9.5).fillColor(INK).text(inv.amountInWords || '—', lx, ly2, { width: leftW });
  ly2 += doc.heightOfString(inv.amountInWords || '—', { width: leftW }) + 8;
  const notes = [exportSupply.declaration(exp), inv.notes, invSettings.declaration].filter(Boolean);
  if (notes.length) {
    text('Notes', lx, ly2, { size: 9, color: MUTED, width: leftW });
    ly2 += 11;
    doc.font(F).fontSize(8).fillColor(INK).text(notes.join('\n'), lx, ly2, { width: leftW });
    ly2 += doc.heightOfString(notes.join('\n'), { width: leftW }) + 8;
  }
  const bankLines = [
    bank.name && `${bank.name}${bank.branch ? `, ${bank.branch}` : ''}`,
    bank.account && `Ac.No: ${bank.account}`,
    bank.ifsc && `IFSC ${bank.ifsc}`,
    bank.upiId && `UPI ID: ${bank.upiId}`,
  ].filter(Boolean);
  for (const s of bankLines) { text(s, lx, ly2, { bold: true, size: 9, width: leftW }); ly2 += 11; }
  if (upi) {
    ly2 += 3;
    doc.image(upi, lx, ly2, { width: 56, height: 56 });
    text('Scan to', lx + 64, ly2 + 18, { size: 9, width: 80 });
    text('Pay', lx + 64, ly2 + 30, { size: 9, width: 80 });
    ly2 += 60;
  }
  y = Math.max(rightEnd, ly2) + 8;

  // ── HSN / SAC summary ─────────────────────────────────────────
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.hsn || '—'}|${Number(l.gstPercent) || 0}`;
    const g = groups.get(key) || { hsn: l.hsn || '—', rate: Number(l.gstPercent) || 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    g.taxable += Number(l.taxable) || 0; g.cgst += Number(l.cgst) || 0; g.sgst += Number(l.sgst) || 0; g.igst += Number(l.igst) || 0;
    groups.set(key, g);
  }
  const rows = [...groups.values()];
  const sumRows = (k) => rows.reduce((a, g) => a + g[k], 0);
  const sCols = inter
    ? [['HSN/SAC', 80, 'left'], ['Taxable Amount', 0, 'right'], ['IGST Rate', 70, 'right'], ['Amount', 80, 'right'], ['Total Tax Amount', 90, 'right']]
    : [['HSN/SAC', 80, 'left'], ['Taxable Amount', 0, 'right'], ['CGST Rate', 60, 'right'], ['Amount', 70, 'right'], ['SGST Rate', 60, 'right'], ['Amount', 70, 'right'], ['Total Tax Amount', 90, 'right']];
  const sFixed = sCols.reduce((a, c) => a + c[1], 0);
  sCols[1][1] = W - sFixed;
  const sx = (i) => L + sCols.slice(0, i).reduce((a, c) => a + c[1], 0);
  const summaryH = 16 + (rows.length + 1) * 16;
  if (y + summaryH + 4 > bottom) newPage();
  text('HSN/SAC Summary:', L, y, { size: 8.5, color: MUTED });
  y += 12;
  const sTop = y;
  band(L, y, W, 16);
  sCols.forEach((c, i) => text(c[0], sx(i) + 3, y + 4, { bold: true, size: 8, width: c[1] - 6, align: c[2] }));
  y += 16;
  const sRow = (cells, bold) => {
    cells.forEach((v, i) => text(v, sx(i) + 3, y + 4, { bold, size: 8, width: sCols[i][1] - 6, align: sCols[i][2] }));
    y += 16;
    hline(y, L, R, 0.4);
  };
  for (const g of rows) {
    sRow(inter
      ? [g.hsn, money(g.taxable), pct(g.rate), money(g.igst), money(g.igst)]
      : [g.hsn, money(g.taxable), pct(g.rate / 2), money(g.cgst), pct(g.rate / 2), money(g.sgst), money(g.cgst + g.sgst)]);
  }
  sRow(inter
    ? ['Total', money(sumRows('taxable')), '', money(sumRows('igst')), money(sumRows('igst'))]
    : ['Total', money(sumRows('taxable')), '', money(sumRows('cgst')), '', money(sumRows('sgst')), money(sumRows('cgst') + sumRows('sgst'))], true);
  box(L, sTop, W, y - sTop);
  sCols.forEach((c, i) => { if (i > 0) vline(sx(i), sTop, y); });
  y += 8;

  if (cancelled) {
    text(`CANCELLED${inv.cancel?.reason ? ` — ${inv.cancel.reason}` : ''}`, L, y, { bold: true, size: 9, color: ALERT, width: W });
    y += 14;
  }
  if (branding.footerNote && y + 12 < bottom) {
    text(branding.footerNote, L, y, { size: 7.5, color: MUTED, width: W, align: 'center' });
  }

  // ── Page numbers and the cancelled stamp ──────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Above the bottom margin: a line that crosses it makes pdfkit open
    // a new page for it, and the invoice gains a blank page.
    text(`${inv.invoiceNumber || ''} · page ${i - range.start + 1} of ${range.count}`, L, doc.page.height - 42, { size: 7, color: MUTED, width: W, align: 'right' });
    if (cancelled) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font(FB).fontSize(72).fillColor(ALERT).opacity(0.12)
        .text('CANCELLED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
        .opacity(1).restore();
    }
  }

  doc.end();
  return done;
}

module.exports = { buildInvoicePdf };

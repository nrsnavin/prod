'use strict';
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS DOCUMENTS THE OTHER SIDE RECEIVES
//
//  buildVoucherPdf    a RECEIPT for a customer (what we received and
//                     which invoices it settled) or a PAYMENT ADVICE for
//                     a supplier (what we paid, the TDS deducted and on
//                     what, and which bills it settled)
//  buildStatementPdf  a party's ledger account for a period, as Tally
//                     prints it: To/By particulars, voucher type and
//                     number, Dr/Cr, totals, closing balance
//
//  Plain data in, a Buffer out, like every renderer the PDF workers run.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { amountInWords } = require('../services/gst');

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#8A8A8A';
const BAND = '#EDEDED';
const FONTS = {
  regular: path.join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  bold: path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf'),
};
const hasFonts = () => { try { return fs.existsSync(FONTS.regular) && fs.existsSync(FONTS.bold); } catch { return false; } };

const dmy = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()}`;
};
const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A page with our letterhead and a title; returns the drawing helpers. */
function start({ title, branding = {}, company }) {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  let F = 'Helvetica'; let FB = 'Helvetica-Bold'; let RS = 'Rs.';
  if (hasFonts()) {
    try { doc.registerFont('Body', FONTS.regular); doc.registerFont('BodyBold', FONTS.bold); F = 'Body'; FB = 'BodyBold'; RS = '₹'; } catch { /* built-in fonts */ }
  }
  const L = 36; const W = doc.page.width - 72; const R = L + W;
  const text = (s, x, y, o = {}) => doc.font(o.bold ? FB : F).fontSize(o.size || 9).fillColor(o.color || INK)
    .text(String(s ?? ''), x, y, { width: o.width, align: o.align || 'left', lineBreak: o.lineBreak ?? false });
  const hline = (y, w = 0.6) => doc.moveTo(L, y).lineTo(R, y).lineWidth(w).strokeColor(RULE).stroke();

  let y = 36;
  let logo = false;
  if (branding.logo) { try { doc.image(branding.logo, L, y, { fit: [60, 50] }); logo = true; } catch { /* no logo */ } }
  const nx = logo ? L + 70 : L;
  text(company || branding.company || 'Balu Elastics', nx, y, { bold: true, size: 13, width: W - 270 });
  let ly = y + 17;
  for (const line of [...(branding.addressLines || []), branding.gstin && `GSTIN ${branding.gstin}`, branding.phone && `Phone ${branding.phone}`].filter(Boolean)) {
    text(line, nx, ly, { size: 8.5, color: MUTED, width: W - 270 }); ly += 11;
  }
  text(title, R - 260, y, { bold: true, size: title.length > 14 ? 14 : 18, width: 260, align: 'right' });
  y = Math.max(ly, y + 56) + 8;
  hline(y, 0.9);
  return { doc, done, text, hline, L, W, R, RS, F, FB, y };
}

/**
 * Rows of a simple table, with a header band; returns the new y.
 *
 * Each row is as tall as its tallest cell: a cell that has to wrap
 * (a long name, a figure in crores) pushes the next row down instead
 * of printing over it. A row that would cross the foot of the page
 * starts a new one, under the header band again.
 */
function table(ctx, y, cols, rows, { size = 8.5, smallSize = 7.5 } = {}) {
  const { doc, text, L, W } = ctx;
  const xs = []; let x = L;
  for (const c of cols) { xs.push(x); x += c.w * W; }
  const head = (at) => {
    doc.rect(L, at, W, 16).fillColor(BAND).fill();
    cols.forEach((c, i) => text(c.h, xs[i] + 4, at + 4, { bold: true, size: 8, width: c.w * W - 8, align: c.align }));
    return at + 18;
  };
  const foot = () => doc.page.height - 56;
  y = head(y);
  for (const r of rows) {
    const fs = r.small ? smallSize : size;
    const cell = (i) => String(r[i] ?? '');
    // A row may let one cell run on over the empty cells after it.
    const span = (i) => (r.spanFrom === i ? r.spanTo - i + 1 : 1);
    const skip = (i) => r.spanFrom !== undefined && i > r.spanFrom && i <= r.spanTo;
    const width = (i) => cols.slice(i, i + span(i)).reduce((t, c) => t + c.w * W, 0) - 8;
    const h = Math.max(...cols.map((c, i) => (cell(i) && !skip(i)
      ? doc.font(r.bold ? ctx.FB : ctx.F).fontSize(fs).heightOfString(cell(i), { width: width(i), align: c.align })
      : 0)), fs * 1.2);
    const step = h + (r.small ? 2 : 4);
    if (y + step > foot()) { doc.addPage(); y = head(40); }
    if (r.rule) { doc.moveTo(L, y - 2).lineTo(L + W, y - 2).lineWidth(0.5).strokeColor(RULE).stroke(); }
    cols.forEach((c, i) => { if (!skip(i)) text(cell(i), xs[i] + 4, y, { size: fs, width: width(i), align: c.align, bold: r.bold, color: r.muted ? MUTED : INK, lineBreak: true }); });
    y += step;
  }
  return y;
}

/** Room for `need` points more on this page, else a fresh page; returns the y to draw at. */
function room(ctx, y, need) {
  if (y + need <= ctx.doc.page.height - 56) return y;
  ctx.doc.addPage();
  return 40;
}

function finish(ctx, footer) {
  const { doc, text, L, W } = ctx;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; drawn with the margin in
    // force, pdfkit would carry it onto a fresh, otherwise blank page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    text(`${footer} · page ${i - range.start + 1} of ${range.count}`, L, doc.page.height - 30, { size: 7, color: MUTED, width: W, align: 'right' });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return ctx.done;
}

/**
 * @param voucher  the Payment document (lean)
 * @param party    { name, gstin, address } of the customer or supplier
 */
async function buildVoucherPdf({ voucher, party = {}, branding = {}, company } = {}) {
  const v = voucher || {};
  const receipt = v.kind === 'receipt';
  const ctx = start({ title: receipt ? 'RECEIPT' : 'PAYMENT ADVICE', branding, company });
  const { text, hline, L, W, RS } = ctx;
  let y = ctx.y + 10;
  const half = W / 2;
  text(receipt ? 'Received from' : 'Paid to', L, y, { size: 8, color: MUTED });
  text(receipt ? 'Receipt' : 'Voucher', L + half, y, { size: 8, color: MUTED });
  y += 12;
  text(party.name || v.partyName, L, y, { bold: true, size: 11, width: half - 10 });
  text(`${v.voucherNo}  ·  ${dmy(v.date)}`, L + half, y, { bold: true, size: 11, width: half });
  y += 15;
  if (party.gstin) { text(`GSTIN ${party.gstin}`, L, y, { size: 8.5, width: half - 10 }); }
  text(`${v.mode === 'cheque' ? 'Cheque' : v.mode === 'upi' ? 'UPI' : v.mode === 'cash' ? 'Cash' : 'Bank transfer'}${v.reference ? ` · ${v.reference}` : ''}${v.accountName ? ` · ${v.accountName}` : ''}`, L + half, y, { size: 8.5, width: half });
  y += 12;
  if (party.address) { text(party.address, L, y, { size: 8.5, color: MUTED, width: half - 10, lineBreak: true }); }
  y += 26;

  const big = `${RS} ${money(v.amount)}`;
  text(receipt ? 'Amount received' : 'Amount paid', L, y, { size: 8, color: MUTED });
  y += 11;
  text(big, L, y, { bold: true, size: 18 });
  y += 24;
  text(amountInWords(v.amount || 0), L, y, { size: 8.5, width: W, lineBreak: true });
  y += 20;

  const allocations = v.allocations || [];
  if (allocations.length) {
    const cols = receipt
      ? [{ h: 'Against', w: 0.5 }, { h: 'Settled', w: 0.5, align: 'right' }]
      : [{ h: 'Against', w: 0.34 }, { h: 'Settled', w: 0.22, align: 'right' }, { h: 'TDS on', w: 0.22, align: 'right' }, { h: 'TDS', w: 0.22, align: 'right' }];
    const rows = allocations.map((a) => (receipt
      ? [a.docNo, money(a.amount)]
      : [a.docNo, money(a.amount), a.tds ? money(a.tdsBase || a.amount) : '—', a.tds ? money(a.tds) : '—']));
    y = table(ctx, y, cols, rows) + 6;
  }
  const lines = [];
  if (v.tds?.amount) lines.push([`TDS deducted u/s ${v.tds.section || '—'} @ ${v.tds.rate}% on ${RS} ${money(v.tds.base || 0)}`, money(v.tds.amount)]);
  for (const a of v.adjustments || []) lines.push([a.label || a.kind, money(a.amount)]);
  if (v.unallocated > 0.005) lines.push([receipt ? 'Held on account (advance)' : 'Paid on account (advance)', money(v.unallocated)]);
  for (const [k, val] of lines) { text(k, L, y, { size: 8.5, width: W - 120 }); text(val, L + W - 120, y, { size: 8.5, width: 120, align: 'right' }); y += 13; }
  if (v.narration) { y += 6; text(v.narration, L, y, { size: 8.5, color: MUTED, width: W, lineBreak: true }); y += 14; }
  if (v.status === 'cancelled') { y += 8; text(`CANCELLED${v.cancel?.reason ? ` — ${v.cancel.reason}` : ''}`, L, y, { bold: true, size: 10, color: '#A02020' }); y += 14; }

  y = Math.max(y + 40, ctx.doc.page.height - 140);
  hline(y);
  text(receipt ? 'This is a computer-generated receipt.' : 'This is a computer-generated payment advice. TDS deducted will reflect in your Form 26AS once deposited.', L, y + 6, { size: 7.5, color: MUTED, width: W * 0.6, lineBreak: true });
  text(`For ${company || branding.company || 'Balu Elastics'}`, L + W * 0.6, y + 6, { size: 8.5, width: W * 0.4, align: 'right' });
  text('Authorised signatory', L + W * 0.6, y + 46, { size: 8, color: MUTED, width: W * 0.4, align: 'right' });
  return finish(ctx, v.voucherNo || '');
}

/**
 * The ledger account as Tally prints it.
 * @param statement  partyStatement.ledgerAccount(): { opening, openingSide, rows, totals, closing, closingSide }
 * @param party      { name, gstin, address }
 * @param partyType  customer | supplier
 * @param detailed   each voucher's other ledgers and bill-wise references under it
 */
async function buildStatementPdf({ statement, party = {}, partyType = 'customer', from, to, open, detailed = false, branding = {}, company } = {}) {
  const s = statement || { opening: 0, rows: [], closing: 0, totals: { debit: 0, credit: 0 } };
  const ctx = start({ title: 'LEDGER ACCOUNT', branding, company });
  const { text, L, W, RS } = ctx;
  let y = ctx.y + 10;
  text(party.name || '', L, y, { bold: true, size: 11, width: W * 0.6 });
  text(`${from ? dmy(from) : 'From the start'} to ${dmy(to || new Date())}`, L + W * 0.6, y, { size: 9, width: W * 0.4, align: 'right' });
  y += 14;
  if (party.gstin) { text(`GSTIN ${party.gstin}`, L, y, { size: 8.5 }); y += 12; }
  if (party.address) { text(party.address, L, y, { size: 8.5, color: MUTED, width: W * 0.6, lineBreak: true }); y += 12; }
  y += 10;
  // Sized at 8 pt so a date, a voucher number (RCT/2026-27/0001), a
  // figure in lakhs and a balance with its Dr/Cr each sit on one line.
  const cols = [
    { h: 'Date', w: 0.105 }, { h: 'Particulars', w: 0.24 }, { h: 'Vch Type', w: 0.11 }, { h: 'Vch No.', w: 0.165 },
    { h: 'Debit', w: 0.12, align: 'right' }, { h: 'Credit', w: 0.12, align: 'right' }, { h: 'Balance', w: 0.14, align: 'right' },
  ];
  const fallbackSide = (b) => (Math.abs(b) < 0.005 ? '' : partyType === 'customer' ? (b > 0 ? 'Dr' : 'Cr') : (b > 0 ? 'Cr' : 'Dr'));
  const bal = (b, side) => `${money(Math.abs(b))} ${side ?? fallbackSide(b)}`.trim();
  const inCol = (amount, side) => (side === 'Dr' ? [money(Math.abs(amount)), ''] : side === 'Cr' ? ['', money(Math.abs(amount))] : ['', '']);
  const openSide = s.openingSide ?? fallbackSide(s.opening);
  const closeSide = s.closingSide ?? fallbackSide(s.closing);
  const rows = [Object.assign(['', 'Opening Balance', '', '', ...inCol(s.opening, openSide), bal(s.opening, openSide)], { bold: true })];
  for (const r of s.rows) {
    const particulars = r.particulars ? `${r.toBy || (r.debit ? 'To' : 'By')} ${r.particulars}` : String(r.narration || '');
    rows.push([dmy(r.date), particulars.slice(0, 90), r.vchType || '', r.docNo, r.debit ? money(r.debit) : '', r.credit ? money(r.credit) : '', bal(r.balance, r.balanceSide)]);
    // The lines under a voucher run on over Vch Type and Vch No., which they leave empty.
    const sub = (t) => Object.assign(['', `   ${t}`.slice(0, 110), '', '', '', '', ''], { small: true, muted: true, spanFrom: 1, spanTo: 3 });
    if (r.partyRef) rows.push(sub(r.partyRef));
    if (detailed) {
      for (const l of r.lines || []) rows.push(sub(`${l.ledger}  ${money(l.amount)}`));
      for (const b of r.refs || []) rows.push(sub(`${b.type} ${b.name}  ${money(b.amount)}`));
    }
  }
  const totals = s.totals || { debit: s.rows.reduce((t, r) => t + (r.debit || 0), 0), credit: s.rows.reduce((t, r) => t + (r.credit || 0), 0) };
  rows.push(Object.assign(['', 'Current Total', '', '', money(totals.debit), money(totals.credit), ''], { bold: true, rule: true }));
  rows.push(Object.assign(['', 'Closing Balance', '', '', ...inCol(s.closing, closeSide), bal(s.closing, closeSide)], { bold: true }));
  y = table(ctx, y, cols, rows, { size: 8, smallSize: 7 }) + 10;
  y = room(ctx, y, 60);
  const owes = s.closing > 0;
  const who = partyType === 'customer' ? (owes ? 'Due from you' : 'Held for you') : (owes ? 'Due to you' : 'Paid ahead to you');
  text(`${who}: ${RS} ${money(Math.abs(s.closing))}`, L, y, { bold: true, size: 11 });
  y += 16;
  if (open && open.overdue > 0) { text(`Of which past due: ${RS} ${money(open.overdue)}`, L, y, { size: 9 }); y += 13; }
  y += 8;
  text('Please let us know within 15 days if anything here does not agree with your books.', L, y, { size: 8, color: MUTED, width: W, lineBreak: true });
  return finish(ctx, `${party.name || 'Ledger'} · ${dmy(to || new Date())}`);
}

module.exports = { buildVoucherPdf, buildStatementPdf };

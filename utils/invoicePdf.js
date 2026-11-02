'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICE (PDF)
//
//  The invoice as the customer and their auditor read it: seller and
//  buyer with GSTINs, the IRN with the portal's signed QR once it is
//  registered, every line with HSN and the tax split, the totals, the
//  amount in words, the bank the money goes to. A4 portrait, the dense
//  ruled-box form the challan and purchase order already use.
//
//  Pure: buildInvoicePdf({ invoice, branding, settings }) → Buffer.
//  Rendered in a worker (utils/renderPdf.js), so nothing here touches
//  the database. The rupee sign is never written — pdfkit's built-in
//  Helvetica has no glyph for it and prints "¹" instead.
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { stateName } = require('../services/gst');
const {
  INK, MUTED, RULE, HEADER_BG, boxLabel, boxValue, field, box, titleBox, signatureStrip,
} = require('./sapForm');

const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const day = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const when = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const party = (p = {}) => [p.address, [p.city, p.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', ');

async function buildInvoicePdf({ invoice, branding = {}, settings = {} } = {}) {
  const inv = invoice || {};
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const inter = inv.supplyType === 'inter';
  const cancelled = inv.status === 'cancelled';
  const registered = inv.einvoice?.status === 'registered' && inv.einvoice?.irn;
  const invSettings = settings.invoice || {};

  const qr = registered && inv.einvoice.signedQr
    ? await QRCode.toBuffer(String(inv.einvoice.signedQr), { margin: 0, width: 360, errorCorrectionLevel: 'M' })
    : null;

  const doc = new PDFDocument({ size: 'A4', margin: 30, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const L = 30;
  const W = doc.page.width - L * 2;
  const R = L + W;
  const bottom = doc.page.height - 30;
  let y = 30;

  // ── Letterhead ────────────────────────────────────────────────
  const seller = inv.seller || {};
  const company = seller.name || branding.company || 'Balu Elastics';
  const titleW = 170;
  if (branding.logo) {
    try { doc.image(branding.logo, L, y, { fit: [54, 40] }); } catch { /* a bad logo never blocks an invoice */ }
  }
  const nameX = branding.logo ? L + 62 : L;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(company, nameX, y, { width: W - titleW - 80, lineBreak: false });
  let ly = y + 17;
  const sub = [];
  if (branding.tagline) sub.push(branding.tagline);
  if (seller.address) sub.push(seller.address);
  const cityLine = [seller.city, seller.pincode].filter(Boolean).join(' - ');
  if (cityLine) sub.push(cityLine + (seller.stateCode ? `, ${stateName(seller.stateCode)}` : ''));
  if (seller.gstin) sub.push(`GSTIN ${seller.gstin}${seller.stateCode ? `  ·  State code ${seller.stateCode}` : ''}`);
  const contact = [seller.phone, seller.email, branding.website].filter(Boolean).join('  ·  ');
  if (contact) sub.push(contact);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  for (const s of sub) { doc.text(s, nameX, ly, { width: W - titleW - 80, lineBreak: false }); ly += 10; }

  titleBox(doc, 'Tax invoice', R - titleW, y, titleW);
  doc.font(cancelled ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(cancelled ? '#A02020' : MUTED)
    .text(cancelled ? 'CANCELLED' : (registered ? 'e-Invoice · IRN registered' : 'Original for recipient'), R - titleW, y + 30, { width: titleW, align: 'center', lineBreak: false });

  y = Math.max(ly, y + 44) + 6;

  // ── IRN band ──────────────────────────────────────────────────
  if (registered) {
    const h = 44;
    const qrSize = 40;
    box(doc, L, y, W, h);
    if (qr) doc.image(qr, L + 4, y + 2, { width: qrSize, height: qrSize });
    const tx = L + (qr ? qrSize + 10 : 6);
    boxLabel(doc, 'IRN', tx, y + 4, W - 60);
    doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(String(inv.einvoice.irn), tx, y + 13, { width: W - 70, lineBreak: false });
    boxLabel(doc, 'Ack no.', tx, y + 25, 120);
    boxValue(doc, inv.einvoice.ackNo || '—', tx + 34, y + 24, 120, { fontSize: 8 });
    boxLabel(doc, 'Ack date', tx + 170, y + 25, 120);
    boxValue(doc, when(inv.einvoice.ackDate), tx + 210, y + 24, 160, { fontSize: 8 });
    y += h + 6;
  }

  // ── Buyer and invoice detail ──────────────────────────────────
  const buyer = inv.buyer || {};
  const colW = W / 2;
  const blockH = 96;
  box(doc, L, y, colW, blockH);
  box(doc, L + colW, y, colW, blockH);

  let by = y + 4;
  boxLabel(doc, 'Billed to', L + 6, by, colW - 12); by += 9;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(buyer.name || '—', L + 6, by, { width: colW - 12, lineBreak: false }); by += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  const addr = party(buyer);
  if (addr) { doc.text(addr, L + 6, by, { width: colW - 12, height: 22 }); by += Math.min(22, doc.heightOfString(addr, { width: colW - 12 })) + 2; }
  if (buyer.stateCode) { doc.text(`${stateName(buyer.stateCode) || 'State'} (${buyer.stateCode})`, L + 6, by, { width: colW - 12, lineBreak: false }); by += 11; }
  doc.text(`GSTIN ${buyer.gstin || '—'}`, L + 6, by, { width: colW - 12, lineBreak: false }); by += 11;
  const bc = [buyer.phone, buyer.email].filter(Boolean).join('  ·  ');
  if (bc) doc.fillColor(MUTED).fontSize(8).text(bc, L + 6, by, { width: colW - 12, lineBreak: false });

  const dx = L + colW + 6;
  const half = (colW - 12) / 2;
  let dy = y + 4;
  field(doc, 'Invoice no.', inv.invoiceNumber, dx, dy, half, { bold: true });
  field(doc, 'Invoice date', day(inv.invoiceDate), dx + half, dy, half);
  dy += 22;
  field(doc, 'Against order', inv.orderNo != null ? `#${inv.orderNo}` : '—', dx, dy, half);
  field(doc, "Buyer's order no.", inv.customerPo || '—', dx + half, dy, half);
  dy += 22;
  field(doc, 'Place of supply', inv.placeOfSupply ? `${stateName(inv.placeOfSupply) || ''} (${inv.placeOfSupply})` : '—', dx, dy, half);
  field(doc, 'Tax', inter ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)', dx + half, dy, half);
  dy += 22;
  const dcList = (inv.dcs || []).map((d) => d.dcNumber).join(', ');
  field(doc, 'Delivery challans', dcList || '—', dx, dy, colW - 12, { fontSize: 8 });
  y += blockH + 6;

  // ── Lines ─────────────────────────────────────────────────────
  // Column widths sum to W. The tax columns depend on the supply type.
  const cols = inter
    ? [['#', 18, 'right'], ['Description', 160, 'left'], ['HSN', 42, 'left'], ['Qty', 52, 'right'], ['Unit', 28, 'left'],
       ['Rate', 50, 'right'], ['Taxable', 62, 'right'], ['GST', 36, 'right'], ['IGST', 56, 'right'], ['Amount', 71, 'right']]
    : [['#', 18, 'right'], ['Description', 138, 'left'], ['HSN', 40, 'left'], ['Qty', 48, 'right'], ['Unit', 26, 'left'],
       ['Rate', 46, 'right'], ['Taxable', 58, 'right'], ['GST', 30, 'right'], ['CGST', 48, 'right'], ['SGST', 48, 'right'], ['Amount', 65, 'right']];
  const totalW = cols.reduce((a, c) => a + c[1], 0);
  const scale = W / totalW;
  cols.forEach((c) => { c[1] = c[1] * scale; });

  const header = () => {
    doc.rect(L, y, W, 16).fillColor(HEADER_BG).fill();
    doc.rect(L, y, W, 16).lineWidth(0.6).strokeColor(RULE).stroke();
    let x = L;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK);
    for (const [label, w, align] of cols) {
      doc.text(label.toUpperCase(), x + 3, y + 5, { width: w - 6, align, lineBreak: false });
      x += w;
    }
    y += 16;
  };
  const rowH = 15;
  // The frame round the rows is closed per page, so a table that runs
  // on to a second page is boxed on both.
  let tableTop = y;
  const closeTable = () => box(doc, L, tableTop, W, y - tableTop);
  header();
  lines.forEach((l, i) => {
    if (y + rowH > bottom - 40) { closeTable(); doc.addPage(); y = 30; tableTop = y; header(); }
    const cells = inter
      ? [i + 1, l.name, l.hsn || '—', qty(l.quantity), l.unit || '', money(l.rate), money(l.taxable), `${Number(l.gstPercent) || 0}%`, money(l.igst), money(l.amount)]
      : [i + 1, l.name, l.hsn || '—', qty(l.quantity), l.unit || '', money(l.rate), money(l.taxable), `${Number(l.gstPercent) || 0}%`, money(l.cgst), money(l.sgst), money(l.amount)];
    let x = L;
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    cells.forEach((v, k) => {
      const [, w, align] = cols[k];
      doc.text(String(v), x + 3, y + 4, { width: w - 6, align, lineBreak: false });
      x += w;
    });
    doc.moveTo(L, y + rowH).lineTo(R, y + rowH).lineWidth(0.3).strokeColor(RULE).stroke();
    y += rowH;
  });
  if (!lines.length) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('No lines.', L + 3, y + 4);
    y += rowH;
  }
  closeTable();

  // ── Totals, words, bank ───────────────────────────────────────
  const t = inv.totals || {};
  const totalsH = 14 * (inter ? 5 : 6) + 8;
  if (y + Math.max(totalsH, 110) + 70 > bottom) { doc.addPage(); y = 30; }
  const tw = 200;
  const tx = R - tw;
  box(doc, tx, y, tw, totalsH);
  let ty = y + 4;
  const trow = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8).fillColor(INK)
      .text(label, tx + 6, ty, { width: 100, lineBreak: false })
      .text(money(value), tx + 100, ty, { width: tw - 106, align: 'right', lineBreak: false });
    ty += 14;
  };
  trow('Taxable value', t.taxable);
  if (inter) trow('IGST', t.igst);
  else { trow('CGST', t.cgst); trow('SGST', t.sgst); }
  trow('Round off', t.roundOff);
  doc.moveTo(tx, ty - 2).lineTo(tx + tw, ty - 2).lineWidth(0.6).strokeColor(INK).stroke();
  trow('Total (INR)', t.grand, true);

  const lw = W - tw - 8;
  box(doc, L, y, lw, totalsH);
  boxLabel(doc, 'Amount in words', L + 6, y + 4, lw - 12);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(inv.amountInWords || '—', L + 6, y + 13, { width: lw - 12, height: 24 });
  const totalQty = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`${lines.length} line${lines.length === 1 ? '' : 's'} · ${qty(totalQty)} ${lines[0]?.unit || 'm'} in all`, L + 6, y + totalsH - 12, { width: lw - 12, lineBreak: false });
  y += totalsH + 6;

  const bank = invSettings.bank || {};
  const hasBank = bank.name || bank.account || bank.ifsc;
  const decl = invSettings.declaration || '';
  const noteH = hasBank || decl || inv.notes ? 60 : 0;
  if (noteH) box(doc, L, y, W, noteH);
  let ny = y + 4;
  if (hasBank) {
    boxLabel(doc, 'Bank details for payment', L + 6, ny, colW); ny += 9;
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    const bankLines = [bank.name && `Bank: ${bank.name}${bank.branch ? `, ${bank.branch}` : ''}`, bank.account && `A/c no.: ${bank.account}`, bank.ifsc && `IFSC: ${bank.ifsc}`].filter(Boolean);
    for (const b of bankLines) { doc.text(b, L + 6, ny, { width: colW - 12, lineBreak: false }); ny += 10; }
  }
  if (decl) {
    boxLabel(doc, 'Declaration', L + colW + 6, y + 4, colW - 12);
    doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(decl, L + colW + 6, y + 13, { width: colW - 12, height: noteH - 16 });
  }
  if (inv.notes) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Note: ${inv.notes}`, L + 6, y + noteH - 12, { width: colW - 12, lineBreak: false });
  }
  y += noteH ? noteH + 6 : 0;

  y = signatureStrip(doc, L, y, W, ['Received by', `For ${company} — Authorised signatory`], 48);

  if (cancelled) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#A02020')
      .text(`CANCELLED${inv.cancel?.reason ? ` — ${inv.cancel.reason}` : ''}`, L, y + 6, { width: W, lineBreak: false });
    y += 14;
  }
  if (branding.footerNote) {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(branding.footerNote, L, y + 6, { width: W, align: 'center', lineBreak: false });
  }

  // ── Page numbers, and the cancelled stamp across every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Above the bottom margin: a line that crosses it makes pdfkit open
    // a new page for it, and the invoice gains a blank page.
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`${inv.invoiceNumber || ''} · page ${i - range.start + 1} of ${range.count}`, L, doc.page.height - 42, { width: W, align: 'right', lineBreak: false });
    if (cancelled) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font('Helvetica-Bold').fontSize(72).fillColor('#A02020').opacity(0.12)
        .text('CANCELLED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
        .opacity(1).restore();
    }
  }

  doc.end();
  return done;
}

module.exports = { buildInvoicePdf };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  DELIVERY CHALLAN (PDF)
//
//  The challan on the same ruled sheet as the tax invoice
//  (utils/invoicePdf.js): every cell bordered, header rows lightly
//  shaded, item rows banded, quantities right-aligned in digits of
//  equal width. Top to bottom:
//
//    the title, across the sheet (a draft or a cancelled challan is
//      marked on it, and stamped across the page)
//    the letterhead: the logo left, the company centred
//    the particulars: challan number and date, the order, the e-way
//      bill; the vehicle, driver, transporter and LR number
//    the consignee: name and address; GSTIN, state and phone
//    the lines: description, HSN where it is known, and quantity, with
//      a total row
//    remarks and terms
//    four places to sign: prepared by, checked by, the receiver's (with
//      their seal), and ours
//
//  Quantities only. A challan goes with the goods and is not a tax
//  invoice, so no rate or value is printed (services/pdf/dcContext.js
//  keeps them out of the designer's fields for the same reason).
//
//  Laid out at the normal spacing, and again at a compact one when that
//  keeps it to a single page. A longer challan carries on over pages
//  with the title (marked "continued") and the table header repeated,
//  and the remarks and signatures moved over together.
//
//  A design made and switched on in Settings → PDF Designer takes over
//  from this one (services/pdf/dcPdf.js).
//
//  Pure: buildChallanPdf({ dc, branding, settings }) → Buffer.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { stateName } = require('../services/gst');

// ── The invoice's light spreadsheet ──────────────────────────────
const INK = '#1E2A36';
const MUTED = '#5C6B7A';
const ACCENT = '#1F4E79';
const GRID = '#C3CCD6';
const FRAME = '#8593A1';
const HEAD = '#E6EDF5';
const LABEL = '#F3F6F9';
const BAND = '#F4F7FB';
const ALERT = '#A02020';
const DRAFT = '#B7791F';

const DENSITY = {
  normal: {
    title: 26, titleSize: 14, nameSize: 16, headPad: 14, headMin: 58, logoBox: 72,
    row: 15.5, partyHead: 16, partyPad: 10, partyName: 10,
    head: 26, item: 16, itemPad: 6, sigBox: 32, text: 8.5, body: 8.5, headSize: 8, label: 8,
  },
  compact: {
    title: 22, titleSize: 13, nameSize: 14.5, headPad: 9, headMin: 50, logoBox: 60,
    row: 13.5, partyHead: 14, partyPad: 6, partyName: 9.5,
    head: 20, item: 13.5, itemPad: 4, sigBox: 24, text: 8, body: 8, headSize: 7.5, label: 7.5,
  },
};

const FONT_DIR = path.join(__dirname, 'fonts');
const FACES = [
  { regular: 'Carlito-Regular.ttf', bold: 'Carlito-Bold.ttf', tnum: true },
  { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf', tnum: false },
];

// A challan counts what went: 5,000 m, 12.5 kg, not 5,000.00.
const qty = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const ddmmyyyy = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()}`;
};

async function buildChallanPdf({ dc, branding = {}, settings = {} } = {}) {
  const args = { dc: dc || {}, branding, settings };
  const normal = render({ ...args, D: DENSITY.normal });
  if (normal.pages > 1) {
    const compact = render({ ...args, D: DENSITY.compact });
    if (compact.pages === 1) return compact.done;
  }
  return normal.done;
}

/** One layout of the challan at spacing D: { pages, done → Buffer }. */
function render({ dc, branding, settings, D }) {
  const items = Array.isArray(dc.items) ? dc.items : [];
  const defaults = settings.invoice || {};
  const company = branding.company || 'Balu Elastics';
  const cancelled = dc.status === 'cancelled';
  const draft = !dc.status || dc.status === 'draft';
  const title = 'DELIVERY CHALLAN';

  const M = 28;
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 12 }, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // ── Fonts ─────────────────────────────────────────────────────
  let F = 'Helvetica';
  let FB = 'Helvetica-Bold';
  let tnum = false;
  for (const face of FACES) {
    const reg = path.join(FONT_DIR, face.regular);
    const bold = path.join(FONT_DIR, face.bold);
    try {
      if (!fs.existsSync(reg) || !fs.existsSync(bold)) continue;
      const name = face.regular.replace(/\W/g, '');
      doc.registerFont(`${name}R`, reg);
      doc.registerFont(`${name}B`, bold);
      doc.font(`${name}R`);
      doc.font(`${name}B`);
      F = `${name}R`; FB = `${name}B`; tnum = face.tnum;
      break;
    } catch { /* the next face */ }
  }

  const L = M;
  const W = doc.page.width - M * 2;
  const R = L + W;
  const BOTTOM = doc.page.height - 32;
  const PAD = 5;
  const TP = 4;
  let y = M;

  const setFont = (bold, size) => doc.font(bold ? FB : F).fontSize(size);
  const features = (num) => (num && tnum ? { features: ['tnum'] } : {});
  const lh = (size = D.text, bold = false) => { setFont(bold, size); return doc.currentLineHeight(); };
  const hOf = (s, w, size = D.text, bold = false) => { setFont(bold, size); return doc.heightOfString(String(s ?? ''), { width: w }); };
  const wOf = (s, size = D.text, bold = false, num = false) => { setFont(bold, size); return doc.widthOfString(String(s ?? ''), features(num)); };
  // One line held to its cell (ending in "…" if it must) unless `wrap`.
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
  const mid = (yy, h, size = D.text, bold = false) => yy + (h - lh(size, bold)) / 2 + 0.6;
  const fillRect = (x, yy, w, h, color) => { doc.save(); doc.rect(x, yy, w, h).fillColor(color).fill(); doc.restore(); };
  const strokeRect = (x, yy, w, h, color = GRID, lw = 0.5) => { doc.save(); doc.rect(x, yy, w, h).lineWidth(lw).strokeColor(color).stroke(); doc.restore(); };
  const rule = (x1, y1, x2, y2, color = GRID, lw = 0.5) => { doc.save(); doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(lw).strokeColor(color).stroke(); doc.restore(); };
  const cell = (x, yy, w, h, fill) => { if (fill) fillRect(x, yy, w, h, fill); strokeRect(x, yy, w, h); };
  const pair = (x, yy, labW, valW, h, label, value) => {
    cell(x, yy, labW, h, LABEL);
    cell(x + labW, yy, valW, h);
    txt(label, x + PAD, mid(yy, h, D.label), { size: D.label, color: MUTED, width: labW - 2 * PAD });
    const vh = hOf(value, valW - 2 * PAD, D.text, true);
    txt(value, x + labW + PAD, yy + (h - vh) / 2 + 0.6, { bold: true, width: valW - 2 * PAD, wrap: true });
  };

  // ── Pages: one framed sheet each ──────────────────────────────
  let frameTop = y;
  const closeFrame = () => { if (y > frameTop) strokeRect(L, frameTop, W, y - frameTop, FRAME, 0.9); };
  const titleBand = (continued) => {
    const h = continued ? 20 : D.title;
    const size = continued ? 10 : D.titleSize;
    cell(L, y, W, h, HEAD);
    const label = continued ? `${title}  ·  ${dc.dcNumber || ''}  ·  continued` : title;
    txt(label, L, mid(y, h, size, true), { bold: true, size, color: ACCENT, width: W, align: 'center', spacing: continued ? 0.5 : 2 });
    if (cancelled || draft) {
      txt(cancelled ? 'CANCELLED' : 'DRAFT', L + PAD, mid(y, h, 9, true), { bold: true, size: 9, color: cancelled ? ALERT : DRAFT, width: W - 2 * PAD, align: 'right', spacing: 0.8 });
    }
    y += h;
  };
  const newPage = () => { closeFrame(); doc.addPage(); y = M; frameTop = y; titleBand(true); };
  const room = (h) => y + h <= BOTTOM;

  let logo = null;
  if (branding.logo) {
    try { logo = doc.openImage(branding.logo); } catch { logo = null; } // a bad logo never blocks a challan
  }

  titleBand(false);

  // ── Letterhead ────────────────────────────────────────────────
  {
    const side = logo ? 100 : 0;
    const cx = L + side + PAD;
    const cw = W - side * 2 - PAD * 2;
    const stateCode = /^\d{2}/.test(branding.gstin || '') ? branding.gstin.slice(0, 2) : '';
    const cityPart = [[defaults.city, stateCode ? stateName(stateCode) : ''].filter(Boolean).join(', '), defaults.pincode].filter(Boolean).join(' - ');
    const rows = [
      [[...(branding.addressLines || []), cityPart].filter(Boolean).join(', '), false, INK],
      [[branding.gstin && `GSTIN: ${branding.gstin}`, stateCode && `State Code: ${stateCode}`].filter(Boolean).join('     '), true, INK],
      [[branding.phone && `Phone: ${branding.phone}`, branding.email && `Email: ${branding.email}`].filter(Boolean).join('     '), false, MUTED],
    ].filter(([s]) => s);
    const nameH = hOf(company, cw, D.nameSize, true);
    const rowsH = rows.reduce((a, [s, b]) => a + hOf(s, cw, D.text, b) + 1.5, 0);
    const contentH = nameH + 3 + rowsH;
    const h = Math.max(contentH + D.headPad, logo ? D.logoBox : 0, D.headMin);
    cell(L, y, W, h);
    if (logo) {
      const fitH = Math.min(60, h - 14);
      doc.image(logo, L + 10, y + (h - fitH) / 2, { fit: [side - 20, fitH], align: 'center', valign: 'center' });
    }
    let cy = y + (h - contentH) / 2 + 1;
    txt(company, cx, cy, { bold: true, size: D.nameSize, color: ACCENT, width: cw, align: 'center', wrap: true });
    cy += nameH + 3;
    for (const [s, b, color] of rows) {
      txt(s, cx, cy, { bold: b, color, width: cw, align: 'center', wrap: true });
      cy += hOf(s, cw, D.text, b) + 1.5;
    }
    y += h;
  }

  // ── Particulars ───────────────────────────────────────────────
  const half = W / 2;
  const labW = 96;
  const valW = half - labW;
  {
    const ewb = dc.ewaybill || {};
    const eway = ewb.status === 'generated' && ewb.number
      ? `${ewb.number}${ewb.validUpto ? ` (valid till ${ddmmyyyy(ewb.validUpto)})` : ''}`
      : '—';
    const left = [
      ['Challan No.', dc.dcNumber || '—'],
      ['Challan Date', ddmmyyyy(dc.dispatchDate || dc.createdAt)],
      ['Order No.', dc.orderNo != null ? `#${dc.orderNo}` : '—'],
      ['E-way Bill No.', eway],
    ];
    const right = [
      ['Vehicle No.', dc.vehicleNo || ewb.vehicleNo || '—'],
      ['Driver', dc.driverName || '—'],
      ['Transporter', dc.transporter || ewb.transporterName || '—'],
      ['LR No.', dc.lrNumber || ewb.transDocNo || '—'],
    ];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const need = (row) => (row ? hOf(row[1], valW - 2 * PAD, D.text, true) + 6 : 0);
      const h = Math.max(D.row, need(left[i]), need(right[i]));
      for (const [row, x] of [[left[i], L], [right[i], L + half]]) {
        if (row) pair(x, y, labW, valW, h, row[0], row[1]);
        else cell(x, y, half, h);
      }
      y += h;
    }
  }

  // ── Consignee ─────────────────────────────────────────────────
  {
    const headH = D.partyHead;
    cell(L, y, W, headH, HEAD);
    txt('Consignee (Deliver To)', L + PAD, mid(y, headH, D.text, true), { bold: true, color: ACCENT, width: W - 2 * PAD });
    y += headH;
    const pw = half - 2 * PAD;
    const name = dc.customerName || '—';
    const address = dc.customerAddress || '';
    const gstin = String(dc.customerGstin || '').trim();
    const stateCode = /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '';
    const facts = [
      ['GSTIN', gstin || '—'],
      ['State', stateCode ? `${stateName(stateCode)} (${stateCode})` : '—'],
      ['Phone', dc.customerPhone || '—'],
    ];
    const nameH = hOf(name, pw, D.partyName, true);
    const leftH = nameH + 2 + (address ? hOf(address, pw, D.text) : 0);
    const step = lh(D.text, true) + 2;
    const rightH = facts.length * step;
    const h = Math.max(leftH, rightH) + D.partyPad;
    const top = y + D.partyPad / 2;
    cell(L, y, half, h);
    cell(L + half, y, half, h);
    txt(name, L + PAD, top, { bold: true, size: D.partyName, width: pw, wrap: true });
    if (address) txt(address, L + PAD, top + nameH + 2, { width: pw, wrap: true });
    let fy = y + (h - rightH) / 2 + 1;
    for (const [k, v] of facts) {
      txt(k, L + half + PAD, fy, { size: D.label, color: MUTED, width: 50 });
      txt(v, L + half + PAD + 50, fy, { bold: true, width: pw - 50 });
      fy += step;
    }
    y += h;
  }

  // ── Lines ─────────────────────────────────────────────────────
  const hsnOf = (it) => String(it.hsn || it.elastic?.hsn || (dc.type === 'machine_part' ? '' : defaults.defaultHsn || '')).trim();
  const rows = items.map((it, i) => ({
    sno: String(i + 1),
    desc: it.elasticName || it.description || it.elastic?.name || '—',
    hsn: hsnOf(it),
    qty: `${qty(it.quantity)} ${it.unit || ''}`.trim(),
  }));
  const units = [...new Set(items.map((it) => it.unit || ''))];
  const totalQty = items.reduce((a, it) => a + (Number(it.quantity) || 0), 0);
  const totalsRow = {
    desc: `Total  ·  ${items.length} item${items.length === 1 ? '' : 's'}`,
    qty: units.length === 1 ? `${qty(Math.round(totalQty * 1000) / 1000)} ${units[0]}`.trim() : '',
  };
  const showHsn = rows.some((r) => r.hsn);
  const cols = [
    { k: 'sno', h: '#', a: 'center', min: 22 },
    { k: 'desc', h: 'Item & Description', a: 'left', flex: true },
    ...(showHsn ? [{ k: 'hsn', h: 'HSN/SAC', a: 'center', min: 64 }] : []),
    { k: 'qty', h: 'Quantity', a: 'right', num: true, min: 96 },
  ];
  for (const c of cols) {
    if (c.flex) continue;
    const body = Math.max(0, ...rows.map((r) => wOf(r[c.k], D.body, false, c.num)), wOf(totalsRow[c.k] || '', D.body, true, c.num));
    c.w = Math.ceil(Math.max(c.min, Math.max(wOf(c.h, D.headSize, true), body) + 2 * TP + 1));
  }
  cols.find((c) => c.flex).w = W - cols.reduce((a, c) => a + (c.flex ? 0 : c.w), 0);
  const xs = [];
  cols.reduce((x, c) => { xs.push(x); return x + c.w; }, L);
  const descW = cols.find((c) => c.flex).w - 2 * TP;

  const tableHeader = () => {
    const h = D.head;
    fillRect(L, y, W, h, HEAD);
    cols.forEach((c, i) => {
      strokeRect(xs[i], y, c.w, h);
      txt(c.h, xs[i] + TP, mid(y, h, D.headSize, true), { bold: true, size: D.headSize, width: c.w - 2 * TP, align: c.a });
    });
    y += h;
  };
  // Rules go down once a page's rows are in, over the bands.
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
  rows.forEach((r, i) => {
    const textH = hOf(r.desc, descW, D.body);
    const h = Math.max(D.item, textH + D.itemPad);
    if (!room(h)) continueTable();
    if (i % 2 === 1) fillRect(L, y, W, h, BAND);
    cols.forEach((c, k) => {
      if (c.flex) txt(r.desc, xs[k] + TP, y + (h - textH) / 2 + 0.6, { size: D.body, width: descW, wrap: true });
      else txt(r[c.k], xs[k] + TP, mid(y, h, D.body), { size: D.body, width: c.w - 2 * TP, align: c.a, num: c.num });
    });
    y += h;
    rowRules.push(y);
  });
  if (!rows.length) {
    txt('No items.', L + PAD, mid(y, D.item), { color: MUTED, width: W - 2 * PAD });
    y += D.item;
    rowRules.push(y);
  }
  {
    const h = D.item;
    if (!room(h)) continueTable();
    fillRect(L, y, W, h, HEAD);
    cols.forEach((c, k) => {
      const v = totalsRow[c.k];
      if (v) txt(v, xs[k] + TP, mid(y, h, D.body, true), { bold: true, size: D.body, width: c.w - 2 * TP, align: c.flex ? 'right' : c.a, num: c.num });
    });
    y += h;
    rowRules.push(y);
  }
  closeBody();

  // ── The foot, kept together ──────────────────────────────────
  const blocks = [];
  for (const [label, text] of [['Remarks', String(dc.remarks || '').trim()], ['Terms', String(branding.termsText || '').trim()]]) {
    if (!text) continue;
    const tw = W - labW - 2 * PAD;
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
  // Four places to sign, each a dashed box: ours to prepare and check,
  // the receiver's with their seal, and the authorised signatory's.
  {
    const sw = W / 4;
    const h = 5 + 10 + 3 + D.sigBox + 3 + 10 + 4;
    const places = [
      ['', 'Prepared by', false],
      ['', 'Checked by', false],
      ['Goods received in good condition', "Receiver's Signature & Seal", false],
      [`For ${company}`, 'Authorised Signatory', true],
    ];
    blocks.push({ h, draw: () => {
      places.forEach(([top, bottom, strong], i) => {
        const x = L + i * sw;
        cell(x, y, sw, h);
        if (top) txt(top, x + PAD, y + 5, { bold: strong, size: strong ? D.text : 7, color: strong ? INK : MUTED, width: sw - 2 * PAD, align: 'center' });
        const boxTop = y + 5 + 10 + 3;
        doc.save().rect(x + 10, boxTop, sw - 20, D.sigBox).dash(2, { space: 2 }).lineWidth(0.5).strokeColor(GRID).stroke().undash().restore();
        txt(bottom, x + PAD, y + h - 4 - 10, { size: D.label, color: MUTED, width: sw - 2 * PAD, align: 'center' });
      });
      y += h;
    } });
  }
  if (!room(blocks.reduce((a, b) => a + b.h, 0))) newPage();
  for (const b of blocks) {
    if (!room(b.h)) newPage();
    b.draw();
  }
  closeFrame();

  // ── Page line, footer note, the draft or cancelled stamp ─────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 26;
    txt(`${dc.dcNumber || ''}  ·  Page ${i - range.start + 1} of ${range.count}`, L, fy, { size: 7, color: MUTED, width: W, align: 'right' });
    if (branding.footerNote && i === range.start + range.count - 1) {
      txt(branding.footerNote, L, fy, { size: 7, color: MUTED, width: W - 150 });
    }
    if (cancelled || draft) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font(FB).fontSize(72).fillColor(cancelled ? ALERT : DRAFT).opacity(cancelled ? 0.1 : 0.08)
        .text(cancelled ? 'CANCELLED' : 'DRAFT', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
        .opacity(1).restore();
    }
  }

  doc.end();
  return { pages: range.count, done };
}

module.exports = { buildChallanPdf };

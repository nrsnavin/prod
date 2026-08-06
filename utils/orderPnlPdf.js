'use strict';
//
// ORDER P&L — the printed statement.
//
// Pure over the plain object from services/orderPnl.js, so it is
// unit-testable without a database. Returns a Buffer.
//
// Same monochrome ruled form as the challan, purchase order, MRP sheet
// and order status report (utils/sapForm.js): hairline boxes, small-caps
// labels above their values, a grey band on table headers. This one goes
// in a file and gets argued over in a costing meeting, so everything
// that matters is said in bold and in words, never in colour alone.
//
// CURRENCY. Every amount is a bare number under an "(INR)" column
// heading. The rupee sign is deliberately absent: pdfkit's built-in
// Helvetica is WinAnsi-encoded and has no glyph at U+20B9 — it silently
// substitutes the byte for "¹", so "₹1,01,060" prints as "¹1,01,060".
// Naming the currency in the heading is both correct and the convention
// on Indian printed forms.
//
// Sections, in the order a costing meeting asks:
//   1. Result        — value, cost, profit, margin
//   2. Revenue       — what was sold, at what rate
//   3. Cost summary  — the seven elements and their share
//   4. Cost by job   — where the money went inside the order
//   5. Yarn issued   — the biggest line, itemised
//   6. Basis         — the rates this was costed at, so the sheet still
//                      explains itself a year later
//   7. Qualifications — every input that was missing. A P&L that reads
//                      as authoritative while resting on unrecorded cost
//                      is the whole risk with this document.

const PDFDocument = require('pdfkit');
const {
  INK, MUTED, RULE, HEADER_BG, ALERT_BG, ALERT_INK,
  boxLabel, boxValue, box, titleBox, signatureStrip,
} = require('./sapForm');

/** Indian grouping, no symbol, minus sign in front. Never "NaN". */
const _money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = Math.round(Math.abs(v)).toLocaleString('en-IN');
  return v < 0 ? `-${s}` : s;
};

/** Rates and per-meter figures carry the paise. */
const _rate = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return v < 0 ? `-${s}` : s;
};

// Text that arrives from ELSEWHERE — warning strings, elastic names,
// vendor names — and lands on a WinAnsi page. The service writes its
// warnings with a rupee sign, which Helvetica has no glyph for: it
// substitutes the byte for "¹", so "costed at ₹0" printed as
// "costed at ¹0" on the sheet. Everything this file writes itself is
// already ASCII; this catches what it did not write.
const _t = (s) => String(s ?? '—')
  .replace(/\u20B9\s?/g, 'INR ')   // ₹  → INR
  .replace(/\u2212/g, '-');        // −  → -

const _num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-IN') : '—';
};

const _date = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

function _bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// The seven cost elements, with the one-line basis each is computed on.
// Printing the basis beside the figure is what stops the sheet becoming
// an argument about where a number came from.
const COST_ELEMENTS = [
  { key: 'material',  label: 'Yarn issued',         basis: 'Issued quantity x price captured at issue' },
  { key: 'labour',    label: 'Wages',               basis: 'Scheduled shift hours x operator hourly rate' },
  { key: 'jobWork',   label: 'Outsourced job-work', basis: 'Vendor rate x meters returned' },
  { key: 'finishing', label: 'Finishing',           basis: 'Rate card per meter, or the job\'s own figure' },
  { key: 'checking',  label: 'Checking',            basis: 'Rate card per meter, or the job\'s own figure' },
  { key: 'packing',   label: 'Packing',             basis: 'Rate card per meter, or the job\'s own figure' },
  { key: 'overhead',  label: 'Overhead',            basis: 'Power, rent and depreciation per meter' },
];

/**
 * @param {object} data  the object from services/orderPnl.js, plus an
 *                       optional `branding` from services/documentSettings.
 * @returns {Promise<Buffer>}
 */
async function buildOrderPnlPdf(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 60, left: 42, right: 42 },
    bufferPages: true,
  });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  const brand = data.branding || {};
  const order = data.order || {};
  const costs = data.costs || {};
  const totals = data.totals || {};
  const revenue = data.revenue || {};
  const warnings = data.warnings || [];

  // ── Letterhead ──────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
    .text(brand.company || 'Balu Elastics', left, 40, { width: 300, lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text('Order profitability — revenue against yarn, wages, job-work and conversion',
      left, 58, { width: 320, lineBreak: false });

  titleBox(doc, 'ORDER P&L', right - 175, 38, 175);

  const metaY = 70;
  const metaH = 46;
  box(doc, right - 175, metaY, 175, metaH);
  boxLabel(doc, 'Order no', right - 170, metaY + 5, 82);
  boxValue(doc, order.orderNo != null ? `#${order.orderNo}` : '—',
    right - 170, metaY + 15, 82, { bold: true });
  boxLabel(doc, 'Status', right - 84, metaY + 5, 78);
  boxValue(doc, order.status || '—', right - 84, metaY + 15, 78, { bold: true, fontSize: 8 });
  boxLabel(doc, 'Order date / Supply date', right - 170, metaY + 29, 165);
  boxValue(doc, `${_date(order.date)}   ·   ${_date(order.supplyDate)}`,
    right - 170, metaY + 37, 165, { fontSize: 7.5 });

  doc.strokeColor(INK).lineWidth(1.2).moveTo(left, 124).lineTo(right, 124).stroke();

  // ── Customer pane ───────────────────────────────────────────────
  box(doc, left, 134, width, 34);
  boxLabel(doc, 'Customer', left + 6, 140, 300);
  boxValue(doc, order.customerName || '—', left + 6, 150, width - 200,
    { bold: true, fontSize: 10 });
  boxLabel(doc, 'Customer PO', right - 180, 140, 174);
  boxValue(doc, order.po || '—', right - 180, 150, 174, { bold: true });
  doc.y = 176;

  // ── 1. Result ───────────────────────────────────────────────────
  // A loss, or an order with no price at all, gets the wash AND the
  // words — the wash greys out on a mono laser and the words carry it.
  const notPriced = totals.marginPct == null;
  const loss = !notPriced && Number(totals.profit) < 0;
  const flagged = notPriced || loss;

  const resY = doc.y;
  const cellW = width / 4;
  if (flagged) doc.rect(left, resY, width, 42).fill(ALERT_BG);
  box(doc, left, resY, width, 42);
  doc.strokeColor(RULE).lineWidth(0.6);
  for (let i = 1; i < 4; i++) {
    doc.moveTo(left + cellW * i, resY).lineTo(left + cellW * i, resY + 42).stroke();
  }

  const cell = (i, label, value, opts = {}) => {
    const x = left + cellW * i + 6;
    boxLabel(doc, label, x, resY + 6, cellW - 12);
    boxValue(doc, value, x, resY + 17, cellW - 12, { bold: true, fontSize: 12, ...opts });
  };
  cell(0, 'Order value (INR)', _money(revenue.orderValue));
  cell(1, 'Total cost (INR)', _money(costs.total));
  cell(2, 'Profit (INR)', _money(totals.profit),
    { color: loss ? ALERT_INK : INK });
  cell(3, 'Margin',
    notPriced ? 'NOT PRICED' : `${totals.marginPct}%`,
    { color: flagged ? ALERT_INK : INK, fontSize: notPriced ? 10 : 12 });
  doc.y = resY + 50;

  // The headline in words, because the four figures above are the part
  // people photograph and the sentence is the part they act on.
  let verdict;
  if (notPriced) {
    verdict = 'NOT PRICED — no selling rate has been entered on this order, so no margin can be stated. '
      + `Cost incurred so far is INR ${_money(costs.total)}.`;
  } else if (loss) {
    verdict = `LOSS of INR ${_money(Math.abs(totals.profit))} on this order `
      + `(${totals.marginPct}% margin).`;
  } else {
    verdict = `Profit of INR ${_money(totals.profit)} at ${totals.marginPct}% margin `
      + `on ${_num(totals.producedMeters)} m produced.`;
  }
  const vY = doc.y;
  if (flagged) doc.rect(left, vY, width, 20).fill(ALERT_BG);
  box(doc, left, vY, width, 20);
  doc.fillColor(flagged ? ALERT_INK : INK)
    .font(flagged ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(verdict, left + 6, vY + 6, { width: width - 12, lineBreak: false });
  doc.y = vY + 28;

  // ── Shared table machinery ──────────────────────────────────────
  // One implementation for every section, so the grids line up and each
  // one paginates the same way. Mirrors utils/orderStatusPdf.js.
  const pad = 5;
  const rowH = 18;

  function drawTable({ title, cols, rows, totalRow, emptyText, note }) {
    const colX = [];
    let acc = left;
    for (const c of cols) { colX.push(acc); acc += c.w * width; }

    // pdfkit's `ellipsis` option is a no-op alongside `lineBreak: false`
    // — it simply clips, and the reader has no way to know a name lost
    // its tail. Measure and mark the cut ourselves. Losing the tail
    // silently is how "Sunrise Mills, Erode" and "Sunrise Mills,
    // Tirupur" become the same supplier in a costing meeting.
    //
    // Headings go through it too: one too wide for its column WRAPS out
    // of the grey band and collides with the first row.
    const fit = (text, avail) => {
      if (doc.widthOfString(text) <= avail) return text;
      let cut = text;
      while (cut.length > 1 && doc.widthOfString(`${cut}…`) > avail) {
        cut = cut.slice(0, -1);
      }
      return `${cut.trimEnd()}…`;
    };

    const header = (hy) => {
      doc.rect(left, hy, width, rowH).fill(HEADER_BG);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
      cols.forEach((c, i) => {
        doc.text(fit(c.label, c.w * width - pad * 2), colX[i] + pad, hy + 5,
          { width: c.w * width - pad * 2, align: c.align || 'left', lineBreak: false });
      });
      return hy + rowH;
    };
    const close = (top, bottom) => {
      doc.strokeColor(RULE).lineWidth(0.7).rect(left, top, width, bottom - top).stroke();
      doc.lineWidth(0.5).strokeColor(RULE);
      for (let i = 1; i < cols.length; i++) {
        doc.moveTo(colX[i], top).lineTo(colX[i], bottom).stroke();
      }
    };

    // A section title stranded at the foot of a page, with its table
    // starting overleaf, is how these sheets get misread.
    if (doc.y + rowH * 3 > bottomLimit - 90) doc.addPage();

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7)
      .text(title, left, doc.y, { lineBreak: false });
    let y = doc.y + 11;
    let segTop = y;
    y = header(y);

    const writeRow = (cells, opts = {}) => {
      if (y + rowH > bottomLimit - 90) {
        close(segTop, y);
        doc.addPage();
        segTop = doc.page.margins.top;
        y = header(segTop);
      }
      if (opts.wash) doc.rect(left, y, width, rowH).fill(opts.wash);
      cols.forEach((c, i) => {
        doc.fillColor(opts.ink || INK)
          .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(c.fontSize || 8)
          .text(fit(_t(cells[c.key]), c.w * width - pad * 2), colX[i] + pad, y + 5,
            { width: c.w * width - pad * 2, align: c.align || 'left', lineBreak: false });
      });
      doc.strokeColor(RULE).lineWidth(0.5)
        .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
      y += rowH;
    };

    if (!rows.length) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(emptyText, left + pad, y + 5, { width: width - pad * 2, lineBreak: false });
      y += rowH;
    } else {
      rows.forEach((r) => writeRow(r.cells, r));
    }
    if (totalRow) writeRow(totalRow, { bold: true, wash: HEADER_BG });

    close(segTop, y);
    doc.y = y + (note ? 3 : 12);

    if (note) {
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
        .text(note, left, doc.y, { width, lineBreak: false });
      doc.y += 14;
    }
  }

  // ── 2. Revenue ──────────────────────────────────────────────────
  const inv = revenue.invoiced || {};
  drawTable({
    title: 'REVENUE',
    cols: [
      { key: 'name',     label: 'Elastic',        w: 0.46 },
      { key: 'quantity', label: 'Ordered (m)',    w: 0.18, align: 'right' },
      { key: 'rate',     label: 'Rate (INR/m)',   w: 0.18, align: 'right' },
      { key: 'amount',   label: 'Amount (INR)',   w: 0.18, align: 'right' },
    ],
    rows: (revenue.lines || []).map((l) => ({
      // An unpriced line is the difference between "this order lost
      // money" and "nobody typed the price in", so it is marked.
      bold: l.quantity > 0 && !(l.rate > 0),
      wash: l.quantity > 0 && !(l.rate > 0) ? ALERT_BG : undefined,
      cells: {
        name: l.quantity > 0 && !(l.rate > 0) ? `${l.name}   (not priced)` : l.name,
        quantity: _num(l.quantity),
        rate: l.rate > 0 ? _rate(l.rate) : '—',
        amount: _money(l.amount),
      },
    })),
    totalRow: {
      name: 'ORDER VALUE',
      quantity: _num(totals.orderedQuantity),
      rate: '',
      amount: _money(revenue.orderValue),
    },
    emptyText: 'No elastic lines on this order.',
    // Invoiced sits BESIDE the order value, never instead of it: an
    // order that has not dispatched has still spent real money.
    note: inv.challans
      ? `Invoiced so far: INR ${_money(inv.amount)} across ${inv.challans} delivery challan(s), `
        + `${_num(inv.quantity)} m dispatched. The order value above is what the order is worth in full.`
      : 'Nothing dispatched yet — no delivery challan has been raised against this order.',
  });

  // ── 3. Cost summary ─────────────────────────────────────────────
  const totalCost = Number(costs.total) || 0;
  drawTable({
    title: 'COST SUMMARY',
    cols: [
      { key: 'element', label: 'Cost element',  w: 0.24 },
      { key: 'basis',   label: 'Basis',         w: 0.46, fontSize: 7.5 },
      { key: 'amount',  label: 'Amount (INR)',  w: 0.18, align: 'right' },
      { key: 'share',   label: 'Share',         w: 0.12, align: 'right' },
    ],
    rows: COST_ELEMENTS.map((e) => {
      const amount = Number(costs[e.key]) || 0;
      return {
        cells: {
          element: e.label,
          basis: e.basis,
          amount: _money(amount),
          share: totalCost > 0 ? `${Math.round((amount / totalCost) * 100)}%` : '—',
        },
      };
    }),
    totalRow: {
      element: 'TOTAL COST',
      basis: totals.costPerMeter != null
        ? `INR ${_rate(totals.costPerMeter)} per meter produced`
        : 'No production recorded against this order',
      amount: _money(costs.total),
      share: '100%',
    },
    emptyText: 'No cost recorded.',
  });

  // ── 4. Cost by job ──────────────────────────────────────────────
  // Finishing, checking and packing collapse into one CONVERSION column:
  // nine columns is what fits A4 portrait legibly, and the three move
  // together anyway. Their split is on the screen and in section 6.
  drawTable({
    title: 'COST BY JOB',
    cols: [
      { key: 'jobNo',      label: 'Job',            w: 0.09 },
      { key: 'madeBy',     label: 'Made by',        w: 0.21, fontSize: 7 },
      { key: 'produced',   label: 'Produced (m)',   w: 0.12, align: 'right' },
      { key: 'wages',      label: 'Wages',          w: 0.11, align: 'right' },
      { key: 'jobWork',    label: 'Job-work',       w: 0.11, align: 'right' },
      { key: 'conversion', label: 'Conversion',     w: 0.12, align: 'right' },
      { key: 'overhead',   label: 'Overhead',       w: 0.11, align: 'right' },
      { key: 'total',      label: 'Job cost (INR)', w: 0.13, align: 'right' },
    ],
    rows: (data.jobs || []).map((j) => {
      const conversion = (j.finishing?.amount || 0) + (j.checking?.amount || 0)
        + (j.packing?.amount || 0);
      // A job costed off an override rather than the rate card is worth
      // seeing on the sheet — it is the figure someone typed by hand.
      const overridden = [j.finishing, j.checking, j.packing, j.overhead]
        .some((l) => l && l.basis === 'override');
      return {
        cells: {
          jobNo: j.jobNo,
          madeBy: j.productionMode === 'outsource'
            ? (j.outsourceVendor || 'Vendor (unnamed)')
            : `In-house · ${j.labour?.shifts ?? 0} shift(s)`,
          produced: _num(j.producedMeters),
          wages: _money(j.labour?.amount),
          jobWork: _money(j.jobWork),
          conversion: overridden ? `${_money(conversion)} *` : _money(conversion),
          overhead: _money(j.overhead?.amount),
          total: _money(j.total),
        },
      };
    }),
    totalRow: {
      jobNo: 'TOTAL',
      madeBy: '',
      produced: _num(totals.producedMeters),
      wages: _money(costs.labour),
      jobWork: _money(costs.jobWork),
      conversion: _money((costs.finishing || 0) + (costs.checking || 0) + (costs.packing || 0)),
      overhead: _money(costs.overhead),
      total: _money((costs.total || 0) - (costs.material || 0)),
    },
    emptyText: 'No jobs have been raised against this order.',
    note: 'Yarn is drawn against the ORDER at approval, not against a job, so it is not split here — '
      + 'the job costs above exclude it, and the total excludes it too. * costed from a figure entered '
      + 'on the job rather than the rate card.',
  });

  // ── 5. Yarn issued ──────────────────────────────────────────────
  drawTable({
    title: 'YARN ISSUED',
    cols: [
      { key: 'name',      label: 'Material',                w: 0.46 },
      { key: 'quantity',  label: 'Quantity (kg)',           w: 0.18, align: 'right' },
      { key: 'unitPrice', label: 'Price at issue (INR/kg)', w: 0.18, align: 'right' },
      { key: 'amount',    label: 'Amount (INR)',            w: 0.18, align: 'right' },
    ],
    rows: (data.materialLines || []).map((m) => ({
      // Yarn issued at no price is the single biggest way this
      // statement can flatter an order.
      bold: m.quantity > 0 && !(m.unitPrice > 0),
      wash: m.quantity > 0 && !(m.unitPrice > 0) ? ALERT_BG : undefined,
      cells: {
        name: m.name,
        quantity: _num(m.quantity),
        unitPrice: m.unitPrice > 0 ? _rate(m.unitPrice) : 'NO PRICE',
        amount: _money(m.amount),
      },
    })),
    totalRow: {
      name: 'TOTAL YARN',
      quantity: '',
      unitPrice: '',
      amount: _money(costs.material),
    },
    emptyText: 'No raw material has been issued against this order.',
  });

  // ── 6. Basis of costing ─────────────────────────────────────────
  // So the sheet still explains itself when the rate card has moved on.
  const rc = data.rateCard || {};
  if (doc.y + 62 > bottomLimit - 90) doc.addPage();
  const bY = doc.y;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7)
    .text('BASIS OF COSTING', left, bY, { lineBreak: false });
  const bTop = bY + 11;
  box(doc, left, bTop, width, 40);
  const q = width / 4;
  doc.strokeColor(RULE).lineWidth(0.6);
  for (let i = 1; i < 4; i++) {
    doc.moveTo(left + q * i, bTop).lineTo(left + q * i, bTop + 40).stroke();
  }
  const rcCell = (i, label, v) => {
    const x = left + q * i + 6;
    boxLabel(doc, label, x, bTop + 6, q - 12);
    boxValue(doc, `INR ${_rate(v)} / m`, x, bTop + 17, q - 12, { bold: true, fontSize: 9.5 });
  };
  rcCell(0, 'Finishing rate', rc.finishingRatePerMeter);
  rcCell(1, 'Checking rate', rc.checkingRatePerMeter);
  rcCell(2, 'Packing rate', rc.packingRatePerMeter);
  rcCell(3, 'Overhead rate', rc.overheadRatePerMeter);
  doc.y = bTop + 46;

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text('Wages are charged at the operator\'s hourly rate for the full scheduled shift, '
      + 'whether or not the loom ran — the factory pays for the shift either way. '
      + 'Yarn is valued at the price captured when it was issued, not today\'s price.',
      left, doc.y, { width });
  doc.y += 2;

  // ── 7. Qualifications ───────────────────────────────────────────
  // The most important section on the page. Everything the figures rest
  // on that was never recorded, named. Without this the statement reads
  // as authoritative while four of its seven cost lines may be zero.
  if (doc.y + 40 + warnings.length * 12 > bottomLimit - 90) doc.addPage();
  const wY = doc.y + 4;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7)
    .text('QUALIFICATIONS', left, wY, { lineBreak: false });

  const listTop = wY + 11;
  if (warnings.length === 0) {
    box(doc, left, listTop, width, 22);
    doc.fillColor(INK).font('Helvetica').fontSize(8.5)
      .text('None. Every input behind these figures was recorded.',
        left + 6, listTop + 7, { width: width - 12, lineBreak: false });
    doc.y = listTop + 28;
  } else {
    const h = 16 + warnings.length * 12;
    doc.rect(left, listTop, width, h).fill(ALERT_BG);
    box(doc, left, listTop, width, h);
    doc.fillColor(ALERT_INK).font('Helvetica-Bold').fontSize(8);
    warnings.forEach((w, i) => {
      doc.text(`•  ${_t(w)}`, left + 6, listTop + 8 + i * 12,
        { width: width - 12, lineBreak: false });
    });
    doc.y = listTop + h + 8;
  }

  // ── Signature strip ─────────────────────────────────────────────
  const sigY = Math.max(doc.y + 12, bottomLimit - 70);
  signatureStrip(doc, left, sigY, width, ['Prepared by', 'Accounts', 'Approved by']);

  // ── Footer on every page ────────────────────────────────────────
  const range = doc.bufferedPageRange();
  const genLabel = `Generated ${new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Written inside the bottom margin with that margin zeroed, so pdfkit
    // does not read it as overflow and spawn a blank continuation page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - savedBottom + 22;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(genLabel, left, fy, { width: width / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, fy,
      { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  return _bufferFromDoc(doc);
}

module.exports = { buildOrderPnlPdf, COST_ELEMENTS };

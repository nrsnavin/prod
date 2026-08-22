'use strict';
//
// MATERIAL STOCK MOVEMENT LEDGER — the printed sheet.
//
// Pure over the plain object from services/materialLedger.js, so it is
// unit-testable without a database. Returns a Buffer.
//
// Same monochrome ruled form as the challan, purchase order, MRP sheet
// and order status report (utils/sapForm.js): hairline boxes, small-caps
// labels above their values, a grey band on the table header, column
// separators ruled the full height of each page segment. This is the
// sheet a store keeper prints to tally the rack against the system, so
// it goes on a mono laser and nothing may depend on colour alone.
//
// Opening and closing are rows OF the table rather than notes beside it,
// because that is how a stock ledger is read: balance brought forward,
// the movements, balance carried forward — each on its own line so the
// arithmetic can be followed down the page with a finger.

const PDFDocument = require('pdfkit');
const {
  INK, MUTED, RULE, HEADER_BG, ALERT_BG, ALERT_INK,
  boxLabel, boxValue, box, titleBox, signatureStrip,
} = require('./sapForm');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round3 = (v) => Math.round(num(v) * 1000) / 1000;

const _qty = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
};

const _date = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
};

/** "01 Mar 25 — 31 Mar 25", or an honest phrase when an end is open. */
function rangeLabel(range = {}) {
  const { from, to } = range;
  if (!from && !to) return 'All movements to date';
  if (from && !to) return `${_date(from)} onwards`;
  if (!from && to) return `Up to ${_date(to)}`;
  return `${_date(from)} — ${_date(to)}`;
}

function _bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function buildMaterialLedgerPdf(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 60, left: 42, right: 42 },
    // Needed so the footer pass can switchToPage() across every page.
    bufferPages: true,
  });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const brand = data.branding || {};
  const mat = data.material || {};
  const unit = mat.unit || 'kg';

  /**
   * Trim text to fit a column.
   *
   * `lineBreak: false` stops pdfkit wrapping to a second line, but it
   * does NOT stop the glyphs running past the column — a long remark
   * printed straight through the next column's rule and struck out the
   * row beneath it. Measuring and cutting is the only thing that holds
   * the grid.
   */
  const clip = (text, w, { bold = false, size = 8 } = {}) => {
    const str = String(text ?? '');
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    if (doc.widthOfString(str) <= w) return str;
    let cut = str;
    while (cut.length > 1 && doc.widthOfString(`${cut}…`) > w) cut = cut.slice(0, -1);
    return `${cut}…`;
  };

  // ── Letterhead ──────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
    .text(brand.company || 'Balu Elastics', left, 40, { width: 300, lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text('Stock movement ledger — receipts, issues and running balance', left, 58,
      { width: 300, lineBreak: false });

  titleBox(doc, 'STOCK LEDGER', right - 175, 38, 175);

  // Period box, top-right under the title. The period is the single most
  // important thing about this sheet — two prints of the same material
  // are only distinguishable by it — so it gets its own ruled box rather
  // than a line of small print.
  const metaY = 70;
  const metaH = 30;
  box(doc, right - 175, metaY, 175, metaH);
  boxLabel(doc, 'Period', right - 170, metaY + 5, 165);
  boxValue(doc, rangeLabel(data.range), right - 170, metaY + 15, 165,
    { bold: true, fontSize: 8.5, lineBreak: false });

  doc.strokeColor(INK).lineWidth(1.2).moveTo(left, 108).lineTo(right, 108).stroke();

  // ── Material pane ───────────────────────────────────────────────
  // The label sits above its value in its own column, and the value is
  // left-aligned from the same x. An earlier version right-aligned
  // "STOCK TODAY" over a left-aligned number and the two collided.
  const paneY = 118;
  const paneH = 44;
  box(doc, left, paneY, width, paneH);
  boxLabel(doc, 'Material', left + 6, paneY + 6, 300);
  boxValue(doc, mat.name || '—', left + 6, paneY + 16, width - 220,
    { bold: true, fontSize: 10.5, lineBreak: false });
  boxLabel(doc, 'Category', left + 6, paneY + 31, 200);
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(mat.category || '—', left + 52, paneY + 31, { width: 160, lineBreak: false });

  boxLabel(doc, `Stock today (${unit})`, right - 190, paneY + 6, 184);
  boxValue(doc, _qty(data.stockNow), right - 190, paneY + 16, 184,
    { bold: true, fontSize: 10.5, lineBreak: false });

  doc.y = paneY + paneH + 14;

  // ── Summary strip ───────────────────────────────────────────────
  // Four cells: what the period opened at, what came in, what went out,
  // what it closed at. Read left to right it is the whole sheet in one
  // line, which is all most people printing this actually need.
  const t = data.totals || {};
  // Totals IN, not "received". The service separates a supplier receipt
  // from a stock correction, and both are inward rows in the table below
  // — a strip that counted only purchases would foot to a different
  // number than the column directly under it, which on a tally sheet is
  // worse than not breaking them out at all. The distinction is still in
  // the JSON for the screen; here the strip is the table's footing.
  const totalIn = round3(num(t.received) + num(t.adjustedIn));
  const cells = [
    { label: `Opening (${unit})`, value: _qty(data.opening) },
    { label: `Total in (${unit})`, value: _qty(totalIn) },
    { label: `Total out (${unit})`, value: _qty(t.issued) },
    { label: `Closing (${unit})`, value: _qty(data.closing) },
  ];
  const sY = doc.y;
  const sH = 34;
  const cW = width / cells.length;
  doc.rect(left, sY, width, sH).fill(HEADER_BG);
  box(doc, left, sY, width, sH);
  cells.forEach((c, i) => {
    if (i > 0) {
      doc.moveTo(left + i * cW, sY).lineTo(left + i * cW, sY + sH)
        .lineWidth(0.6).strokeColor(RULE).stroke();
    }
    boxLabel(doc, c.label, left + i * cW + 6, sY + 5, cW - 12);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(c.value, left + i * cW + 6, sY + 16, { width: cW - 12, lineBreak: false });
  });
  doc.y = sY + sH + 6;

  // A hand-edited stock figure, or a range that does not run to today,
  // makes the two disagree. Saying so is the honest reading — the
  // movements below do not explain the difference.
  if (Number(data.stockNow) !== Number(data.closing)) {
    const nY = doc.y;
    doc.rect(left, nY, width, 16).fill(ALERT_BG);
    box(doc, left, nY, width, 16);
    doc.fillColor(ALERT_INK).font('Helvetica-Bold').fontSize(7.5)
      .text(
        `Closing balance for this period differs from stock today (${_qty(data.stockNow)} ${unit}) — movements after the period end are not listed on this sheet.`,
        left + 6, nY + 5, { width: width - 12, lineBreak: false }
      );
    doc.y = nY + 22;
  }

  // ── Movement table ──────────────────────────────────────────────
  const pad = 5;
  const rowH = 17;
  const cols = [
    { key: 'date',    label: 'Date',              w: 0.10 },
    { key: 'label',   label: 'Movement',          w: 0.16 },
    { key: 'ref',     label: 'Reference',         w: 0.15 },
    { key: 'details', label: 'Details',           w: 0.23 },
    { key: 'inQty',   label: `In (${unit})`,      w: 0.12, align: 'right' },
    { key: 'outQty',  label: `Out (${unit})`,     w: 0.12, align: 'right' },
    { key: 'balance', label: `Balance (${unit})`, w: 0.12, align: 'right' },
  ];
  const colX = [];
  {
    let acc = left;
    for (const c of cols) { colX.push(acc); acc += c.w * width; }
  }

  const header = (hy) => {
    doc.rect(left, hy, width, rowH).fill(HEADER_BG);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c, i) => {
      doc.text(c.label, colX[i] + pad, hy + 5,
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

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7)
    .text('MOVEMENTS', left, doc.y, { lineBreak: false });
  let y = doc.y + 11;
  let segTop = y;
  y = header(y);

  const writeRow = (cells_, opts = {}) => {
    if (y + rowH > bottomLimit - 30) {
      close(segTop, y);
      doc.addPage();
      segTop = doc.page.margins.top;
      y = header(segTop);
    }
    if (opts.wash) doc.rect(left, y, width, rowH).fill(opts.wash);
    cols.forEach((c, i) => {
      const w = c.w * width - pad * 2;
      const txt = clip(cells_[c.key] ?? '—', w, { bold: opts.bold, size: 8 });
      doc.fillColor(opts.ink || INK)
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8)
        .text(txt, colX[i] + pad, y + 5,
          { width: w, align: c.align || 'left', lineBreak: false });
    });
    doc.strokeColor(RULE).lineWidth(0.5)
      .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  };

  // Balance brought forward.
  writeRow(
    {
      date: '—',
      label: 'Opening balance',
      ref: 'Brought forward',
      // The period goes in Details rather than Reference: Reference is
      // the narrowest text column and clipped the label to "01 Mar 25 —
      // 31…", which reads as a rendering fault rather than a date range.
      details: rangeLabel(data.range),
      inQty: '',
      outQty: '',
      balance: _qty(data.opening),
    },
    { bold: true, wash: HEADER_BG }
  );

  const rows = data.rows || [];
  if (!rows.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text('No stock moved on this material in the selected period.',
        left + pad, y + 5, { width: width - pad * 2, lineBreak: false });
    doc.strokeColor(RULE).lineWidth(0.5)
      .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  } else {
    for (const r of rows) {
      const detail = [r.lotNo && `Lot ${r.lotNo}`, r.remarks].filter(Boolean).join(' · ');
      writeRow({
        date: _date(r.date),
        label: r.label || '—',
        ref: r.reference || '—',
        details: detail || '—',
        inQty: r.direction > 0 ? _qty(r.quantity) : '',
        outQty: r.direction < 0 ? _qty(r.quantity) : '',
        balance: _qty(r.balance),
      });
    }
  }

  // Balance carried forward.
  writeRow(
    {
      date: '—',
      label: 'Closing balance',
      ref: 'Carried forward',
      details: `${rows.length} movement(s)`,
      inQty: _qty(totalIn),
      outQty: _qty(t.issued),
      balance: _qty(data.closing),
    },
    { bold: true, wash: HEADER_BG }
  );

  close(segTop, y);
  doc.y = y + 18;

  // ── Signature strip ─────────────────────────────────────────────
  // Only when it fits. A tally sheet whose signatures were pushed onto a
  // page of their own is a page nobody prints.
  if (doc.y + 52 < bottomLimit) {
    signatureStrip(doc, left, doc.y, width, ['Prepared by', 'Verified by', 'Store in-charge']);
  }

  // ── Footer on every page ────────────────────────────────────────
  const range = doc.bufferedPageRange();
  const genLabel = `Generated ${new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin. Zero the page's bottom
    // margin for the write so pdfkit doesn't treat it as an overflow and
    // spawn a blank continuation page; restore it afterwards.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - savedBottom + 22;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(`${mat.name || 'Material'}  ·  ${genLabel}`, left, fy,
        { width: width / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, fy, {
      width: width / 2, align: 'right', lineBreak: false,
    });
    doc.page.margins.bottom = savedBottom;
  }

  return _bufferFromDoc(doc);
}

module.exports = { buildMaterialLedgerPdf, rangeLabel };

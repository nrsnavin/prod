'use strict';

// ═════════════════════════════════════════════════════════════════
//  Shift production sheet (PDF)
//
//  A4 landscape, paginated. One row per assigned machine, prefilled
//  with QR · Code · Machine ID · Operator · Job No · Shift · Date, and
//  three EMPTY hand-written columns: Production (m) · Timer · Remarks.
//
//  The Code is the last 6 hex of the ShiftDetail id (e.g. SD-8F3A2C)
//  and the QR encodes the full id. On upload the OCR layer maps each
//  row back by that Code (cross-checked against Machine ID / Job No),
//  so a 200-machine plan reconciles exactly with no manual matching.
//
//  buildShiftSheetPdf(plan) -> Promise<Buffer>
//    plan = {
//      dateLabel, shift, planNo,
//      rows: [{ sdId, machine, operator, job }, ...]
//    }
// ═════════════════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

const RED    = '#E23744';
const INK    = '#1C1C1C';
const MUT    = '#6b6b6b';
const LINE   = '#D0D0D0';
const HEADBG = '#F4F4F4';
const FILLBG = '#FBFBFB';

/** Short human/OCR-friendly code for a shift-detail id. */
function shortCode(sdId) {
  return 'SD-' + String(sdId).replace(/[^a-f\d]/gi, '').slice(-6).toUpperCase();
}

async function buildShiftSheetPdf(plan) {
  const rows = Array.isArray(plan.rows) ? plan.rows : [];

  // Pre-render QR buffers once (encode the full id for a future scanner).
  const qrBuffers = await Promise.all(
    rows.map((r) =>
      QRCode.toBuffer(`SHIFTROW|${r.sdId}|M:${r.machine || ''}|J:${r.job || ''}`, {
        margin: 0,
        width: 120,
      })
    )
  );

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const pageW = doc.page.width;   // ~842
  const pageH = doc.page.height;  // ~595
  const left  = 30;
  const right = pageW - 30;

  // Column layout (last column fills remaining width).
  const cols = [
    { key: 'qr',         label: 'QR',            w: 42 },
    { key: 'code',       label: 'Code',          w: 70 },
    { key: 'machine',    label: 'Machine ID',    w: 72 },
    { key: 'operator',   label: 'Operator',      w: 110 },
    { key: 'job',        label: 'Job No',        w: 52 },
    { key: 'shift',      label: 'Shift',         w: 42 },
    { key: 'date',       label: 'Date',          w: 74 },
    { key: 'production',  label: 'Production (m)', w: 96 },
    { key: 'timer',      label: 'Timer (H:M:S)', w: 90 },
    { key: 'remarks',    label: 'Remarks',       w: 0 },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols[cols.length - 1].w = right - left - fixed;
  const colX = (i) => { let x = left; for (let j = 0; j < i; j++) x += cols[j].w; return x; };

  const rowH  = 40;
  const headH = 20;

  // Header + column header, drawn on every page so each scanned sheet
  // carries the plan identity.
  function drawPageHead(pageNo, pageCount) {
    doc.fillColor(RED).rect(left, 30, 6, 24).fill();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text('Shift Production Sheet', left + 14, 32);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUT)
      .text('Jarvis ERP  ·  Elastic Manufacturing', left + 14, 50);

    const meta = [['Date', plan.dateLabel || ''], ['Shift', plan.shift || ''], ['Plan', plan.planNo || '']];
    let my = 30;
    meta.forEach(([k, v]) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUT).text(k, right - 200, my, { width: 60, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(String(v), right - 130, my, { width: 130, align: 'right' });
      my += 13;
    });

    // Instruction strip (first page only).
    let tableTop = 68;
    if (pageNo === 1) {
      doc.roundedRect(left, 66, right - left, 18, 3).fill('#FFF4E0');
      doc.fillColor('#8a5a00').font('Helvetica').fontSize(8).text(
        'Write PRODUCTION (metres), TIMER (H:M:S) and REMARKS in ink. Do not alter the Code / QR — they identify each row for scanning.',
        left + 8, 70, { width: right - left - 16 }
      );
      tableTop = 90;
    }

    // Column header row.
    doc.rect(left, tableTop, right - left, headH).fill(HEADBG);
    cols.forEach((c, i) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
        .text(c.label.toUpperCase(), colX(i) + 4, tableTop + 6, { width: c.w - 8 });
    });
    return tableTop + headH;
  }

  function drawGrid(top, n) {
    const bottom = top + n * rowH;
    doc.lineWidth(0.6).strokeColor(LINE);
    let vx = left;
    for (let i = 0; i <= cols.length; i++) {
      doc.moveTo(vx, top - headH).lineTo(vx, bottom).stroke();
      if (i < cols.length) vx += cols[i].w;
    }
    for (let ri = 0; ri <= n; ri++) {
      const y = top + ri * rowH;
      doc.moveTo(left, y).lineTo(right, y).stroke();
    }
    doc.moveTo(left, top - headH).lineTo(right, top - headH).stroke();
    return bottom;
  }

  // Paginate — precompute exact page ranges so the footer total is
  // correct. Page 1 holds fewer rows (instruction strip); the top of
  // the table is deterministic per page (110 with strip, 88 without).
  // Leave room below the last row for the footer line; if rows run to
  // the very bottom margin pdfkit auto-inserts a blank page.
  const bottomLimit = pageH - 62;
  const capFor = (pageNo) => Math.max(1, Math.floor((bottomLimit - (pageNo === 1 ? 110 : 88)) / rowH));
  const pages = [];
  let idx = 0;
  do {
    const cap = capFor(pages.length + 1);
    pages.push({ start: idx, count: Math.min(cap, rows.length - idx) });
    idx += cap;
  } while (idx < rows.length);
  const pageCount = pages.length;

  pages.forEach((pg, p) => {
    const pageNo = p + 1;
    if (pageNo > 1) doc.addPage();
    const top = drawPageHead(pageNo, pageCount);
    const i = pg.start;
    const pageRows = rows.slice(pg.start, pg.start + pg.count);

    pageRows.forEach((r, ri) => {
      const y = top + ri * rowH;
      doc.rect(left, y, right - left, rowH).fill(ri % 2 ? '#FFFFFF' : FILLBG);
      const put = (ci, val, opts = {}) => {
        doc.fillColor(opts.color || INK).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8.5)
          .text(String(val ?? ''), colX(ci) + 4, y + rowH / 2 - 5, { width: cols[ci].w - 8 });
      };
      // QR + prefilled cells.
      const globalIdx = i + ri;
      doc.image(qrBuffers[globalIdx], colX(0) + (cols[0].w - 26) / 2, y + (rowH - 26) / 2, { width: 26, height: 26 });
      put(1, shortCode(r.sdId), { size: 8, color: MUT, bold: true });
      put(2, r.machine, { bold: true });
      put(3, r.operator);
      put(4, r.job);
      put(5, plan.shift);
      put(6, plan.dateLabel, { size: 8 });
      // Empty writable columns — a baseline to write on.
      [7, 8, 9].forEach((ci) => {
        const bx = colX(ci);
        doc.moveTo(bx + 6, y + rowH - 11).lineTo(bx + cols[ci].w - 6, y + rowH - 11).lineWidth(0.5).stroke('#B8B8B8');
      });
    });

    const bottom = drawGrid(top, pageRows.length);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUT).text(
      `Supervisor sign: __________________     Verified by: __________________     Page ${pageNo} of ${pageCount}`,
      left, bottom + 10, { width: right - left }
    );
  });

  doc.end();
  return done;
}

module.exports = { buildShiftSheetPdf, shortCode };

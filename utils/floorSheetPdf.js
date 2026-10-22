'use strict';

// ═════════════════════════════════════════════════════════════════
//  Floor production sheet (PDF) — no shift plan needed
//
//  Every machine on the floor, one row each, with the job it is running
//  or FREE. Operator, Timer, Production, a signature box and Remarks
//  are left blank for the floor to fill by hand; each row carries a QR.
//
//  The header carries a sheet number, FS-20261021-D (date, then D for
//  day or N for night), which is how a photo of the filled sheet finds
//  its shift. If that shift has no plan yet, the app offers to create
//  one from the sheet — machine by machine, operator by name — and the
//  figures written on it become the shift's production draft
//  (services/slipIngest.js).
//
//  buildFloorSheetPdf(sheet) -> Promise<Buffer>
//    sheet = {
//      sheetNo, dateLabel, shift,
//      rows: [{ machineId, machine, job, detail, status, loading }, ...],
//      branding
//    }
//    job: "J-12" or null (free); detail: a short line under it (the elastic)
// ═════════════════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

const RED    = '#E23744';
const INK    = '#1C1C1C';
const MUT    = '#6b6b6b';
const LINE   = '#D0D0D0';
const HEADBG = '#F4F4F4';
const FILLBG = '#FBFBFB';
const FREE   = '#2E7D32';

async function buildFloorSheetPdf(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];

  const qrBuffers = [];
  for (const r of rows) {
    qrBuffers.push(await QRCode.toBuffer(
      `FLOORROW|${sheet.sheetNo || ''}|M:${r.machine || ''}|${r.machineId || ''}`,
      { margin: 0, width: 120 }
    ));
  }

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left  = 30;
  const right = pageW - 30;

  const cols = [
    { key: 'qr',         label: 'QR',                   w: 44 },
    { key: 'machine',    label: 'Machine ID',           w: 72 },
    { key: 'job',        label: 'Job',                  w: 140 },
    { key: 'operator',   label: 'Operator',       w: 132 },
    { key: 'timer',      label: 'Timer (H:M:S)',  w: 84 },
    { key: 'production', label: 'Production (m)', w: 84 },
    // A box to initial, not a line to sign along: the width goes to remarks.
    { key: 'sign',       label: 'Sign',           w: 56 },
    { key: 'remarks',    label: 'Remarks',        w: 0 },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols[cols.length - 1].w = right - left - fixed;
  const colX = (i) => { let x = left; for (let j = 0; j < i; j++) x += cols[j].w; return x; };

  const rowH  = 38;
  const headH = 20;

  function drawPageHead(pageNo) {
    const brand = sheet.branding || {};
    const accent = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(brand.accent || '') ? brand.accent : RED;
    const strip = [brand.company || 'Balu Elastics', brand.tagline || 'Elastic Manufacturing']
      .filter(Boolean).join('  ·  ');
    doc.fillColor(accent).rect(left, 30, 6, 24).fill();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text('Floor Production Sheet', left + 14, 32);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUT).text(strip, left + 14, 50);

    const meta = [['Sheet', sheet.sheetNo || ''], ['Date', sheet.dateLabel || ''], ['Shift', sheet.shift || '']];
    let my = 30;
    meta.forEach(([k, v]) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUT).text(k, right - 200, my, { width: 60, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(String(v), right - 130, my, { width: 130, align: 'right' });
      my += 13;
    });

    let tableTop = 72;
    if (pageNo === 1) {
      doc.roundedRect(left, 70, right - left, 18, 3).fill('#FFF4E0');
      doc.fillColor('#8a5a00').font('Helvetica').fontSize(8).text(
        'Write the OPERATOR, TIMER (H:M:S), PRODUCTION (metres) and any REMARKS in ink; the supervisor initials each row. '
          + 'Leave a FREE machine blank. Photograph the sheet into Production Slips (or WhatsApp) to draft the shift.',
        left + 8, 74, { width: right - left - 16 }
      );
      tableTop = 94;
    }

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

  // Page ranges worked out first, so "Page x of y" is right. Room is
  // left under the last row for the footer, or pdfkit adds a blank page.
  const bottomLimit = pageH - 62;
  const capFor = (pageNo) => Math.max(1, Math.floor((bottomLimit - (pageNo === 1 ? 114 : 92)) / rowH));
  const pages = [];
  let idx = 0;
  do {
    const cap = capFor(pages.length + 1);
    pages.push({ start: idx, count: Math.min(cap, rows.length - idx) });
    idx += cap;
  } while (idx < rows.length);
  const pageCount = pages.length;
  const running = rows.filter((r) => r.job).length;

  pages.forEach((pg, p) => {
    const pageNo = p + 1;
    if (pageNo > 1) doc.addPage();
    const top = drawPageHead(pageNo);
    const pageRows = rows.slice(pg.start, pg.start + pg.count);

    pageRows.forEach((r, ri) => {
      const y = top + ri * rowH;
      doc.rect(left, y, right - left, rowH).fill(ri % 2 ? '#FFFFFF' : FILLBG);
      doc.image(qrBuffers[pg.start + ri], colX(0) + (cols[0].w - 28) / 2, y + (rowH - 28) / 2, { width: 28, height: 28 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
        .text(String(r.machine ?? ''), colX(1) + 4, y + rowH / 2 - 6, { width: cols[1].w - 8 });

      if (r.job) {
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
          .text(r.job, colX(2) + 4, y + (r.detail ? 8 : rowH / 2 - 5), { width: cols[2].w - 8 });
        // Still being loaded for the job: nothing is woven yet.
        if (r.loading) {
          doc.fillColor('#8a5a00').font('Helvetica-Oblique').fontSize(8)
            .text('(loading)', colX(2) + 4 + doc.widthOfString(r.job, { font: 'Helvetica-Bold', size: 9.5 }) + 10,
              y + (r.detail ? 9 : rowH / 2 - 4));
        }
        if (r.detail) {
          doc.fillColor(MUT).font('Helvetica').fontSize(7)
            .text(r.detail, colX(2) + 4, y + 21, { width: cols[2].w - 8, height: 9, ellipsis: true });
        }
      } else {
        doc.fillColor(FREE).font('Helvetica-Bold').fontSize(10)
          .text('FREE', colX(2) + 4, y + rowH / 2 - 6, { width: cols[2].w - 8 });
        if (r.status === 'maintenance') {
          doc.fillColor(MUT).font('Helvetica').fontSize(7).text('under maintenance', colX(2) + 40, y + rowH / 2 - 3);
        }
      }

      // A baseline to write on in each blank column.
      [3, 4, 5, 6, 7].forEach((ci) => {
        const bx = colX(ci);
        doc.moveTo(bx + 6, y + rowH - 10).lineTo(bx + cols[ci].w - 6, y + rowH - 10).lineWidth(0.5).stroke('#B8B8B8');
      });
    });

    const bottom = drawGrid(top, pageRows.length);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUT).text(
      `${rows.length} machines · ${running} running · ${rows.length - running} free`
        + `     Shift supervisor: __________________     Page ${pageNo} of ${pageCount}`,
      left, bottom + 10, { width: right - left }
    );
  });

  doc.end();
  return done;
}

/** "FS-20261021-D" for a date key and shift. */
function floorSheetNo(dateKey, shift) {
  return `FS-${String(dateKey).replace(/-/g, '')}-${shift === 'NIGHT' ? 'N' : 'D'}`;
}

module.exports = { buildFloorSheetPdf, floorSheetNo };

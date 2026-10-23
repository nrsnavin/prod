'use strict';

// ═════════════════════════════════════════════════════════════════
//  Machine QR labels (PDF)
//
//  One label per loom, to stick on it: a QR that the floor-entry
//  screen scans, with the machine ID large enough to read across the
//  aisle, the manufacturer and the hooks / heads under it. A4 portrait,
//  three across, four down, cut along the grid.
//
//  The QR carries MACHINE|<id>|<ID> — the id is what the scan resolves,
//  the ID is there so a phone's own camera app shows something a person
//  recognises.
//
//  buildMachineLabelsPdf({ machines: [{ id, ID, manufacturer, hooks, heads }], branding })
// ═════════════════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const INK = '#1C1C1C';
const MUT = '#6b6b6b';
const LINE = '#C8C8C8';

const COLS = 3;
const ROWS = 4;

async function buildMachineLabelsPdf({ machines = [], branding = {} } = {}) {
  const qr = [];
  for (const m of machines) {
    qr.push(await QRCode.toBuffer(`MACHINE|${m.id}|${m.ID}`, { margin: 0, width: 300, errorCorrectionLevel: 'M' }));
  }

  const doc = new PDFDocument({ size: 'A4', margin: 24 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = 24;
  const top = 24;
  const w = (doc.page.width - left * 2) / COLS;
  const h = (doc.page.height - top * 2) / ROWS;
  const company = branding.company || 'Balu Elastics';
  const perPage = COLS * ROWS;

  if (!machines.length) {
    doc.fillColor(MUT).font('Helvetica').fontSize(11).text('No machines to label.', left, top);
  }

  machines.forEach((m, i) => {
    const slot = i % perPage;
    if (i > 0 && slot === 0) doc.addPage();
    const x = left + (slot % COLS) * w;
    const y = top + Math.floor(slot / COLS) * h;

    doc.lineWidth(0.5).strokeColor(LINE).dash(3, { space: 3 }).rect(x, y, w, h).stroke().undash();

    const qrSize = Math.min(w, h) * 0.52;
    doc.image(qr[i], x + (w - qrSize) / 2, y + 14, { width: qrSize, height: qrSize });

    let ty = y + 14 + qrSize + 10;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22)
      .text(String(m.ID ?? ''), x + 8, ty, { width: w - 16, align: 'center' });
    ty += 28;
    doc.fillColor(MUT).font('Helvetica').fontSize(9)
      .text(m.manufacturer || ' ', x + 8, ty, { width: w - 16, align: 'center' });
    ty += 13;
    const spec = [m.hooks != null ? `${m.hooks} hooks` : null, m.heads != null ? `${m.heads} heads` : null].filter(Boolean).join(' · ');
    doc.fillColor(INK).font('Helvetica').fontSize(10)
      .text(spec || ' ', x + 8, ty, { width: w - 16, align: 'center' });
    doc.fillColor(MUT).font('Helvetica').fontSize(6.5)
      .text(company, x + 8, y + h - 14, { width: w - 16, align: 'center' });
  });

  doc.end();
  return done;
}

module.exports = { buildMachineLabelsPdf };

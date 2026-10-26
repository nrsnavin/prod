'use strict';
// ══════════════════════════════════════════════════════════════════
//  COVERING BEAM LABELS (PDF)
//
//  One label a weighed beam, to tie on it: the job, the beam number and
//  its weight large enough to read across the floor, the elastic, the
//  customer, the date it was weighed, and a QR the scanners read
//  (COVB|J:<job>|C:<covering>|B:<beam>|E:<entry> — the same payload the
//  screen's labels always carried). A4, two across, five down, cut on
//  the dashed lines. Printed from the server, so the label is the same
//  whichever browser prints it.
//
//  buildCoveringBeamLabelsPdf({ jobOrderNo, coveringId, customerName,
//    elasticName, beams: [{ entryId, beamNo, weight, note, dateLabel }], branding })
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const INK = '#111111';
const MUTED = '#555555';
const LINE = '#BBBBBB';
const COLS = 2;
const ROWS = 5;
const MARGIN = 28;

const kg = (n) => (Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(2));

/** Text cut to its width with an ellipsis, never wrapped onto the next line. */
function fit(doc, text, width) {
  const t = String(text ?? '');
  if (doc.widthOfString(t) <= width) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${t.slice(0, mid)}…`) <= width) lo = mid; else hi = mid - 1;
  }
  return `${t.slice(0, lo)}…`;
}

const payloadOf = (d, b) => `COVB|J:${d.jobOrderNo ?? '—'}|C:${d.coveringId}|B:${b.beamNo}|E:${b.entryId || ''}`;

async function buildCoveringBeamLabelsPdf(data = {}) {
  const beams = data.beams || [];
  const qrs = [];
  for (const b of beams) qrs.push(await QRCode.toBuffer(payloadOf(data, b), { margin: 0, width: 240, errorCorrectionLevel: 'M' }));

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const w = (doc.page.width - MARGIN * 2) / COLS;
  const h = (doc.page.height - MARGIN * 2) / ROWS;
  const perPage = COLS * ROWS;
  const company = data.branding?.company || 'Balu Elastics';

  if (!beams.length) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(11).text('No beams weighed yet — nothing to label.', MARGIN, MARGIN);
  }

  beams.forEach((b, i) => {
    const slot = i % perPage;
    if (i > 0 && slot === 0) doc.addPage();
    const x = MARGIN + (slot % COLS) * w;
    const y = MARGIN + Math.floor(slot / COLS) * h;
    const pad = 10;

    // Cut lines, then the label's own heavy border inside them.
    doc.lineWidth(0.5).strokeColor(LINE).dash(3, { space: 3 }).rect(x, y, w, h).stroke().undash();
    doc.lineWidth(1.6).strokeColor(INK).rect(x + 5, y + 5, w - 10, h - 10).stroke();

    const ix = x + 5 + pad;
    const iw = w - 10 - pad * 2;
    let ty = y + 5 + pad;

    // Header: what this is, and whose.
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9);
    doc.text(fit(doc, `COVERING BEAM · JOB J-${data.jobOrderNo ?? '—'}`, iw * 0.6), ix, ty, { width: iw * 0.6, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5);
    doc.text(fit(doc, data.customerName || '', iw * 0.4), ix + iw * 0.6, ty, { width: iw * 0.4, align: 'right', lineBreak: false });
    ty += 13;
    doc.lineWidth(0.6).strokeColor(LINE).moveTo(ix, ty).lineTo(ix + iw, ty).stroke();
    ty += 8;

    // The beam number and the weight, large.
    const qrSize = 62;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('BEAM', ix, ty, { width: 60, lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(34).text(String(b.beamNo), ix, ty + 8, { width: 80, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('WEIGHT', ix + 90, ty, { width: 100, lineBreak: false });
    // As large as fits beside the QR: "1,250.75 kg" and "9 kg" both on one line.
    const weightText = `${kg(b.weight)} kg`;
    const weightW = iw - 90 - qrSize - 6;
    let size = 24;
    doc.font('Helvetica-Bold');
    while (size > 10 && doc.fontSize(size).widthOfString(weightText) > weightW) size -= 1;
    doc.fillColor(INK).fontSize(size).text(weightText, ix + 90, ty + 12 + (24 - size) / 2, { width: weightW + 2, lineBreak: false });
    doc.image(qrs[i], ix + iw - qrSize, ty, { width: qrSize, height: qrSize });
    ty += qrSize + 6;

    // The elastic, the date, a note.
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10);
    doc.text(fit(doc, data.elasticName || '', iw), ix, ty, { width: iw, lineBreak: false });
    ty += 14;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    doc.text(fit(doc, [b.dateLabel ? `Weighed ${b.dateLabel}` : null, b.note || null].filter(Boolean).join(' · '), iw), ix, ty, { width: iw, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
      .text(company, ix, y + h - 5 - pad - 7, { width: iw, align: 'right', lineBreak: false });
  });

  doc.end();
  return done;
}

module.exports = { buildCoveringBeamLabelsPdf, payloadOf };

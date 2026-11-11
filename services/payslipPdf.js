'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PRINTED PAYSLIP
//
//  Drawn here, away from the route that serves it. The route used to
//  hold all of this between finding the slip and sending it: two hundred
//  lines of page layout in the middle of the payroll API. The route now
//  finds the slip and names the file; this draws the page.
//
//    writePayslip(slip, { year, month }, out)
//
//  `slip` is the stored payslip with its employee filled in; `out` is
//  whatever the PDF is written to (the HTTP response).
//
//  Lines that explain a figure without being one — pay lost to an
//  absence, a late cut the shift line already carries — are printed in
//  brackets and left out of the Total row (utils/payslipLines.js).
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { isMemoLine, moneyLines, isWriteOffLine } = require('../utils/payslipLines');
const { latin1 } = require('../utils/pdfLatin');
const { drawLine, hasOtherScript } = require('../utils/pdfScripts');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rupee = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "payslip-Ravi_Kumar-June-2026.pdf", and the name to fall back on when that cannot be sent. */
function payslipFileName(p, { year, month }) {
  return {
    name: `payslip-${(p.employee?.name || 'employee').replace(/\s+/g, '_')}-${MONTHS[month - 1]}-${year}.pdf`,
    fallback: `payslip-${MONTHS[month - 1]}-${year}.pdf`,
  };
}

function writePayslip(p, { year, month }, out) {
  const MONTHS_PDF = MONTHS;
  // ── Printable payslip: A4, uniform margins, ruled tables ───
  const M = 50;                               // uniform page margin (all sides)
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  doc.pipe(out);

  const W     = doc.page.width;
  const H     = doc.page.height;
  const RIGHT = W - M;
  const CW    = W - 2 * M;                    // content width
  const BOTTOM = H - M - 28;                  // keep clear of the footer

  const INK   = '#1A1D24';
  const MUTE  = '#6B7280';
  const LINE  = '#C9CDD6';                    // table rules (print-safe grey)
  const HAIR  = '#E5E7EB';                    // inner row rules
  const HEAD  = '#F1F3F7';                    // table header fill
  const NEG   = '#B42318';

  // Only what the built-in font can print (utils/pdfLatin.js).
  const clean = latin1;
  // A name or department as written — in Tamil or Hindi too, which is
  // drawn in a font that has it (utils/pdfScripts.js) — or a dash when
  // there is nothing of it that can be printed.
  const asWritten = (v) => (hasOtherScript(v) || clean(v) ? String(v) : '-');

  let y = M;

  // ── Title bar ──────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
     .text('PAYSLIP', M, y, { characterSpacing: 1 });
  doc.font('Helvetica').fontSize(10).fillColor(MUTE)
     .text(`${MONTHS_PDF[month - 1]} ${year}`, M, y + 20);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTE)
     .text(clean((p.status || 'draft').replace('_', ' ')).toUpperCase(),
           RIGHT - 160, y + 4, { width: 160, align: 'right', characterSpacing: 1 });
  y += 40;
  doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(1.2).strokeColor(INK).stroke();
  y += 16;

  // ── Employee details table (2 columns of label/value) ──────
  const detail = [
    ['Employee',    asWritten(p.employee?.name)],
    ['Department',  asWritten(p.employee?.department)],
    ['Hourly rate', rupee(p.hourlyRate)],
    ['Shifts',      `${p.presentShifts ?? 0} present / ${p.absentShifts ?? 0} absent / ${p.approvedLeaveShifts ?? 0} leave`],
  ];
  const dRowH = 20, dCol = CW / 2, dLabW = 78;
  const dRows = Math.ceil(detail.length / 2);
  doc.lineWidth(0.6).strokeColor(LINE);
  doc.rect(M, y, CW, dRowH * dRows).stroke();
  detail.forEach(([lab, val], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * dCol, ry = y + row * dRowH;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTE)
       .text(lab.toUpperCase(), x + 8, ry + 6.5, { width: dLabW });
    drawLine(doc, val, x + 8 + dLabW, ry + 5.5, { bold: true, size: 9.5, width: dCol - dLabW - 16, color: INK });
  });
  for (let r = 1; r < dRows; r++)
    doc.moveTo(M, y + r * dRowH).lineTo(RIGHT, y + r * dRowH).lineWidth(0.5).strokeColor(HAIR).stroke();
  doc.moveTo(M + dCol, y).lineTo(M + dCol, y + dRowH * dRows).lineWidth(0.5).strokeColor(HAIR).stroke();
  y += dRowH * dRows + 20;

  // ── Earnings & deductions table ────────────────────────────
  // Columns: description | earnings | deductions
  const C2 = 110, C3 = 110;                   // amount column widths
  const C1 = CW - C2 - C3;
  const X1 = M, X2 = M + C1, X3 = M + C1 + C2;
  const ROW = 19, HEADH = 22;

  const tableHeader = () => {
    doc.rect(M, y, CW, HEADH).fillAndStroke(HEAD, LINE);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
    doc.text('DESCRIPTION', X1 + 8, y + 7, { width: C1 - 16 });
    doc.text('EARNINGS',    X2 + 8, y + 7, { width: C2 - 16, align: 'right' });
    doc.text('DEDUCTIONS',  X3 + 8, y + 7, { width: C3 - 16, align: 'right' });
    y += HEADH;
  };
  const vRules = (fromY, toY) => {
    doc.lineWidth(0.5).strokeColor(LINE);
    [M, X2, X3, RIGHT].forEach((x) => doc.moveTo(x, fromY).lineTo(x, toY).stroke());
  };

  tableHeader();
  let secTop = y;
  let anyMemo = false;
  for (const li of p.lineItems || []) {
    if (y + ROW > BOTTOM) {                   // page break: close + repeat header
      vRules(secTop, y);
      doc.addPage(); y = M; tableHeader(); secTop = y;
    }
    const neg = li.amount < 0;
    // A line that explains is printed in brackets and left out of the
    // totals: it took nothing off (utils/payslipLines.js).
    const memo = isMemoLine(li);
    if (memo) anyMemo = true;
    doc.font('Helvetica').fontSize(9).fillColor(memo ? MUTE : INK)
       .text(clean(li.label), X1 + 8, y + 5.5, { width: C1 - 16, ellipsis: true, lineBreak: false });
    doc.fillColor(memo ? MUTE : neg ? NEG : INK)
       .text(memo ? `(${rupee(Math.abs(li.amount))})` : rupee(Math.abs(li.amount)), neg ? X3 + 8 : X2 + 8, y + 5.5,
             { width: (neg ? C3 : C2) - 16, align: 'right' });
    y += ROW;
    doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.4).strokeColor(HAIR).stroke();
  }
  // Column totals row
  const counted   = moneyLines(p.lineItems);
  const totalEarn = counted.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalDed  = counted.filter(l => l.amount < 0).reduce((s, l) => s - l.amount, 0);
  if (y + ROW + 4 > BOTTOM) { vRules(secTop, y); doc.addPage(); y = M; tableHeader(); secTop = y; }
  doc.rect(M, y, CW, ROW + 3).fillAndStroke(HEAD, LINE);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
  doc.text('Total', X1 + 8, y + 6, { width: C1 - 16 });
  doc.text(rupee(totalEarn), X2 + 8, y + 6, { width: C2 - 16, align: 'right' });
  doc.text(rupee(totalDed),  X3 + 8, y + 6, { width: C3 - 16, align: 'right' });
  y += ROW + 3;
  vRules(secTop, y);
  if (anyMemo) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
       .text('Figures in brackets explain pay that was not earned. They are already left out of the lines above them and are not taken off again.',
             M, y + 5, { width: CW });
    y += 12;
  }
  y += 20;

  // ── Summary table ──────────────────────────────────────────
  const sum = [
    ['Gross earnings',   rupee(p.grossEarnings)],
    ['Total bonuses',    rupee(p.totalBonuses)],
    ['Total deductions', rupee(p.totalDeductions)],
  ];
  if (p.totalAdvanceDeduction) sum.push(['   incl. advance recovery', rupee(p.totalAdvanceDeduction)]);
  // Deductions beyond the month's pay, given up: the summary comes to net pay.
  const writtenOff = (p.lineItems || []).filter(isWriteOffLine).reduce((s, l) => s + l.amount, 0);
  if (writtenOff > 0)          sum.push(['Written off', rupee(writtenOff)]);
  if (p.amountPaid)            sum.push(['Amount already paid', rupee(p.amountPaid)]);

  const sW = 260, sX = RIGHT - sW, sRow = 19;
  const sH = sRow * sum.length;
  if (y + sH + 46 > BOTTOM) { doc.addPage(); y = M; }
  doc.lineWidth(0.6).strokeColor(LINE).rect(sX, y, sW, sH).stroke();
  sum.forEach(([lab, val], i) => {
    const ry = y + i * sRow;
    if (i) doc.moveTo(sX, ry).lineTo(RIGHT, ry).lineWidth(0.4).strokeColor(HAIR).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(MUTE).text(lab, sX + 10, ry + 5.5, { width: sW - 130 });
    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(val, sX + sW - 118, ry + 5.5, { width: 108, align: 'right' });
  });
  y += sH;

  // Net pay row — the emphasised bottom row of the summary table
  doc.rect(sX, y, sW, 30).fillAndStroke(HEAD, INK);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
     .text('NET PAY', sX + 10, y + 10, { characterSpacing: 0.8 });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
     .text(rupee(p.netPay), sX + sW - 148, y + 7.5, { width: 138, align: 'right' });
  y += 30 + 34;

  // ── Signature line ─────────────────────────────────────────
  if (y + 40 < BOTTOM) {
    doc.moveTo(RIGHT - 170, y).lineTo(RIGHT, y).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTE)
       .text('Authorised signatory', RIGHT - 170, y + 5, { width: 170, align: 'center' });
  }

  // ── Footer on every page ───────────────────────────────────
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    const fy = H - M - 14;
    doc.moveTo(M, fy - 6).lineTo(RIGHT, fy - 6).lineWidth(0.5).strokeColor(HAIR).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
       .text('System-generated payslip - contact your supervisor for any queries.', M, fy, { width: CW - 120 });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
       .text(`Page ${i + 1} of ${pages.count}`, RIGHT - 120, fy, { width: 120, align: 'right' });
  }
  doc.flushPages();
  doc.end();
}

module.exports = { writePayslip, payslipFileName, MONTHS };

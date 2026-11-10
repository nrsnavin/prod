'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PRINTED PAYSLIP (services/payslipPdf.js)
//
//  What the paper says. The lines that explain a figure without being
//  one are printed in brackets and left out of the Total row, so the
//  totals on the slip come to its net pay — they did not, while "Absent
//  — pay lost" and "Late deduction" were added up as deductions.
// ══════════════════════════════════════════════════════════════════

const { PassThrough } = require('stream');
const { pdfText } = require('../helpers/pdfText');
const { writePayslip, payslipFileName } = require('../../services/payslipPdf');

function render(slip, when = { year: 2026, month: 6 }) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
    writePayslip(slip, when, out);
  });
}

const slip = (over = {}) => ({
  employee: { name: 'Ravi Kumar', department: 'weaving' },
  year: 2026, month: 6, status: 'finalized', hourlyRate: 100,
  presentShifts: 2, absentShifts: 1, approvedLeaveShifts: 0,
  grossEarnings: 2350, totalBonuses: 0, totalDeductions: 200, netPay: 2150,
  lineItems: [
    { label: 'DAY Shift (2026-06-02)', amount: 1200, type: 'earning' },
    { label: 'Absent — pay lost (DAY 2026-06-03)', amount: -1200, type: 'deduction', memo: true },
    { label: 'Late deduction 30m (DAY 2026-06-04)', amount: -50, type: 'deduction', memo: true },
    { label: 'DAY Shift (2026-06-04)', amount: 1150, type: 'earning' },
    { label: 'Excess absent penalty (1 × ₹200)', amount: -200, type: 'deduction' },
  ],
  ...over,
});

describe('the printed payslip', () => {
  it('says who and when, and comes to its net pay', async () => {
    const text = pdfText(await render(slip()));
    expect(text).toMatch(/PAYSLIP/);
    expect(text).toMatch(/June 2026/);
    expect(text).toMatch(/Ravi Kumar/);
    expect(text).toMatch(/2 present \/ 1 absent \/ 0 leave/);
    // The Total row: what was earned and what was really taken off.
    expect(text).toMatch(/Total\s*Rs\. 2,350\.00\s*Rs\. 200\.00/);
    expect(text).toMatch(/NET PAY\s*Rs\. 2,150\.00/);
  });

  it('prints an explaining line in brackets, and says what the brackets mean', async () => {
    const text = pdfText(await render(slip()));
    expect(text).toMatch(/Absent - pay lost \(DAY 2026-06-03\)\s*\(Rs\. 1,200\.00\)/);
    expect(text).toMatch(/Late deduction 30m \(DAY 2026-06-04\)\s*\(Rs\. 50\.00\)/);
    expect(text).toMatch(/Figures in brackets explain pay that was not earned/);
    // A real deduction is not in brackets.
    expect(text).toMatch(/Excess absent penalty \(1 .?\s*Rs\. 200\)\s*Rs\. 200\.00/); // the × is on the paper; the test's reader skips it
  });

  it('a slip stored before lines were marked is read the same way, by how they start', async () => {
    const old = slip();
    old.lineItems = old.lineItems.map(({ memo: _memo, ...l }) => l);
    const text = pdfText(await render(old));
    expect(text).toMatch(/\(Rs\. 1,200\.00\)/);
    expect(text).toMatch(/Total\s*Rs\. 2,350\.00\s*Rs\. 200\.00/);
  });

  it('CONTROL: with nothing to explain there are no brackets and no note', async () => {
    const plain = slip({ lineItems: [{ label: 'DAY Shift (2026-06-02)', amount: 1200, type: 'earning' }], grossEarnings: 1200, totalDeductions: 0, netPay: 1200 });
    const text = pdfText(await render(plain));
    expect(text).not.toMatch(/Figures in brackets/);
    expect(text).toMatch(/Total\s*Rs\. 1,200\.00\s*Rs\. 0\.00/);
  });

  it('is named for the person and the month, with a plain name to fall back on', () => {
    expect(payslipFileName(slip(), { year: 2026, month: 6 })).toEqual({
      name: 'payslip-Ravi_Kumar-June-2026.pdf', fallback: 'payslip-June-2026.pdf',
    });
    expect(payslipFileName({ employee: null }, { year: 2026, month: 1 }).name).toBe('payslip-employee-January-2026.pdf');
  });
});

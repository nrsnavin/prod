'use strict';
// The bonus certificate (services/bonusPdf.js): what the paper says.

const { PassThrough } = require('stream');
const { pdfText } = require('../helpers/pdfText');
const { writeBonusCertificate, bonusFileName } = require('../../services/bonusPdf');
const { latin1 } = require('../../utils/pdfLatin');

function render(record, config, year = 2026) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
    writeBonusCertificate(record, config, year, out);
  });
}

const record = (over = {}) => ({
  employee: { name: 'Ravi Kumar', department: 'weaving', role: 'operator' },
  hourlyRate: 100, hoursWorked: 2400, annualEarnings: 240000, bonusPercent: 10, rawBonusAmount: 24000,
  attendanceDays: 280, totalWorkingDays: 300, attendanceRate: 93.3, attendanceTier: 'S', multiplier: 1,
  bonusAmount: 24000, status: 'paid', paidAt: new Date('2026-11-08T06:00:00.000Z'),
  ...over,
});

describe('the bonus certificate', () => {
  it('says who it is for, what it was worked out on, and what is payable', async () => {
    const text = pdfText(await render(record(), { bonusLabel: 'Diwali 2026', bonusDate: new Date('2026-11-08') }));
    expect(text).toMatch(/Yearly Bonus Certificate/);
    expect(text).toMatch(/Diwali 2026/);
    expect(text).toMatch(/Name\s+: Ravi Kumar/);
    expect(text).toMatch(/Department\s+: weaving/);
    expect(text).toMatch(/Annual Earnings\s*Rs\. 240000\.00/);
    expect(text).toMatch(/Attendance Days\s*280 \/ 300/);
    expect(text).toMatch(/FINAL BONUS PAYABLE\s*Rs\. 24,000/);
    expect(text).toMatch(/Status: PAID/);
  });

  it('a name the built-in font cannot print is printed in a font that can', async () => {
    // The built-in font has no Tamil. The name used to go to it as it
    // was (the wrong letters), and then not at all (a dash).
    const buf = await render(record({ employee: { name: 'ரவி குமார்', department: 'weaving', role: '' } }), null);
    expect(buf.toString('latin1')).toMatch(/NotoSansTamil-Regular/);
    const text = pdfText(buf);
    expect(text).not.toMatch(/Name\s+: -/);
    expect(text).toMatch(/Department\s+: weaving/);   // the rows under it are where they were
    expect(text).toMatch(/Role\s+: -/);
    expect(text).toMatch(/Year\s+: 2026/);
    expect(text).toMatch(/Annual Bonus 2026/); // no label set: the plain one
  });

  it('a label in Tamil, and a department in Hindi, are printed too', async () => {
    const buf = await render(
      record({ employee: { name: 'Priya S', department: 'पैकिंग', role: 'operator' } }),
      { bonusLabel: 'தீபாவளி போனஸ் 2026', bonusDate: new Date('2026-11-08') }
    );
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/NotoSansTamil-Regular/);
    expect(raw).toMatch(/NotoSansDevanagari-Regular/);
    const text = pdfText(buf);
    expect(text).toMatch(/Name\s+: Priya S/);
    expect(text).toMatch(/Payout date/);
  });

  it('CONTROL: a certificate all in Latin carries no extra font', async () => {
    const buf = await render(record(), { bonusLabel: 'Diwali 2026' });
    expect(buf.toString('latin1')).not.toMatch(/NotoSans/);
  });

  it('is named for the person and the year', () => {
    expect(bonusFileName(record(), 2026)).toEqual({ name: 'bonus-Ravi_Kumar-2026.pdf', fallback: 'bonus-2026.pdf' });
    expect(bonusFileName({ employee: null }, 2026).name).toBe('bonus-employee-2026.pdf');
  });
});

describe('latin1: text the built-in PDF font can print', () => {
  it('spells the rupee sign, turns a long dash into a hyphen, drops what the font lacks', () => {
    expect(latin1('₹1,200 — pay lost')).toBe('Rs. 1,200 - pay lost');
    expect(latin1('🌟 No-Leave Bonus')).toBe('No-Leave Bonus');
    expect(latin1('Excess absent penalty (1 × ₹200)')).toBe('Excess absent penalty (1 × Rs. 200)');
    expect(latin1('ரவி')).toBe('');
    expect(latin1('José  Müller')).toBe('José Müller');
    expect(latin1(null)).toBe('');
    expect(latin1(42)).toBe('42');
  });
});

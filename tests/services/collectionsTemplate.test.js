'use strict';
//
// The reminder the office is handed when no model writes it. It was the
// gentle one whatever the tone — so past three weeks, when the ladder
// asks for a firm reminder, the draft still opened "A gentle reminder".

delete process.env.ANTHROPIC_API_KEY; // the template, never a model call

const { template, draft, nextStep } = require('../../services/collections');

const entry = {
  party: '6af403776657cf76e1b7ddc1',
  partyName: 'Acme Garments',
  contact: { name: 'Priya', paymentTerms: '30' },
  overdue: 62000,
  docs: [
    { docNo: 'INV/26-27/0041', date: new Date('2026-08-28T00:00:00Z'), outstanding: 50000, overdueDays: 45 },
    { docNo: 'INV/26-27/0057', date: new Date('2026-09-20T00:00:00Z'), outstanding: 12000, overdueDays: 22 },
  ],
};

describe('collections — the reminder without a model', () => {
  test('gentle by default, as it always read', () => {
    const m = template(entry, 'Balu Elastics');
    expect(m.startsWith('Dear Priya,')).toBe(true);
    expect(m).toContain('A gentle reminder from Balu Elastics: the following invoices are past due —');
    expect(m).toContain('We would be grateful for payment at the earliest');
    expect(m.endsWith('Thank you,\nBalu Elastics')).toBe(true);
  });

  test('firm when asked: no "gentle", a plain request, the same figures', () => {
    const m = template(entry, 'Balu Elastics', 'firm');
    expect(m).not.toMatch(/gentle|grateful/i);
    expect(m.startsWith('Dear Priya,')).toBe(true);
    expect(m).toContain('Our records show the following invoices from Balu Elastics are still unpaid and past due —');
    expect(m).toContain('Please arrange payment now, or reply with the date it will be made.');
    expect(m).toMatch(/• INV\/26-27\/0041 dated .* — ₹50,000\.00 \(45 days past due\)/);
    expect(m).toMatch(/• INV\/26-27\/0057 dated .* — ₹12,000\.00 \(22 days past due\)/);
    expect(m).toContain('Total overdue: ₹62,000.00.');
    expect(m.endsWith('Regards,\nBalu Elastics')).toBe(true);
  });

  test('one invoice reads in the singular in either tone', () => {
    const single = { ...entry, overdue: 50000, docs: [entry.docs[0]] };
    expect(template(single, 'Balu Elastics')).toContain('the following invoice is past due');
    expect(template(single, 'Balu Elastics', 'firm')).toContain('the following invoice from Balu Elastics is still unpaid');
  });

  test('the draft follows the tone it is given, and the ladder\'s tone past three weeks', async () => {
    const firm = await draft(entry, { company: 'Balu Elastics', tone: 'firm' });
    expect(firm.byModel).toBe(false);
    expect(firm.message).toBe(template(entry, 'Balu Elastics', 'firm'));
    const gentle = await draft(entry, { company: 'Balu Elastics', tone: 'gentle' });
    expect(gentle.message).toBe(template(entry, 'Balu Elastics', 'gentle'));
    expect(nextStep(45).tone).toBe('firm');
    expect((await draft(entry, { company: 'Balu Elastics', tone: nextStep(45).tone })).message).toContain('still unpaid');
  });
});

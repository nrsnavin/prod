'use strict';

const { formatEveningReport } = require('../../utils/eveningReport.js');

const base = {
  dateLabel: "20 Jun 2026",
  production: { meters: 0, shifts: 0 },
  wastage:    { meters: 0, penalty: 0, entries: 0, topReason: null },
  deliveries: { count: 0, totalQuantity: 0, totalAmount: 0, items: [] },
};

describe('eveningReport.formatEveningReport', () => {
  test('renders the title with the date', () => {
    const t = formatEveningReport(base);
    expect(t).toMatch(/Evening report\* — 20 Jun 2026/);
  });

  test('all-quiet day uses friendly placeholders', () => {
    const t = formatEveningReport(base);
    expect(t).toMatch(/No shifts closed yet today/);
    expect(t).toMatch(/None recorded/);
    expect(t).toMatch(/No dispatches today/);
  });

  test('renders production today with en-IN grouping', () => {
    const t = formatEveningReport({
      ...base, production: { meters: 124000, shifts: 4 },
    });
    expect(t).toMatch(/1,24,000 m across 4 shift/);
  });

  test('renders wastage with entries, penalty, and top reason', () => {
    const t = formatEveningReport({
      ...base,
      wastage: { meters: 320, penalty: 1500, entries: 3, topReason: "Yarn break" },
    });
    expect(t).toMatch(/320 m over 3 entries/);
    expect(t).toMatch(/penalty ₹1,500/);
    expect(t).toMatch(/Top reason: Yarn break/);
  });

  test('singular vs plural wastage entry wording', () => {
    const one = formatEveningReport({
      ...base, wastage: { meters: 10, penalty: 0, entries: 1, topReason: null },
    });
    expect(one).toMatch(/1 entry/);
    const many = formatEveningReport({
      ...base, wastage: { meters: 10, penalty: 0, entries: 2, topReason: null },
    });
    expect(many).toMatch(/2 entries/);
  });

  test('renders deliveries with summary totals + per-DC line', () => {
    const t = formatEveningReport({
      ...base,
      deliveries: {
        count: 2, totalQuantity: 8500, totalAmount: 125000,
        items: [
          { dcNumber: "DC/E/26-27/041", orderNo: 1042,
            customerName: "Acme", totalQuantity: 5000 },
          { dcNumber: "DC/E/26-27/042", orderNo: null,
            customerName: "Bravo", totalQuantity: 3500 },
        ],
      },
    });
    expect(t).toMatch(/Deliveries \(today\)/);
    expect(t).toMatch(/2 DC\(s\) · 8,500 m · ₹1,25,000/);
    expect(t).toMatch(/DC\/E\/26-27\/041 · Order #1042 · Acme: 5,000 m/);
    // Standalone DC (no orderNo) shows without the order tag
    expect(t).toMatch(/DC\/E\/26-27\/042 · Bravo: 3,500 m/);
  });

  test('caps deliveries list at 5 with overflow note', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      dcNumber: `DC/E/26-27/${i}`, orderNo: i + 1000,
      customerName: `Cust${i}`, totalQuantity: 100 * (i + 1),
    }));
    const t = formatEveningReport({
      ...base,
      deliveries: {
        count: 7, totalQuantity: 2800, totalAmount: 50000, items,
      },
    });
    expect(t).toMatch(/\+2 more/);
    expect(t).not.toMatch(/DC\/E\/26-27\/6/);
  });
});

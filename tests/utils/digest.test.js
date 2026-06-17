'use strict';

const { formatDigest } = require('../../utils/digest.js');

const base = {
  dateLabel: "15 Jun",
  production: { meters: 0, shifts: 0 },
  wastage:    { meters: 0, penalty: 0, entries: 0, topReason: null },
  stockouts:  [],
  maintenance: [],
};

describe('digest.formatDigest', () => {
  test('renders an all-clear day with friendly placeholders', () => {
    const t = formatDigest(base);
    expect(t).toMatch(/Morning digest\* — 15 Jun/);
    expect(t).toMatch(/No closed shifts/);
    expect(t).toMatch(/None recorded/);
    expect(t).toMatch(/None within horizon/);
    expect(t).toMatch(/Nothing due/);
  });

  test('renders production + wastage figures with en-IN grouping', () => {
    const t = formatDigest({
      ...base,
      production: { meters: 124000, shifts: 4 },
      wastage:    { meters: 320, penalty: 1500, entries: 3, topReason: "Yarn break" },
    });
    expect(t).toMatch(/1,24,000 m across 4 shift/);
    expect(t).toMatch(/320 m over 3 entries/);
    expect(t).toMatch(/penalty ₹1,500/);
    expect(t).toMatch(/Top reason: Yarn break/);
  });

  test('lists stockouts sorted, capping at 5 with overflow note', () => {
    const stockouts = Array.from({ length: 7 }, (_, i) => ({
      name: `Mat${i}`, stock: 100, daysToStockout: i + 1,
    }));
    const t = formatDigest({ ...base, stockouts });
    expect(t).toMatch(/Mat0: ~1d left/);
    expect(t).toMatch(/\+2 more/);
    // 6th and 7th not individually listed.
    expect(t).not.toMatch(/Mat6:/);
  });

  test('flags overdue maintenance distinctly from upcoming', () => {
    const t = formatDigest({
      ...base,
      maintenance: [
        { ID: "M1", overdue: true,  daysUntil: -2 },
        { ID: "M2", overdue: false, daysUntil: 5 },
      ],
    });
    expect(t).toMatch(/M1: OVERDUE/);
    expect(t).toMatch(/M2: in 5d/);
  });

  test('singular vs plural wastage entry wording', () => {
    const one = formatDigest({ ...base, wastage: { meters: 10, penalty: 0, entries: 1, topReason: null } });
    expect(one).toMatch(/1 entry/);
    const many = formatDigest({ ...base, wastage: { meters: 10, penalty: 0, entries: 2, topReason: null } });
    expect(many).toMatch(/2 entries/);
  });
});

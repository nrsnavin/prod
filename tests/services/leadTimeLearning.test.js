'use strict';
// ══════════════════════════════════════════════════════════════════
//  LEARNING HOW LONG A SUPPLIER ACTUALLY TAKES
//
//  Pure functions over receipts. The estimate IS the data — there is
//  no training step and no model file — so these are about whether the
//  arithmetic survives the shapes real purchase data comes in: split
//  consignments, backdated entries, a PO receipted a year late.
// ══════════════════════════════════════════════════════════════════

const {
  observationsFrom,
  buildIndex,
  summarise,
  resolveLeadTime,
  confidenceFor,
} = require('../../services/leadTimeLearning');

const NOW = new Date('2026-08-14T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);

const SUP = 'sup1';
const MAT = 'mat1';

/** A PO raised `orderedDaysAgo` back, received `leadDays` after that. */
const delivery = (id, orderedDaysAgo, leadDays, { supplier = SUP, material = MAT } = {}) => ({
  po: { _id: id, date: daysAgo(orderedDaysAgo), supplier },
  receipt: {
    purchaseOrder: id,
    rawMaterial: material,
    inwardDate: daysAgo(orderedDaysAgo - leadDays),
  },
});

const observe = (deliveries, opts) => {
  const poById = new Map(deliveries.map((d) => [String(d.po._id), d.po]));
  return observationsFrom(deliveries.map((d) => d.receipt), poById, { now: NOW, ...opts });
};

// ══════════════════════════════════════════════════════════════════
describe('turning receipts into observed lead times', () => {
  it('measures the gap between the order and the goods arriving', () => {
    const obs = observe([delivery('po1', 30, 14)]);
    expect(obs).toHaveLength(1);
    expect(obs[0].days).toBe(14);
  });

  it('counts a split consignment once, from when it started arriving', () => {
    // A PO received in three instalments has ONE lead time. Counting
    // the later ones would teach the model this supplier is slow when
    // it is really just splitting a delivery.
    const po = { _id: 'po1', date: daysAgo(30), supplier: SUP };
    const poById = new Map([['po1', po]]);
    const obs = observationsFrom(
      [
        { purchaseOrder: 'po1', rawMaterial: MAT, inwardDate: daysAgo(16) }, // 14 days
        { purchaseOrder: 'po1', rawMaterial: MAT, inwardDate: daysAgo(10) }, // 20 days
        { purchaseOrder: 'po1', rawMaterial: MAT, inwardDate: daysAgo(5) },  // 25 days
      ],
      poById,
      { now: NOW }
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].days).toBe(14);
  });

  it('keeps two materials on one PO apart', () => {
    const po = { _id: 'po1', date: daysAgo(30), supplier: SUP };
    const obs = observationsFrom(
      [
        { purchaseOrder: 'po1', rawMaterial: 'warp', inwardDate: daysAgo(20) },
        { purchaseOrder: 'po1', rawMaterial: 'weft', inwardDate: daysAgo(10) },
      ],
      new Map([['po1', po]]),
      { now: NOW }
    );
    expect(obs.map((o) => o.days).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('drops a receipt that predates its own purchase order', () => {
    // Backdated entry. Not a same-day delivery, and not information.
    const po = { _id: 'po1', date: daysAgo(10), supplier: SUP };
    const obs = observationsFrom(
      [{ purchaseOrder: 'po1', rawMaterial: MAT, inwardDate: daysAgo(20) }],
      new Map([['po1', po]]),
      { now: NOW }
    );
    expect(obs).toHaveLength(0);
  });

  it('drops a PO receipted absurdly late', () => {
    // Cancelled and then quietly receipted, or a date typed wrong.
    // A different kind of event, not a slow delivery.
    expect(observe([delivery('po1', 500, 450)])).toHaveLength(0);
  });

  it('ignores deliveries outside the learning window', () => {
    expect(observe([delivery('po1', 500, 14)], { windowDays: 365 })).toHaveLength(0);
  });

  it('ignores a receipt with no purchase order behind it', () => {
    // A manual stock inward is not evidence about a supplier.
    const obs = observationsFrom(
      [{ purchaseOrder: null, rawMaterial: MAT, inwardDate: daysAgo(5) }],
      new Map(),
      { now: NOW }
    );
    expect(obs).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('summarising a supplier', () => {
  it('takes the middle delivery, not the average', () => {
    expect(summarise([10, 12, 14, 16, 18]).median).toBe(14);
  });

  it('is not moved by one absurd delivery', () => {
    // THE reason this uses a median. A mean would read 79 and the
    // mill would see its safety stock triple over one bad row — and
    // would rightly stop trusting the number.
    const clean = summarise([12, 13, 14, 15, 16]);
    const withOutlier = summarise([12, 13, 14, 15, 350]);
    expect(clean.median).toBe(14);
    expect(withOutlier.median).toBe(14);
  });

  it('measures the spread, which is what safety stock needs', () => {
    const reliable = summarise([14, 14, 14, 14, 14]);
    const erratic  = summarise([4, 9, 14, 19, 24]);
    expect(reliable.median).toBe(erratic.median);
    expect(reliable.sd).toBe(0);
    expect(erratic.sd).toBeGreaterThan(5);
  });

  it('reports the fastest and slowest, because a buyer wants the range', () => {
    const s = summarise([9, 14, 22]);
    expect(s.min).toBe(9);
    expect(s.max).toBe(22);
  });

  it('says nothing about an empty history', () => {
    expect(summarise([]).median).toBeNull();
    expect(summarise([]).confidence).toBe('none');
  });
});

describe('how far to trust it', () => {
  it('will not commit on fewer than three deliveries', () => {
    expect(confidenceFor(0)).toBe('none');
    expect(confidenceFor(2)).toBe('none');
  });

  it('climbs as the deliveries accumulate', () => {
    expect(confidenceFor(3)).toBe('low');
    expect(confidenceFor(6)).toBe('medium');
    expect(confidenceFor(12)).toBe('high');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('material history against supplier history', () => {
  const many = (leadDays, n, material) =>
    Array.from({ length: n }, (_, i) =>
      delivery(`po-${material}-${i}`, 300 - i * 10, leadDays, { material })
    );

  it('keeps a slow material apart from its supplier average', () => {
    // A dyed yarn is slower than a greige one from the same mill.
    const idx = buildIndex(observe([...many(10, 5, 'greige'), ...many(40, 5, 'dyed')]));
    expect(idx.material.get(`${SUP}:dyed`).median).toBe(40);
    expect(idx.material.get(`${SUP}:greige`).median).toBe(10);
  });

  it('pools everything for the supplier, which is the fallback', () => {
    const idx = buildIndex(observe([...many(10, 5, 'greige'), ...many(40, 5, 'dyed')]));
    expect(idx.supplier.get(SUP).n).toBe(10);
    expect(idx.supplier.get(SUP).median).toBe(25);   // between the two
  });
});

// ══════════════════════════════════════════════════════════════════
//  What actually gets used, and why.
// ══════════════════════════════════════════════════════════════════
describe('choosing the lead time to act on', () => {
  const learnedHigh = { median: 21, sd: 4, n: 12, confidence: 'high', min: 15, max: 30 };
  const noHistory   = { median: null, sd: 0, n: 0, confidence: 'none', min: null, max: null };

  it('uses what somebody typed on the material, above everything', () => {
    // They may know something the history cannot — a supplier who has
    // just changed hands, a route that closed.
    const r = resolveLeadTime({
      materialLeadTime: 30, supplierLeadTime: 14,
      observed: { material: learnedHigh, supplier: learnedHigh },
    });
    expect(r.days).toBe(30);
    expect(r.source).toBe('material');
  });

  it('falls to the supplier figure next', () => {
    const r = resolveLeadTime({
      materialLeadTime: null, supplierLeadTime: 14,
      observed: { material: noHistory, supplier: learnedHigh },
    });
    expect(r.days).toBe(14);
    expect(r.source).toBe('supplier');
  });

  it('uses the measured figure when nobody has typed one', () => {
    const r = resolveLeadTime({
      materialLeadTime: null, supplierLeadTime: 0,
      observed: { material: noHistory, supplier: learnedHigh },
    });
    expect(r.days).toBe(21);
    expect(r.source).toBe('observed-supplier');
  });

  it('prefers the material own deliveries over the supplier pool', () => {
    const r = resolveLeadTime({
      materialLeadTime: null, supplierLeadTime: 0,
      observed: {
        material: { median: 45, sd: 3, n: 6, confidence: 'medium', min: 40, max: 50 },
        supplier: learnedHigh,
      },
    });
    expect(r.days).toBe(45);
    expect(r.source).toBe('observed-material');
  });

  it('will not act on one or two deliveries', () => {
    const r = resolveLeadTime({
      materialLeadTime: null, supplierLeadTime: 0,
      observed: { material: noHistory, supplier: { ...noHistory, n: 2 } },
    });
    expect(r.days).toBe(0);
    expect(r.source).toBe('none');
  });

  it('carries the measured spread even when a typed figure wins', () => {
    // The average is a person's call; the VARIABILITY is only ever
    // measurable, and it is what safety stock actually needs.
    const r = resolveLeadTime({
      materialLeadTime: 30, supplierLeadTime: null,
      observed: { material: noHistory, supplier: learnedHigh },
    });
    expect(r.days).toBe(30);
    expect(r.sd).toBe(4);
  });

  it('flags a typed figure the deliveries contradict', () => {
    // Not corrected automatically. Surfaced, so somebody decides.
    const r = resolveLeadTime({
      materialLeadTime: 7, supplierLeadTime: null,
      observed: { material: noHistory, supplier: learnedHigh },   // measured 21
    });
    expect(r.disagrees).toBe(true);
  });

  it('does not flag a typed figure the deliveries agree with', () => {
    const r = resolveLeadTime({
      materialLeadTime: 20, supplierLeadTime: null,
      observed: { material: noHistory, supplier: learnedHigh },   // measured 21
    });
    expect(r.disagrees).toBe(false);
  });

  it('treats a typed 0 as same-day, not as unset', () => {
    const r = resolveLeadTime({
      materialLeadTime: 0, supplierLeadTime: 14,
      observed: { material: noHistory, supplier: noHistory },
    });
    expect(r.days).toBe(0);
    expect(r.source).toBe('material');
  });
});

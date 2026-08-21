'use strict';

const {
  attributeMovements,
  withLots,
  earliestLotBy,
} = require('../../services/lotAttribution');

// ── Fixtures ─────────────────────────────────────────────────────
const d = (s) => new Date(`${s}T09:00:00.000Z`);

const WARP = { category: 'warp' };
const WEFT = { category: 'weft' };

const lot = (id, lotNo, received) => ({
  _id: id,
  lotNo,
  receivedDate: d(received),
});

// Deliberately out of order: the module sorts, and a test that hands
// them in sorted would pass whether it did or not.
const LOTS = [
  lot('L3', 'D-3003', '2026-03-10'),
  lot('L1', 'D-1001', '2026-01-05'),
  lot('L2', 'D-2002', '2026-02-08'),
];

describe('earliestLotBy', () => {
  const oldestFirst = [...LOTS].sort(
    (a, b) => new Date(a.receivedDate) - new Date(b.receivedDate)
  );

  it('picks the oldest lot that had arrived by then', () => {
    expect(earliestLotBy(d('2026-04-01'), oldestFirst).lotNo).toBe('D-1001');
  });

  it('ignores lots that arrived after the movement', () => {
    // Only D-1001 existed on 20 Jan.
    expect(earliestLotBy(d('2026-01-20'), oldestFirst).lotNo).toBe('D-1001');
  });

  it('counts a lot received on the same day', () => {
    expect(earliestLotBy(d('2026-01-05'), oldestFirst).lotNo).toBe('D-1001');
  });

  it('has no answer before any lot arrived', () => {
    expect(earliestLotBy(d('2025-12-31'), oldestFirst)).toBeNull();
  });

  it('will not place a lot with no received date', () => {
    expect(earliestLotBy(d('2026-04-01'), [{ _id: 'X', lotNo: 'D-9', receivedDate: null }]))
      .toBeNull();
  });
});

describe('attributeMovements — recorded lots', () => {
  it('reads a goods receipt lot off the matching inward', () => {
    const movements = [{ type: 'PO_INWARD', quantity: 40, date: d('2026-02-08') }];
    const inwards = [{ quantity: 40, inwardDate: d('2026-02-08'), lotNo: 'D-2002' }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS, inwards });
    expect(a).toEqual({ lotNo: 'D-2002', yarnLot: null, lotDerived: false });
  });

  it('declines to name a lot when two receipts are indistinguishable', () => {
    const movements = [{ type: 'PO_INWARD', quantity: 40, date: d('2026-02-08') }];
    const inwards = [
      { quantity: 40, inwardDate: d('2026-02-08'), lotNo: 'D-2002' },
      { quantity: 40, inwardDate: d('2026-02-08'), lotNo: 'D-3003' },
    ];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS, inwards });
    // Falls to the inference, which is the OLDEST lot — pointedly not
    // either of the two candidates, so a reader cannot mistake it for
    // a resolved match.
    expect(a.lotDerived).toBe(true);
    expect(a.lotNo).toBe('D-1001');
  });

  it('reads a stock adjustment lot off the matching outward', () => {
    const movements = [{ type: 'STOCK_ADJUST', quantity: -12, date: d('2026-03-15') }];
    const outwards = [{
      type: 'STOCK_ADJUST', quantity: 12, outwardDate: d('2026-03-15'),
      lotNo: 'D-3003', yarnLot: 'L3',
    }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS, outwards });
    expect(a).toEqual({ lotNo: 'D-3003', yarnLot: 'L3', lotDerived: false });
  });

  it('matches an adjustment regardless of which side stored the sign', () => {
    // The movement is stored negative, the outward positive. Neither
    // convention is wrong, and the match must not depend on which.
    const movements = [{ type: 'STOCK_ADJUST', quantity: -12, date: d('2026-03-15') }];
    const outwards = [{
      type: 'STOCK_ADJUST', quantity: -12, outwardDate: d('2026-03-15'), lotNo: 'D-3003',
    }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS, outwards });
    expect(a.lotNo).toBe('D-3003');
    expect(a.lotDerived).toBe(false);
  });

  it('does not match an adjustment against an order-approval outward', () => {
    const movements = [{ type: 'STOCK_ADJUST', quantity: -12, date: d('2026-03-15') }];
    const outwards = [{
      type: 'ORDER_APPROVAL', quantity: 12, outwardDate: d('2026-03-15'), lotNo: 'D-3003',
    }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS, outwards });
    expect(a.lotDerived).toBe(true);      // inferred, not the ORDER_APPROVAL's lot
    expect(a.lotNo).toBe('D-1001');
  });
});

describe('attributeMovements — lots already stamped on the row', () => {
  it('passes a batch issue through untouched', () => {
    const movements = [{
      type: 'BATCH_ISSUE', quantity: 0, lotQuantity: 40,
      lotNo: 'D-2002', yarnLot: 'L2', date: d('2026-04-01'),
    }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS });
    expect(a).toEqual({ lotNo: 'D-2002', yarnLot: 'L2', lotDerived: false });
  });

  it('never infers a lot onto a batch row that lost one', () => {
    // A batch row with no lot is a writer bug. Filling it in would
    // render as a recorded fact and hide the bug for good.
    const movements = [{ type: 'BATCH_ISSUE', quantity: 0, date: d('2026-04-01') }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS });
    expect(a).toEqual({ lotNo: '', yarnLot: null, lotDerived: false });
  });

  it('prefers a lot written on the movement over any inference', () => {
    const movements = [{
      type: 'ORDER_APPROVAL', quantity: -20, lotNo: 'D-3003', date: d('2026-04-01'),
    }];

    const [a] = attributeMovements({ material: WARP, movements, lots: LOTS });
    expect(a.lotNo).toBe('D-3003');
    expect(a.lotDerived).toBe(false);
  });
});

describe('attributeMovements — inference', () => {
  const movements = [
    { type: 'ORDER_APPROVAL',      quantity: -20, date: d('2026-04-01') },
    { type: 'JOB_CONSUMPTION',     quantity: -8,  date: d('2026-01-20') },
    { type: 'ORDER_CANCEL_REFUND', quantity: +20, date: d('2026-04-05') },
  ];

  it('gives a warp material the earliest lot that existed at the time', () => {
    const out = attributeMovements({ material: WARP, movements, lots: LOTS });
    expect(out.map((a) => a.lotNo)).toEqual(['D-1001', 'D-1001', 'D-1001']);
    expect(out.every((a) => a.lotDerived)).toBe(true);
  });

  it('gives a non-warp material nothing at all', () => {
    const out = attributeMovements({ material: WEFT, movements, lots: LOTS });
    expect(out).toEqual([
      { lotNo: '', yarnLot: null, lotDerived: false },
      { lotNo: '', yarnLot: null, lotDerived: false },
      { lotNo: '', yarnLot: null, lotDerived: false },
    ]);
  });

  it('still reads a RECORDED lot on a non-warp material', () => {
    // The switch governs INFERENCE. A receipt that named its lot said
    // so regardless of what the material is made of.
    const mv = [{ type: 'PO_INWARD', quantity: 40, date: d('2026-02-08') }];
    const inwards = [{ quantity: 40, inwardDate: d('2026-02-08'), lotNo: 'W-77' }];

    const [a] = attributeMovements({ material: WEFT, movements: mv, lots: [], inwards });
    expect(a).toEqual({ lotNo: 'W-77', yarnLot: null, lotDerived: false });
  });

  it('folds the category case, so "Warp" is warp', () => {
    const out = attributeMovements({
      material: { category: '  WARP ' }, movements, lots: LOTS,
    });
    expect(out[0].lotDerived).toBe(true);
  });

  it('treats a legacy group name in category as untracked', () => {
    const out = attributeMovements({
      material: { category: 'Trim Tape' }, movements, lots: LOTS,
    });
    expect(out.every((a) => a.lotNo === '')).toBe(true);
  });

  it('has no answer for a warp material with no lots yet', () => {
    const out = attributeMovements({ material: WARP, movements, lots: [] });
    expect(out.every((a) => a.lotNo === '' && !a.lotDerived)).toBe(true);
  });

  it('does not attribute a movement older than every lot', () => {
    const mv = [{ type: 'ORDER_APPROVAL', quantity: -5, date: d('2025-11-01') }];
    const [a] = attributeMovements({ material: WARP, movements: mv, lots: LOTS });
    expect(a.lotNo).toBe('');
  });

  it('reads a March row from the lots that existed in March', () => {
    // The property the rule exists for: this answer must not depend on
    // anything that happened after the movement.
    const march = [{ type: 'ORDER_APPROVAL', quantity: -5, date: d('2026-02-20') }];
    const before = attributeMovements({ material: WARP, movements: march, lots: LOTS });

    const laterLots = [...LOTS, lot('L4', 'D-4004', '2026-06-01')];
    const after = attributeMovements({ material: WARP, movements: march, lots: laterLots });

    expect(after[0].lotNo).toBe(before[0].lotNo);
  });
});

describe('attributeMovements — shape', () => {
  it('returns one entry per movement, in order', () => {
    const movements = [
      { type: 'PO_INWARD', quantity: 1, date: d('2026-04-01') },
      { type: 'ORDER_APPROVAL', quantity: -1, date: d('2026-04-02') },
      { type: 'STOCK_ADJUST', quantity: -1, date: d('2026-04-03') },
    ];
    const out = attributeMovements({ material: WARP, movements, lots: LOTS });
    expect(out).toHaveLength(3);
  });

  it('survives being handed nothing', () => {
    expect(attributeMovements()).toEqual([]);
  });
});

describe('withLots', () => {
  it('folds attributions onto their rows without losing fields', () => {
    const movements = [{ type: 'PO_INWARD', quantity: 40, balance: 140, date: d('2026-02-08') }];
    const attributions = [{ lotNo: 'D-2002', yarnLot: 'L2', lotDerived: false }];

    const [row] = withLots(movements, attributions);
    expect(row).toMatchObject({
      type: 'PO_INWARD', quantity: 40, balance: 140,
      lotNo: 'D-2002', yarnLot: 'L2', lotDerived: false,
    });
  });

  it('fills a row with no attribution rather than leaving it undefined', () => {
    const [row] = withLots([{ type: 'PO_INWARD', quantity: 1 }], []);
    expect(row.lotNo).toBe('');
    expect(row.lotDerived).toBe(false);
  });
});

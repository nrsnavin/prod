'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BATCH ROW MUST NOT MOVE THE BALANCE
//
//  normaliseMovements rebuilds missing balances by walking BACKWARDS
//  from today's stock: each older row closed at `balance - quantity`
//  of the row after it. A warping batch draws yarn off the rack
//  without moving `stock`, so a batch row that contributed anything to
//  that walk would subtract yarn the balance never lost, and every row
//  below it would be restated.
//
//  The failure mode is what makes this worth its own file: it produces
//  plausible-looking numbers rather than an error. Nothing throws,
//  nothing logs, and the page reads as a ledger that no longer
//  reconciles.
//
//  ── What actually defends it, which is not what I first assumed ───
//  The writer stores `quantity: 0` on these rows, and it would be easy
//  to believe that is the protection. It is not: MOVEMENT_DIRECTION
//  maps both batch types to 0, and normaliseMovements multiplies by
//  the direction, so a batch row is neutralised no matter what its
//  stored quantity says. The `quantity: 0` convention is the second
//  layer, not the first.
//
//  That distinction decides how these tests are written. A fixture
//  storing 0 would pass whether the direction entry existed or not —
//  it would assert nothing. So the fixture below is deliberately
//  HOSTILE: it stores the drawn kilos in `quantity`, exactly as a
//  careless writer would, and asserts the walk ignores them anyway.
//  Delete `BATCH_ISSUE: 0` from the direction map and these fail.
// ══════════════════════════════════════════════════════════════════

const {
  normaliseMovements,
  MOVEMENT_DIRECTION,
  TYPE_LABEL,
  LOT_ONLY_TYPES,
} = require('../../utils/stockLedger');

const d = (s) => new Date(`2026-${s}T09:00:00.000Z`);

const STOCK = 100;

/**
 * Newest first, as the endpoint sorts them, with no balances recorded.
 *
 * `quantity` on the batch row is the hostile part: 40 kg came off the
 * rack and the ledger's balance column must not notice.
 */
const withBatch = (batchQuantity) => [
  { type: 'PO_INWARD',   quantity: 30, date: d('04-10') },
  { type: 'BATCH_ISSUE', quantity: batchQuantity, lotQuantity: 40,
    lotNo: 'D-4471', date: d('04-08') },
  { type: 'ORDER_APPROVAL', quantity: 25, date: d('04-05') },
  { type: 'PO_INWARD',      quantity: 50, date: d('04-01') },
];

/** The same history with the batch row absent. */
const withoutBatch = () => [
  { type: 'PO_INWARD',      quantity: 30, date: d('04-10') },
  { type: 'ORDER_APPROVAL', quantity: 25, date: d('04-05') },
  { type: 'PO_INWARD',      quantity: 50, date: d('04-01') },
];

// 0 is what the writer stores; 40 and -40 are what a careless one
// would. All three must produce the same ledger.
describe.each([
  ['stored as 0, as the writer does', 0],
  ['stored as the drawn kilos', 40],
  ['stored as the drawn kilos, negated', -40],
])('a batch row %s', (_label, batchQuantity) => {
  it('leaves every balance below it exactly where it was', () => {
    const withRow = normaliseMovements(withBatch(batchQuantity), STOCK);
    const without = normaliseMovements(withoutBatch(), STOCK);

    const comparable = withRow.filter((r) => r.type !== 'BATCH_ISSUE');

    expect(comparable.map((r) => r.balance)).toEqual(without.map((r) => r.balance));
    expect(comparable.map((r) => r.quantity)).toEqual(without.map((r) => r.quantity));
  });

  it('contributes nothing to the balance column', () => {
    const rows = normaliseMovements(withBatch(batchQuantity), STOCK);
    const [newest, batch] = rows;

    expect(batch.quantity).toBe(0);
    // The row above closed at 100 and opened at 70; the batch changed
    // nothing, so it closed at 70 too.
    expect(newest.balance).toBe(100);
    expect(batch.balance).toBe(70);
  });

  it('still reconciles: each balance is the one below it plus the delta', () => {
    const rows = normaliseMovements(withBatch(batchQuantity), STOCK);
    for (let i = 0; i < rows.length - 1; i += 1) {
      expect(rows[i].balance).toBeCloseTo(rows[i + 1].balance + rows[i].quantity, 6);
    }
  });

  it('reports the kilos drawn, from lotQuantity and not from quantity', () => {
    const batch = normaliseMovements(withBatch(batchQuantity), STOCK)[1];
    expect(batch.lotQuantity).toBe(-40);
    expect(batch.lotOnly).toBe(true);
    expect(batch.lotNo).toBe('D-4471');
  });
});

describe('batch rows, other shapes', () => {
  it('signs a return the other way', () => {
    const [row] = normaliseMovements(
      [{ type: 'BATCH_RETURN', quantity: 0, lotQuantity: 40, date: d('04-08') }],
      STOCK
    );
    expect(row.lotQuantity).toBe(40);
    expect(row.quantity).toBe(0);
  });

  it('marks only the batch types as lot-only', () => {
    const rows = normaliseMovements(withBatch(0), STOCK);
    expect(rows.map((r) => r.lotOnly)).toEqual([false, true, false, false]);
  });

  it('leaves lotQuantity null on an ordinary movement', () => {
    const rows = normaliseMovements(withoutBatch(), STOCK);
    expect(rows.every((r) => r.lotQuantity === null)).toBe(true);
  });

  it('prices nothing on a batch row', () => {
    // `value` is a stock valuation. Yarn moving between the rack and a
    // beam changes no stock value, so putting a number here would be a
    // second thing on the row claiming the balance moved.
    const [row] = normaliseMovements(
      [{ type: 'BATCH_ISSUE', quantity: 0, lotQuantity: 40, date: d('04-08') }],
      STOCK
    );
    expect(row.value).toBeNull();
  });
});

describe('the vocabulary', () => {
  it('maps both batch types to a zero direction', () => {
    // This is the line the tests above actually depend on. Asserted
    // directly as well, so its removal is named rather than inferred
    // from four balance failures.
    expect(MOVEMENT_DIRECTION.BATCH_ISSUE).toBe(0);
    expect(MOVEMENT_DIRECTION.BATCH_RETURN).toBe(0);
  });

  it('says both in words rather than printing the enum', () => {
    expect(TYPE_LABEL.BATCH_ISSUE).toBe('Drawn for warping');
    expect(TYPE_LABEL.BATCH_RETURN).toBe('Returned to rack');
  });

  it('agrees with itself about which types are lot-only', () => {
    // Two lists of one fact drift. This is what notices when they
    // have — in particular, a new lot-only type added to the set and
    // forgotten in the direction map, which is the realistic way the
    // balance walk gets broken from here.
    const zeroDir = Object.entries(MOVEMENT_DIRECTION)
      .filter(([, v]) => v === 0)
      .map(([k]) => k)
      .sort();
    expect([...LOT_ONLY_TYPES].sort()).toEqual(zeroDir);
  });

  it('gives every lot-only type a label', () => {
    for (const t of LOT_ONLY_TYPES) expect(TYPE_LABEL[t]).toBeTruthy();
  });
});

describe('a stock adjustment keeps its stored sign', () => {
  // The one type with no direction in the map, because it is genuinely
  // signed either way. Asserted here because the same line that
  // neutralises batch rows decides this too — a change to it that
  // caught adjustments would flip real write-offs into receipts.
  it('does not flip a negative adjustment positive', () => {
    const [row] = normaliseMovements(
      [{ type: 'STOCK_ADJUST', quantity: -12, date: d('04-08') }],
      STOCK
    );
    expect(row.quantity).toBe(-12);
  });

  it('does not flip a positive adjustment negative', () => {
    const [row] = normaliseMovements(
      [{ type: 'STOCK_ADJUST', quantity: 12, date: d('04-08') }],
      STOCK
    );
    expect(row.quantity).toBe(12);
  });
});

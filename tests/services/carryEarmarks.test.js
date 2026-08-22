'use strict';
// ══════════════════════════════════════════════════════════════════
//  EARMARKS ACROSS A REPLAN
//
//  Raising a second job restates the order's requirement:
//
//      order.rawMaterialRequired = await computeMaterialRequirement(...)
//
//  and computeMaterialRequirement returns rows with no `lots` field, so
//  that one line silently threw away every dye lot the order had set
//  aside. Nothing failed. The panel just said "Nothing set aside" the
//  next time somebody opened it.
//
//  What carrying them forward has to get right:
//
//    1. Keep them. The whole point.
//    2. Keep the invariant validateEarmarks enforces — a total never
//       larger than the requirement. A replan can SHRINK a requirement,
//       and a blind copy would leave the order in a state the assign
//       route would have refused.
//    3. Be honest about what it could not keep. A material that has
//       left the sheet takes its promises with it either way; the
//       difference between this and the bug is that it says so.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { carryEarmarksForward } = require('../../services/lotAllocation');

const M1 = new mongoose.Types.ObjectId();
const M2 = new mongoose.Types.ObjectId();
const L1 = new mongoose.Types.ObjectId();
const L2 = new mongoose.Types.ObjectId();
const L3 = new mongoose.Types.ObjectId();

const day = (n) => new Date(`2025-03-${String(n).padStart(2, '0')}T10:00:00.000Z`);

const earmark = (over = {}) => ({
  yarnLot: L1,
  lotNo: 'D-1',
  shade: 'Ecru',
  quantity: 100,
  assignedAt: day(1),
  ...over,
});

const prev = (over = {}) => ({
  rawMaterial: M1,
  name: 'Nylon 40D',
  requiredWeight: 400,
  lots: [earmark()],
  ...over,
});

const fresh = (over = {}) => ({
  rawMaterial: M1,
  name: 'Nylon 40D',
  requiredWeight: 400,
  inStock: 1000,
  lotOptions: [],
  ...over,
});

const totalOf = (row) => (row.lots || []).reduce((t, l) => t + l.quantity, 0);

describe('carrying earmarks across a recomputed requirement', () => {
  it('keeps a promise the replan did not disturb', () => {
    // The bug, stated as a test: without carrying, this is [].
    const { rows } = carryEarmarksForward([prev()], [fresh()]);
    expect(rows[0].lots).toHaveLength(1);
    expect(rows[0].lots[0].quantity).toBe(100);
    expect(String(rows[0].lots[0].yarnLot)).toBe(String(L1));
  });

  it('keeps every field the earmark schema stores', () => {
    // A carried promise that lost its lot number would read as a bare
    // id on a panel built to show the bag.
    const by = new mongoose.Types.ObjectId();
    const { rows } = carryEarmarksForward(
      [prev({ lots: [earmark({ lotNo: 'D-4471', shade: 'Off White', assignedBy: by })] })],
      [fresh()]
    );
    expect(rows[0].lots[0]).toMatchObject({
      lotNo: 'D-4471',
      shade: 'Off White',
      quantity: 100,
    });
    expect(String(rows[0].lots[0].assignedBy)).toBe(String(by));
    expect(rows[0].lots[0].assignedAt).toEqual(day(1));
  });

  it('keeps the fresh row\'s recomputed numbers, not the old ones', () => {
    // Carrying the lots must not carry the stale requirement with them.
    const { rows } = carryEarmarksForward(
      [prev({ requiredWeight: 400 })],
      [fresh({ requiredWeight: 650, inStock: 12 })]
    );
    expect(rows[0].requiredWeight).toBe(650);
    expect(rows[0].inStock).toBe(12);
  });

  it('carries across a material that grew', () => {
    const { rows, trimmed } = carryEarmarksForward(
      [prev()],
      [fresh({ requiredWeight: 900 })]
    );
    expect(totalOf(rows[0])).toBe(100);
    expect(trimmed).toEqual([]);
  });

  it('gives a brand-new material an empty list rather than no field', () => {
    // The panel reads `lots` directly. undefined renders as a crash or
    // a blank where "no lots set aside" belongs.
    const { rows } = carryEarmarksForward([], [fresh({ rawMaterial: M2 })]);
    expect(rows[0].lots).toEqual([]);
  });

  it('matches rows by material even when the order changed', () => {
    // computeMaterialRequirement builds from a Map, so row order is not
    // stable across a replan. Matching by index would move one
    // material's promises onto another's yarn.
    const { rows } = carryEarmarksForward(
      [
        prev({ rawMaterial: M1, lots: [earmark({ lotNo: 'D-1' })] }),
        prev({ rawMaterial: M2, name: 'Spandex', lots: [earmark({ yarnLot: L2, lotNo: 'D-2' })] }),
      ],
      [fresh({ rawMaterial: M2, name: 'Spandex' }), fresh({ rawMaterial: M1 })]
    );
    expect(rows[0].lots[0].lotNo).toBe('D-2');
    expect(rows[1].lots[0].lotNo).toBe('D-1');
  });

  it('matches a populated reference against a plain id', () => {
    // The order arrives hydrated in one path and lean in another.
    const { rows } = carryEarmarksForward(
      [prev({ rawMaterial: { _id: M1, name: 'Nylon 40D' } })],
      [fresh({ rawMaterial: M1 })]
    );
    expect(rows[0].lots).toHaveLength(1);
  });
});

describe('when the requirement shrinks', () => {
  it('trims the total down to what is still needed', () => {
    // validateEarmarks refuses total > required. A replan must not be a
    // way to arrive at a state the assign route would have rejected.
    const { rows } = carryEarmarksForward(
      [prev({ lots: [earmark({ quantity: 400 })] })],
      [fresh({ requiredWeight: 250 })]
    );
    expect(totalOf(rows[0])).toBe(250);
  });

  it('cuts the newest promise first', () => {
    // The oldest earmarks are what the floor has been planning against.
    const { rows } = carryEarmarksForward(
      [
        prev({
          lots: [
            earmark({ yarnLot: L1, lotNo: 'D-1', quantity: 200, assignedAt: day(1) }),
            earmark({ yarnLot: L2, lotNo: 'D-2', quantity: 200, assignedAt: day(9) }),
          ],
        }),
      ],
      [fresh({ requiredWeight: 300 })]
    );
    const byLot = Object.fromEntries(rows[0].lots.map((l) => [l.lotNo, l.quantity]));
    expect(byLot['D-1']).toBe(200);
    expect(byLot['D-2']).toBe(100);
  });

  it('drops a lot trimmed away to nothing instead of keeping a zero', () => {
    // A zero-quantity earmark fails the schema's `min: 0`... it passes,
    // which is worse: it saves as a promise of no yarn and shows on the
    // panel as a bag this order is waiting for.
    const { rows } = carryEarmarksForward(
      [
        prev({
          lots: [
            earmark({ yarnLot: L1, lotNo: 'D-1', quantity: 100, assignedAt: day(1) }),
            earmark({ yarnLot: L2, lotNo: 'D-2', quantity: 100, assignedAt: day(9) }),
          ],
        }),
      ],
      [fresh({ requiredWeight: 100 })]
    );
    expect(rows[0].lots).toHaveLength(1);
    expect(rows[0].lots[0].lotNo).toBe('D-1');
  });

  it('walks back through more than one lot when it has to', () => {
    const { rows } = carryEarmarksForward(
      [
        prev({
          lots: [
            earmark({ yarnLot: L1, lotNo: 'D-1', quantity: 100, assignedAt: day(1) }),
            earmark({ yarnLot: L2, lotNo: 'D-2', quantity: 100, assignedAt: day(5) }),
            earmark({ yarnLot: L3, lotNo: 'D-3', quantity: 100, assignedAt: day(9) }),
          ],
        }),
      ],
      [fresh({ requiredWeight: 50 })]
    );
    expect(totalOf(rows[0])).toBe(50);
    expect(rows[0].lots.map((l) => l.lotNo)).toEqual(['D-1']);
  });

  it('reports the trim rather than performing it quietly', () => {
    const { trimmed } = carryEarmarksForward(
      [prev({ lots: [earmark({ quantity: 400 })] })],
      [fresh({ requiredWeight: 250 })]
    );
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toMatchObject({ name: 'Nylon 40D', from: 400, to: 250, required: 250 });
  });

  it('cuts nothing when the total already fits exactly', () => {
    const { rows, trimmed } = carryEarmarksForward(
      [prev({ lots: [earmark({ quantity: 400 })] })],
      [fresh({ requiredWeight: 400 })]
    );
    expect(totalOf(rows[0])).toBe(400);
    expect(trimmed).toEqual([]);
  });

  it('does not report a float artefact as a trim', () => {
    // Three promises of 0.15 against a 0.45 requirement sum to
    // 0.44999999999999996 in IEEE floats — verified, not assumed. An
    // unrounded comparison would "trim" a quantity no scale can weigh
    // and log it as a change the planner never made.
    expect(0.15 * 3 <= 0.45).toBe(true);
    expect(0.1 + 0.2 <= 0.3).toBe(false);

    const { rows, trimmed } = carryEarmarksForward(
      [
        prev({
          lots: [
            earmark({ yarnLot: L1, lotNo: 'D-1', quantity: 0.1 }),
            earmark({ yarnLot: L2, lotNo: 'D-2', quantity: 0.2 }),
          ],
        }),
      ],
      [fresh({ requiredWeight: 0.3 })]
    );
    expect(trimmed).toEqual([]);
    expect(rows[0].lots).toHaveLength(2);
  });

  it('cuts the last-listed lot when nothing carries an assignedAt', () => {
    // Promises made before the field existed. Falling back to list
    // order keeps the rule ("newest first") rather than cutting an
    // arbitrary one.
    const { rows } = carryEarmarksForward(
      [
        prev({
          lots: [
            { yarnLot: L1, lotNo: 'D-1', quantity: 100 },
            { yarnLot: L2, lotNo: 'D-2', quantity: 100 },
          ],
        }),
      ],
      [fresh({ requiredWeight: 100 })]
    );
    expect(rows[0].lots.map((l) => l.lotNo)).toEqual(['D-1']);
  });
});

describe('when a material leaves the sheet', () => {
  it('reports what it could not keep', () => {
    // The row is gone, so the promises go with it whatever we do. The
    // difference between this and the silent wipe is that it says so.
    const { rows, dropped } = carryEarmarksForward(
      [
        prev({ rawMaterial: M1, lots: [earmark({ quantity: 100 })] }),
        prev({ rawMaterial: M2, name: 'Spandex', lots: [earmark({ yarnLot: L2, quantity: 60 })] }),
      ],
      [fresh({ rawMaterial: M1 })]
    );
    expect(rows).toHaveLength(1);
    expect(dropped).toEqual([
      { rawMaterial: String(M2), name: 'Spandex', quantity: 60 },
    ]);
  });

  it('says nothing about a material that left with no promises on it', () => {
    // Not every removed row is a loss worth logging.
    const { dropped } = carryEarmarksForward(
      [prev({ rawMaterial: M2, name: 'Spandex', lots: [] })],
      [fresh({ rawMaterial: M1 })]
    );
    expect(dropped).toEqual([]);
  });

  it('treats a requirement that fell to zero as a material that left', () => {
    const { rows, dropped } = carryEarmarksForward(
      [prev({ lots: [earmark({ quantity: 100 })] })],
      [fresh({ requiredWeight: 0 })]
    );
    expect(rows[0].lots).toEqual([]);
    expect(dropped).toEqual([{ rawMaterial: String(M1), name: 'Nylon 40D', quantity: 100 }]);
  });
});

describe('the shapes it is actually called with', () => {
  it('survives an order that had no requirement at all', () => {
    const { rows, trimmed, dropped } = carryEarmarksForward(undefined, [fresh()]);
    expect(rows[0].lots).toEqual([]);
    expect(trimmed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('survives a replan that computed nothing', () => {
    // Every elastic dropped off the plan. The old rows are all gone.
    const { rows, dropped } = carryEarmarksForward([prev()], []);
    expect(rows).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('survives rows with no lots field', () => {
    const { rows } = carryEarmarksForward(
      [{ rawMaterial: M1, name: 'Nylon 40D', requiredWeight: 400 }],
      [fresh()]
    );
    expect(rows[0].lots).toEqual([]);
  });

  it('does not mutate what it was given', () => {
    // The caller assigns the result. If this mutated in place, a throw
    // later in the request would leave the order half-changed.
    const before = prev({ lots: [earmark({ quantity: 400 })] });
    carryEarmarksForward([before], [fresh({ requiredWeight: 100 })]);
    expect(before.lots[0].quantity).toBe(400);
  });
});

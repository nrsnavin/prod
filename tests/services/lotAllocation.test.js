'use strict';

const mongoose = require('mongoose');
const {
  validateEarmarks,
  freeBalance,
  LIVE_ORDER_STATUSES,
} = require('../../services/lotAllocation');

// ═══════════════════════════════════════════════════════════════════
//  The rules that decide whether an earmark may be made.
//
//  Everything here is the PURE half of services/lotAllocation.js — the
//  arithmetic and the refusals — tested without a database, because
//  that is where the correctness of the feature lives. The queries
//  around it are wiring.
//
//  The one rule worth stating before reading: an earmark moves nothing
//  on the lot. `free` is `balance − earmarked-by-others`, and getting
//  that subtraction wrong is how two orders end up planning against
//  the same bag.
// ═══════════════════════════════════════════════════════════════════

const oid = () => new mongoose.Types.ObjectId();

const lot = (over = {}) => {
  const _id = over._id || oid();
  const receivedQty = over.receivedQty ?? 200;
  const consumedQty = over.consumedQty ?? 0;
  return {
    _id,
    lotNo: over.lotNo ?? 'D-1001',
    shade: over.shade ?? '',
    status: over.status ?? 'open',
    receivedQty,
    consumedQty,
    // Mirrors the model's virtual, so the tests exercise the same
    // shape the service is handed in production.
    balance: over.balance ?? Math.max(0, receivedQty - consumedQty),
  };
};

describe('freeBalance', () => {
  it('is the balance when nothing is earmarked', () => {
    expect(freeBalance(lot({ receivedQty: 200, consumedQty: 50 }), 0)).toBe(150);
  });

  it('subtracts what other orders have promised', () => {
    expect(freeBalance(lot({ receivedQty: 200, consumedQty: 50 }), 60)).toBe(90);
  });

  it('reads received minus consumed when no balance virtual came along', () => {
    const raw = { receivedQty: 200, consumedQty: 50 };
    expect(freeBalance(raw, 20)).toBe(130);
  });

  it('floors at zero rather than reporting a negative allowance', () => {
    // Possible after a batch draws more than the order promised. The
    // overdraw is a fact about the lot; a negative allowance is not
    // something anybody can act on.
    expect(freeBalance(lot({ receivedQty: 100, consumedQty: 90 }), 40)).toBe(0);
  });

  it('survives being handed nothing', () => {
    expect(freeBalance(null, 0)).toBe(0);
  });
});

describe('validateEarmarks — what it accepts', () => {
  it('takes a single lot inside its free balance', () => {
    const l = lot({ receivedQty: 200 });
    const out = validateEarmarks([{ yarnLot: l._id, quantity: 120 }], [l], new Map(), 400);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lotNo: 'D-1001', quantity: 120 });
    expect(String(out[0].yarnLot)).toBe(String(l._id));
  });

  it('allows a partial assignment against the requirement', () => {
    // 250 of 400 is an ordinary state for a long-lead yarn, not an error.
    const a = lot({ lotNo: 'D-1', receivedQty: 150 });
    const b = lot({ lotNo: 'D-2', receivedQty: 150 });
    const out = validateEarmarks(
      [{ yarnLot: a._id, quantity: 150 }, { yarnLot: b._id, quantity: 100 }],
      [a, b], new Map(), 400
    );
    expect(out.reduce((s, r) => s + r.quantity, 0)).toBe(250);
  });

  it('allows exactly the requirement', () => {
    const l = lot({ receivedQty: 400 });
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: 400 }], [l], new Map(), 400)
    ).not.toThrow();
  });

  it('accepts an empty list — that is how an assignment is cleared', () => {
    expect(validateEarmarks([], [lot()], new Map(), 400)).toEqual([]);
  });

  it('snapshots the lot number and shade onto the row', () => {
    // The order has to still read correctly when the lot is archived
    // years later, the same reason the warping programme snapshots.
    const l = lot({ lotNo: 'D-4471', shade: 'Navy' });
    const [row] = validateEarmarks([{ yarnLot: l._id, quantity: 10 }], [l], new Map(), 100);
    expect(row.lotNo).toBe('D-4471');
    expect(row.shade).toBe('Navy');
  });

  it('does not check the requirement when there is none recorded', () => {
    const l = lot({ receivedQty: 500 });
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: 500 }], [l], new Map(), 0)
    ).not.toThrow();
  });
});

describe('validateEarmarks — what it refuses', () => {
  it('refuses more than the lot has free', () => {
    const l = lot({ receivedQty: 200 });
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: 201 }], [l], new Map(), 400)
    ).toThrow(/has 200 kg free/);
  });

  it('counts another order’s promise against the free balance', () => {
    // 200 on the rack, 150 already promised elsewhere: 60 must fail
    // even though the rack plainly holds it.
    const l = lot({ receivedQty: 200 });
    const allocated = new Map([[String(l._id), 150]]);
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: 60 }], [l], allocated, 400)
    ).toThrow(/has 50 kg free/);
  });

  it('counts consumption against the free balance too', () => {
    const l = lot({ receivedQty: 200, consumedQty: 120 });
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: 100 }], [l], new Map(), 400)
    ).toThrow(/has 80 kg free/);
  });

  it('refuses more than the order requires', () => {
    const a = lot({ lotNo: 'D-1', receivedQty: 300 });
    const b = lot({ lotNo: 'D-2', receivedQty: 300 });
    expect(() =>
      validateEarmarks(
        [{ yarnLot: a._id, quantity: 300 }, { yarnLot: b._id, quantity: 200 }],
        [a, b], new Map(), 400
      )
    ).toThrow(/remove 100 kg/);
  });

  it('refuses the same lot twice rather than silently summing it', () => {
    // Summing would pass a free-balance check each line survives
    // individually but the pair does not.
    const l = lot({ lotNo: 'D-9', receivedQty: 200 });
    expect(() =>
      validateEarmarks(
        [{ yarnLot: l._id, quantity: 120 }, { yarnLot: l._id, quantity: 120 }],
        [l], new Map(), 400
      )
    ).toThrow(/listed twice/);
  });

  it('refuses a lot belonging to another material', () => {
    const mine = lot({ lotNo: 'D-1' });
    const theirs = lot({ lotNo: 'W-7' });
    expect(() =>
      validateEarmarks([{ yarnLot: theirs._id, quantity: 10 }], [mine], new Map(), 400)
    ).toThrow(/not on this material/);
  });

  it.each(['quarantined', 'closed', 'exhausted'])(
    'refuses a new promise on a %s lot',
    (status) => {
      const l = lot({ status, receivedQty: 200 });
      expect(() =>
        validateEarmarks([{ yarnLot: l._id, quantity: 10 }], [l], new Map(), 400)
      ).toThrow(new RegExp(status));
    }
  );

  it.each([0, -5, null, undefined, 'abc'])('refuses a quantity of %p', (q) => {
    const l = lot();
    expect(() =>
      validateEarmarks([{ yarnLot: l._id, quantity: q }], [l], new Map(), 400)
    ).toThrow(/more than zero/);
  });

  it('refuses a row with no lot chosen', () => {
    expect(() =>
      validateEarmarks([{ yarnLot: null, quantity: 10 }], [lot()], new Map(), 400)
    ).toThrow(/choose a lot/);
  });

  it('names the offending line, not just the problem', () => {
    const a = lot({ lotNo: 'D-1', receivedQty: 300 });
    const b = lot({ lotNo: 'D-2', receivedQty: 10 });
    expect(() =>
      validateEarmarks(
        [{ yarnLot: a._id, quantity: 50 }, { yarnLot: b._id, quantity: 90 }],
        [a, b], new Map(), 400
      )
    ).toThrow(/Lot 2/);
  });
});

describe('which orders hold yarn', () => {
  it('counts only the states that still have a claim', () => {
    // Completed drew its yarn, Cancelled gave it back. A status added
    // later must default to holding nothing, which is why this lists
    // the live ones rather than excluding the dead ones.
    expect([...LIVE_ORDER_STATUSES].sort()).toEqual(['Approved', 'InProgress']);
    expect(LIVE_ORDER_STATUSES).not.toContain('Completed');
    expect(LIVE_ORDER_STATUSES).not.toContain('Cancelled');
    expect(LIVE_ORDER_STATUSES).not.toContain('Open');
  });
});

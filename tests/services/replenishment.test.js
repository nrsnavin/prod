'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE REORDER-POINT ARITHMETIC
//
//  Pure functions, no database — so the arithmetic can be argued with
//  directly. Every figure the endpoint shows a buyer comes from here,
//  and a buyer who cannot see why the system asked for 800 kg will
//  order what they were going to order anyway.
// ══════════════════════════════════════════════════════════════════

const {
  dailyDemand,
  demandPattern,
  position,
  applyPurchaseRules,
  zFor,
} = require('../../services/replenishment');

const NOW = new Date('2026-08-14T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);

// ══════════════════════════════════════════════════════════════════
describe('daily demand from dated draws', () => {
  it('averages over every day in the window, not just the busy ones', () => {
    // 300 kg drawn once in 30 days is 10/day, not 300/day.
    const d = dailyDemand([{ at: daysAgo(5), quantity: 300 }], 30, NOW);
    expect(d.mean).toBe(10);
  });

  it('measures the spread, which is what safety stock is for', () => {
    // Same mean, wildly different risk. One 300 kg draw in 30 days has
    // a large sd; 10 kg every day has none.
    const lumpy = dailyDemand([{ at: daysAgo(5), quantity: 300 }], 30, NOW);
    const steady = dailyDemand(
      Array.from({ length: 30 }, (_, i) => ({ at: daysAgo(i), quantity: 10 })),
      30, NOW
    );
    expect(steady.mean).toBe(10);
    expect(steady.sd).toBe(0);
    expect(lumpy.sd).toBeGreaterThan(steady.sd);
  });

  it('ignores draws older than the window', () => {
    const d = dailyDemand([{ at: daysAgo(90), quantity: 3000 }], 30, NOW);
    expect(d.mean).toBe(0);
  });

  it('sums several draws landing on the same day', () => {
    const d = dailyDemand(
      [{ at: daysAgo(2), quantity: 100 }, { at: daysAgo(2), quantity: 200 }],
      30, NOW
    );
    expect(d.mean).toBe(10);
  });

  it('treats a negative quantity as nothing rather than a credit', () => {
    const d = dailyDemand([{ at: daysAgo(1), quantity: -500 }], 30, NOW);
    expect(d.mean).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('how lumpy the demand is', () => {
  const on = (dayList) => dailyDemand(dayList.map((n) => ({ at: daysAgo(n), quantity: 10 })), 30, NOW);

  it('calls a yarn drawn most days smooth', () => {
    const days = Array.from({ length: 25 }, (_, i) => i);
    expect(demandPattern(on(days), days.length)).toBe('smooth');
  });

  it('calls a yarn drawn twice a month intermittent', () => {
    // The normal-based safety stock over-orders here, because sigma is
    // dominated by the zero days. Worth telling the buyer.
    expect(demandPattern(on([2, 17, 25]), 3)).toBe('intermittent');
  });

  it('refuses to characterise a yarn with almost no history', () => {
    expect(demandPattern(on([2]), 1)).toBe('new');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the reorder point', () => {
  const steady = { mean: 10, sd: 0 };

  it('covers demand during the wait', () => {
    // 10/day for a 14-day lead time is 140 kg in the pipe.
    const p = position({ onHand: 500, demand: steady, leadTimeDays: 14, now: NOW });
    expect(p.demandDuringLead).toBe(140);
    expect(p.reorderPoint).toBe(140);
  });

  it('adds safety stock for variable demand', () => {
    const p = position({
      onHand: 500, demand: { mean: 10, sd: 4 },
      leadTimeDays: 16, serviceLevel: 95, now: NOW,
    });
    // z(95) × 4 × √16 = 1.6449 × 4 × 4 = 26.32
    expect(p.safetyStock).toBeCloseTo(26.32, 1);
    expect(p.reorderPoint).toBeCloseTo(186.32, 1);
  });

  it('grows safety stock with the SQUARE ROOT of lead time', () => {
    const at = (L) => position({ demand: { mean: 10, sd: 4 }, leadTimeDays: L, now: NOW }).safetyStock;
    // Quadrupling the lead time doubles the safety stock. Using L
    // instead of √L would quadruple it — four times the yarn on the
    // floor for the same risk.
    expect(at(16) / at(4)).toBeCloseTo(2, 5);
  });

  it('never falls below the manual floor somebody set', () => {
    // A dye lot that must not be split, a supplier who vanishes in the
    // monsoon — reasons the statistics cannot see.
    const p = position({ demand: steady, leadTimeDays: 2, minStock: 500, now: NOW });
    expect(p.reorderPoint).toBe(500);
  });

  it('is zero-lead-time when nobody has set one, which is the old behaviour', () => {
    const p = position({ onHand: 100, demand: steady, leadTimeDays: 0, now: NOW });
    expect(p.reorderPoint).toBe(0);
    expect(p.shouldOrder).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('net stock — the number that stops double-ordering', () => {
  const steady = { mean: 10, sd: 0 };

  it('counts stock that is already coming', () => {
    const p = position({
      onHand: 50, onOrder: 500, demand: steady, leadTimeDays: 14, now: NOW,
    });
    expect(p.netStock).toBe(550);
    expect(p.shouldOrder).toBe(false);   // 550 covers a 140 reorder point
  });

  it('subtracts stock that is spoken for', () => {
    const p = position({
      onHand: 500, committed: 400, demand: steady, leadTimeDays: 14, now: NOW,
    });
    expect(p.netStock).toBe(100);
    expect(p.shouldOrder).toBe(true);    // 100 is under the 140 point
  });

  it('does the two together', () => {
    const p = position({
      onHand: 100, onOrder: 300, committed: 250, demand: steady, leadTimeDays: 14, now: NOW,
    });
    expect(p.netStock).toBe(150);
  });

  it('can go negative, and that is critical rather than hidden', () => {
    const p = position({
      onHand: 10, committed: 500, demand: steady, leadTimeDays: 7, now: NOW,
    });
    expect(p.netStock).toBe(-490);
    expect(p.severity).toBe('critical');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('how much to order', () => {
  const steady = { mean: 10, sd: 0 };

  it('buys up to the reorder point plus a period of running', () => {
    const p = position({
      onHand: 100, demand: steady, leadTimeDays: 14, coverDays: 30, now: NOW,
    });
    // target = 140 + 300 = 440; net = 100 → 340
    expect(p.suggestedQty).toBe(340);
  });

  it('orders nothing when the position is comfortable', () => {
    const p = position({ onHand: 5000, demand: steady, leadTimeDays: 14, now: NOW });
    expect(p.shouldOrder).toBe(false);
    expect(p.suggestedQty).toBe(0);
  });

  it('does not re-buy what a purchase order already covers', () => {
    const bare = position({ onHand: 100, demand: steady, leadTimeDays: 14, now: NOW });
    const covered = position({
      onHand: 100, onOrder: 340, demand: steady, leadTimeDays: 14, now: NOW,
    });
    expect(bare.suggestedQty).toBe(340);
    expect(covered.suggestedQty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  The number the whole thing exists to produce.
// ══════════════════════════════════════════════════════════════════
describe('the date to order by', () => {
  const steady = { mean: 10, sd: 0 };

  it('is the stockout date less the lead time', () => {
    // 200 on hand at 10/day runs out in 20 days; a 14-day lead time
    // means the order has to leave in 6.
    const p = position({ onHand: 200, demand: steady, leadTimeDays: 14, now: NOW });
    expect(p.projectedStockoutDate).toBe('2026-09-03');
    expect(p.orderByDate).toBe('2026-08-20');
    expect(p.alreadyLate).toBe(false);
  });

  it('says so when an order placed today already arrives too late', () => {
    // 50 on hand at 10/day is 5 days of cover against a 14-day wait.
    // This is the case that stops a loom, and it is not the same thing
    // as "below the reorder point".
    const p = position({ onHand: 50, demand: steady, leadTimeDays: 14, now: NOW });
    expect(p.alreadyLate).toBe(true);
    expect(p.severity).toBe('critical');
  });

  it('gives no date for a material nothing consumes', () => {
    // "Order by" on a yarn with no demand is noise, not information.
    const p = position({ onHand: 100, demand: { mean: 0, sd: 0 }, leadTimeDays: 14, now: NOW });
    expect(p.orderByDate).toBeNull();
    expect(p.daysOfCover).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what the supplier will actually sell', () => {
  it('rounds up to the pack size', () => {
    expect(applyPurchaseRules(812, { packSize: 25 })).toBe(825);
  });

  it('lifts to the minimum order quantity', () => {
    expect(applyPurchaseRules(40, { minOrderQty: 100 })).toBe(100);
  });

  it('applies the minimum first, then the pack', () => {
    expect(applyPurchaseRules(40, { minOrderQty: 100, packSize: 30 })).toBe(120);
  });

  it('leaves nothing as nothing', () => {
    expect(applyPurchaseRules(0, { minOrderQty: 100, packSize: 25 })).toBe(0);
  });

  it('is a no-op when the supplier has no rules recorded', () => {
    expect(applyPurchaseRules(812)).toBe(812);
  });
});

describe('service levels', () => {
  it('asks for more cover the less often you will tolerate a stockout', () => {
    expect(zFor(90)).toBeLessThan(zFor(95));
    expect(zFor(95)).toBeLessThan(zFor(99));
  });

  it('falls back to 95% for anything it does not recognise', () => {
    expect(zFor(73)).toBe(zFor(95));
  });
});

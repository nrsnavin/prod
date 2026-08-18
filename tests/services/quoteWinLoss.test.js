'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE QUOTES ALREADY KNEW
//
//  Quote.status has carried accepted / declined / expired since the
//  quotation module shipped. Nothing read it. This is the report that
//  does — and because it is a report about PRICING, the failure mode
//  that matters is not a crash. It is a number that looks reasonable
//  and is wrong, read by somebody about to name a price to a customer.
//
//  So the tests below are mostly about restraint:
//
//    • it must not count quotes the customer never answered
//    • it must not let a customer's own outcome predict itself
//    • it must not draw a curve through nine data points
//    • it must not report 0% when it means "nobody has decided"
//    • and it must never, anywhere, set a price
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, winLoss, Quote, I;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  winLoss = require('../../services/quoteWinLoss');
  I       = winLoss._internals;
  Quote   = require('../../models/Quote');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Quote.deleteMany({}); });

let seq = 0;

/**
 * A quote priced at `marginPct` over cost.
 *
 * The costing is written the way the app writes it — frozen per-line —
 * so the tests exercise the same fields the report reads in production.
 */
function quote({ marginPct = 20, qty = 1000, status = 'accepted', customer, date, cost = 10, lines } = {}) {
  const unitCost = cost;
  const rate = unitCost * (1 + marginPct / 100);
  seq += 1;
  return {
    quoteNo: `QT-25/26-${String(seq).padStart(4, '0')}`,
    financialYear: '25/26',
    sequence: seq,
    date: date || new Date(2026, 0, seq),
    validTill: new Date(2026, 2, seq),
    customer: customer || undefined,
    customerName: customer ? `Cust-${String(customer).slice(-4)}` : `Walk-in ${seq}`,
    status,
    totalQuantityMetres: qty,
    grandTotal: rate * qty,
    lines: lines || [{
      productName: '20mm elastic',
      quantityMetres: qty,
      totalCost: unitCost,
      rateBeforeTax: rate,
      marginPercent: marginPct,
    }],
  };
}

const seedMany = (rows) => Quote.insertMany(rows);

// ══════════════════════════════════════════════════════════════════
//  1. THE PRICE RATIO — the one number everything rests on
// ══════════════════════════════════════════════════════════════════
describe('priceRatio', () => {
  test('is the quantity-weighted ratio of price to cost, not a flat average', () => {
    // A quote is won or lost on the money. A 2000 m line at a thin
    // margin dominates a 50 m line priced fat, and averaging the two
    // flat would report a margin nobody quoted.
    const q = {
      lines: [
        { quantityMetres: 2000, totalCost: 10, rateBeforeTax: 11 },   // +10%
        { quantityMetres: 50,   totalCost: 10, rateBeforeTax: 20 },   // +100%
      ],
    };
    const ratio = I.priceRatio(q);
    // Weighted: (2000×11 + 50×20) / (2000×10 + 50×10) = 23000/20500
    expect(ratio).toBeCloseTo(23000 / 20500, 6);
    // A flat average would be 1.55 — wildly higher, and wrong.
    expect(ratio).toBeLessThan(1.2);
  });

  test('a line with no costing behind it contributes nothing', () => {
    // Defaulting it to cost would drag the whole curve toward 1.0 and
    // attribute wins to a margin that was never quoted.
    const q = { lines: [
      { quantityMetres: 100, totalCost: 10, rateBeforeTax: 13 },
      { quantityMetres: 100, totalCost: 0,  rateBeforeTax: 0 },
    ] };
    expect(I.priceRatio(q)).toBeCloseTo(1.3, 6);
  });

  test('a quantity-less quote still counts, at a weight of one metre', () => {
    // Quotes are written for developments that do not have a quantity
    // yet. Dropping them would discard exactly the exploratory pricing
    // this report is most useful for.
    expect(I.priceRatio({ lines: [{ totalCost: 10, rateBeforeTax: 14 }] })).toBeCloseTo(1.4, 6);
  });

  test('a quote with nothing costed is null, not 1.0', () => {
    expect(I.priceRatio({ lines: [] })).toBeNull();
    expect(I.priceRatio({ lines: [{ totalCost: 0, rateBeforeTax: 0 }] })).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. WHAT COUNTS AS EVIDENCE
// ══════════════════════════════════════════════════════════════════
describe('which quotes are counted', () => {
  test('only quotes the customer actually answered', async () => {
    await seedMany([
      quote({ status: 'accepted' }),
      quote({ status: 'declined' }),
      quote({ status: 'expired' }),
      quote({ status: 'draft' }),      // never sent
      quote({ status: 'sent' }),       // still in play
      quote({ status: 'cancelled' }),  // withdrawn by us
    ]);

    const out = await winLoss.analyse({});
    // A draft is not a loss. A quote still out is not a loss. A quote we
    // pulled is not the customer saying no. Folding any of them in
    // would move the win rate with how tidy the sales desk is.
    expect(out.quotes).toBe(3);
    expect(out.wins).toBe(1);
    expect(out.losses).toBe(2);
  });

  test('declined and expired are reported apart, because they are not the same evidence', async () => {
    // A decline is the customer saying no to a price. An expiry may be
    // a quote nobody chased. Somebody reading a poor win rate deserves
    // to know which of the two it is made of.
    await seedMany([
      quote({ status: 'accepted' }),
      quote({ status: 'declined' }),
      quote({ status: 'expired' }),
      quote({ status: 'expired' }),
    ]);

    const out = await winLoss.analyse({});
    expect(out.lossBreakdown).toEqual({ declined: 1, expired: 2 });
    expect(out.baselineWinRatePct).toBe(25);
  });

  test('an uncosted quote is dropped rather than counted at cost', async () => {
    await seedMany([
      quote({ status: 'accepted' }),
      { ...quote({ status: 'declined' }), lines: [{ productName: 'x', totalCost: 0, rateBeforeTax: 0 }] },
    ]);
    expect((await winLoss.analyse({})).quotes).toBe(1);
  });

  test('no data reports as no data, never as a zero win rate', async () => {
    // "0%" and "nobody has quoted" are different claims. Only one is
    // true here, and the wrong one would read as a catastrophe.
    const out = await winLoss.analyse({});
    expect(out.quotes).toBe(0);
    expect(out.baselineWinRatePct).toBeNull();
    expect(out.estimator).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. THE LEAK THAT WOULD HAVE MADE THIS USELESS
// ══════════════════════════════════════════════════════════════════
describe('customer history is computed leave-one-out', () => {
  const rows = (spec) => spec.map((s, i) => ({
    customerKey: s.c, date: new Date(2026, 0, i + 1), won: s.won,
  }));

  test("a quote's own outcome is not inside the feature used to predict it", () => {
    // The failure this prevents: a model that scores beautifully in
    // testing and predicts nothing at all, because the feature was the
    // label wearing a hat.
    const r = rows([
      { c: 'A', won: true },
      { c: 'A', won: true },
      { c: 'A', won: false },
    ]);

    // Row 2 (index 2, a loss) sees only rows 0 and 1 — both wins.
    expect(I.customerPriorWinRate(r, 2)).toEqual({ rate: 1, n: 2 });
    // Row 0 has nothing before it at all.
    expect(I.customerPriorWinRate(r, 0)).toBeNull();
  });

  test('a customer\'s LATER decisions cannot predict an earlier one', () => {
    // The same leak wearing a different hat: using September's
    // acceptance to explain a quote sent in March is knowledge the
    // model would not have had on the day.
    const r = rows([
      { c: 'A', won: false },   // Jan
      { c: 'A', won: true },    // Feb
      { c: 'A', won: true },    // Mar
    ]);
    // Row 1 sees only January's loss — not March's win.
    expect(I.customerPriorWinRate(r, 1)).toEqual({ rate: 0, n: 1 });
  });

  test('other customers do not contribute', () => {
    const r = rows([
      { c: 'A', won: true },
      { c: 'B', won: false },
      { c: 'A', won: false },
    ]);
    expect(I.customerPriorWinRate(r, 2)).toEqual({ rate: 1, n: 1 });
  });

  test('a walk-in with no customer record has no history', () => {
    expect(I.customerPriorWinRate(rows([{ c: null, won: true }, { c: null, won: false }]), 1)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. THE ESTIMATOR IT CHOOSES, AND WHEN IT REFUSES TO CHOOSE ONE
// ══════════════════════════════════════════════════════════════════
describe('estimator selection', () => {
  test('nine quotes get bands and no curve', async () => {
    // With nine quotes a fitted curve is theatre. The bands are the
    // observed history; the note says so in those words.
    await seedMany(Array.from({ length: 9 }, (_, i) =>
      quote({ marginPct: 10 + i * 3, status: i % 2 ? 'accepted' : 'declined' })));

    const out = await winLoss.analyse({});
    expect(out.estimator).toBe('empirical');
    expect(out.curve).toEqual([]);
    expect(out.bands.length).toBeGreaterThan(0);
    expect(out.note).toMatch(/too few to fit a curve/i);
  });

  test('plenty of quotes but all won still gets no curve', async () => {
    // Forty wins and no losses cannot produce a win/loss curve, however
    // many rows there are. Fitting one would report a confident 100%
    // at every price on earth.
    await seedMany(Array.from({ length: 40 }, (_, i) =>
      quote({ marginPct: 5 + i, status: 'accepted' })));

    const out = await winLoss.analyse({});
    expect(out.estimator).toBe('empirical');
    expect(out.note).toMatch(/one side of the outcome/i);
  });

  test('a healthy history gets a fitted curve', async () => {
    await seedMany(makeRealisticHistory(80));
    const out = await winLoss.analyse({});
    expect(out.estimator).toBe('logistic');
    expect(out.curve.length).toBeGreaterThan(5);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. DOES THE CURVE POINT THE RIGHT WAY?
// ══════════════════════════════════════════════════════════════════

/**
 * A history where price genuinely drives the outcome: cheap quotes are
 * usually taken, expensive ones usually are not, with enough noise that
 * the fit has to actually work rather than memorise.
 */
function makeRealisticHistory(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const marginPct = 5 + (i * 53) % 50;           // spread 5–55
    // Win probability falls with margin. Deterministic so the test is
    // not flaky — a seeded pattern, not a random draw.
    const winsAt = marginPct < 20 ? true : marginPct < 35 ? (i % 3 !== 0) : (i % 4 === 0);
    rows.push(quote({
      marginPct,
      status: winsAt ? 'accepted' : 'declined',
      qty: 500 + (i % 5) * 300,
    }));
  }
  return rows;
}

describe('the fitted curve', () => {
  test('win probability falls as margin rises', async () => {
    // The one thing the model must get right. If it points the other
    // way, everything downstream is worse than nothing.
    await seedMany(makeRealisticHistory(80));
    const { curve } = await winLoss.analyse({});

    const at10 = curve.find((c) => c.marginPct === 10).winProbabilityPct;
    const at50 = curve.find((c) => c.marginPct === 50).winProbabilityPct;
    expect(at10).toBeGreaterThan(at50);
  });

  test('it names the margin with the best expected return, which is never at cost', async () => {
    // The highest-probability price is always the cheapest one, and
    // that is not the price you want. Expected margin points — win
    // probability times the margin — is the figure worth reading.
    await seedMany(makeRealisticHistory(80));
    const out = await winLoss.analyse({});

    expect(out.bestExpectedMarginPct).toBeGreaterThan(0);
    const best = out.curve.find((c) => c.marginPct === out.bestExpectedMarginPct);
    for (const c of out.curve) {
      expect(c.expectedMarginPoints).toBeLessThanOrEqual(best.expectedMarginPoints);
    }
  });

  test('probabilities stay inside 0–100', async () => {
    await seedMany(makeRealisticHistory(80));
    for (const c of (await winLoss.analyse({})).curve) {
      expect(c.winProbabilityPct).toBeGreaterThanOrEqual(0);
      expect(c.winProbabilityPct).toBeLessThanOrEqual(100);
    }
  });

  test('L2 keeps a perfectly separated fit from claiming certainty', () => {
    // Quote data separates easily — "every quote above 40% lost" happens
    // on a handful of rows. Unregularised, that coefficient runs to
    // infinity and the model reports a 0% chance with total confidence
    // on the strength of three quotes.
    const X = [];
    const y = [];
    for (let i = 0; i < 30; i++) {
      X.push([i < 15 ? -1 : 1]);
      y.push(i < 15 ? 1 : 0);      // perfectly separable
    }
    const { w } = I.fitLogistic(X, y, { l2: 1.0 });
    expect(Math.abs(w[0])).toBeLessThan(20);
    expect(Number.isFinite(w[0])).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. THE BANDS
// ══════════════════════════════════════════════════════════════════
describe('empirical bands', () => {
  test('report the observed rate and the count behind it', () => {
    const rows = [
      { marginPct: 5,  won: true },
      { marginPct: 8,  won: true },
      { marginPct: 9,  won: false },
      { marginPct: 25, won: false },
    ];
    const bands = I.empiricalBands(rows);
    const low = bands.find((b) => b.band === '0–10%');
    expect(low).toMatchObject({ quotes: 3, wins: 2, winRatePct: 67 });
    const mid = bands.find((b) => b.band === '20–30%');
    expect(mid).toMatchObject({ quotes: 1, wins: 0, winRatePct: 0 });
  });

  test('a thin band is flagged rather than quietly reported as fact', () => {
    // One quote in a band is one quote. "100%" from a single sale is
    // how somebody talks themselves into a price.
    const bands = I.empiricalBands([{ marginPct: 25, won: true }]);
    expect(bands.find((b) => b.band === '20–30%')).toMatchObject({ quotes: 1, thin: true });
  });

  test('an empty band reports null, not zero', () => {
    const bands = I.empiricalBands([{ marginPct: 25, won: true }]);
    expect(bands.find((b) => b.band === '30–45%')).toMatchObject({ quotes: 0, winRatePct: null });
  });

  test('a quote priced below cost lands in its own band', () => {
    // It happens, and it is worth seeing separately — a win at a loss
    // is not a pricing success.
    const bands = I.empiricalBands([{ marginPct: -5, won: true }]);
    expect(bands[0]).toMatchObject({ band: 'at or below cost', quotes: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. NARROWING, AND THE PER-QUOTE VIEW
// ══════════════════════════════════════════════════════════════════
describe('filters and the per-quote view', () => {
  test('a customer filter narrows to that customer', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    await seedMany([
      quote({ customer: a, status: 'accepted' }),
      quote({ customer: a, status: 'accepted' }),
      quote({ customer: b, status: 'declined' }),
    ]);

    const out = await winLoss.analyse({ customerId: a });
    expect(out.quotes).toBe(2);
    expect(out.baselineWinRatePct).toBe(100);
    expect(out.filters.customerId).toBe(a);
  });

  test('a window excludes older history', async () => {
    await seedMany([
      quote({ status: 'accepted', date: new Date(2020, 0, 1) }),
      quote({ status: 'declined', date: new Date() }),
    ]);
    expect((await winLoss.analyse({ days: 30 })).quotes).toBe(1);
  });

  test('the per-quote view reports this quote\'s own margin beside the history', async () => {
    const cust = new mongoose.Types.ObjectId();
    await seedMany(makeRealisticHistory(80));
    const [live] = await Quote.insertMany([quote({ marginPct: 30, status: 'sent', customer: cust })]);

    const out = await winLoss.forQuote(live._id);
    expect(out.marginPct).toBeCloseTo(30, 1);
    // The quote being examined is still 'sent', so it is not in its own
    // evidence — it has not happened yet.
    expect(out.overall.quotes).toBe(80);
    expect(out.atThisPrice.marginPct).toBe(30);
  });

  test('a missing quote is null rather than an exception', async () => {
    expect(await winLoss.forQuote(new mongoose.Types.ObjectId())).toBeNull();
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  PRICING ONE METRE
//
//  Every figure on a quote comes out of this, and a quote is a number
//  a customer holds you to. So the arithmetic is pinned here rather
//  than exercised through a route, where a wrong rate would be one
//  assertion among twenty.
//
//  The chain, and the two places it is easy to get wrong:
//
//    • grams ÷ 1000 × ₹/kg — the unit conversion. Weights are entered
//      in grams and rates in rupees per KILOGRAM, so a factor of a
//      thousand sits between them, and getting it upside down produces
//      a rate that looks plausible and is out by 1000×.
//
//    • margin is a MARKUP ON COST — cost × (1 + m%) — not a margin on
//      the selling price. 20% on ₹100 is ₹120 here, not ₹125. The two
//      sound identical in conversation.
// ══════════════════════════════════════════════════════════════════

const { priceOneMetre, rowCost, extend, round } = require('../../utils/quoteCosting');

// A real-ish 20mm woven elastic, one metre of it.
const recipe = () => ({
  materials: [
    { label: 'Warp yarn',       weightGrams: 4.2, ratePerKg: 240 },
    { label: 'Spandex covering', weightGrams: 1.1, ratePerKg: 620 },
    { label: 'Warp spandex',    weightGrams: 0.8, ratePerKg: 900 },
    { label: 'Weft yarn',       weightGrams: 2.4, ratePerKg: 180 },
  ],
  conversionCost: 1.25,
  marginPercent: 20,
  gstPercent: 5,
});

describe('a single material row', () => {
  it('converts grams against a rate per kilogram', () => {
    // 4.2 g of yarn at ₹240/kg = 4.2/1000 × 240 = ₹1.008
    expect(rowCost(4.2, 240)).toBe(1.008);
  });

  it('is a thousandth of the naive product, not the product', () => {
    // The upside-down version of this returns 1008. If this ever reads
    // that, the unit conversion has been inverted.
    expect(rowCost(4.2, 240)).toBeLessThan(2);
  });

  it('costs nothing when either half is missing', () => {
    expect(rowCost(0, 240)).toBe(0);
    expect(rowCost(4.2, 0)).toBe(0);
    expect(rowCost(undefined, undefined)).toBe(0);
  });

  it('treats a negative weight or rate as nothing, never as a credit', () => {
    // A minus sign typed into a weight must not discount the quote.
    expect(rowCost(-4.2, 240)).toBe(0);
    expect(rowCost(4.2, -240)).toBe(0);
  });

  it('ignores text and other rubbish', () => {
    expect(rowCost('abc', 240)).toBe(0);
    expect(rowCost(4.2, 'abc')).toBe(0);
    expect(rowCost(NaN, Infinity)).toBe(0);
  });
});

describe('the chain from materials to the price', () => {
  const q = priceOneMetre(recipe());

  it('sums the material rows', () => {
    // 1.008 + 0.682 + 0.72 + 0.432
    expect(q.materialCost).toBe(2.842);
  });

  it('adds conversion to reach the cost of a metre', () => {
    expect(q.totalCost).toBe(round(2.842 + 1.25)); // 4.092
  });

  it('marks the cost UP by the margin, and quotes it in paise', () => {
    // 4.092 × 1.20 = 4.9104, quoted as 4.91 — not 4.092 / 0.8 = 5.115.
    expect(q.rateBeforeTax).toBe(4.91);
  });

  it('states the margin in rupees as well as percent', () => {
    expect(q.marginAmount).toBe(0.82); // 4.91 − 4.092, to paise
  });

  it('takes GST on the QUOTED rate, not on the unrounded one', () => {
    expect(q.gstAmount).toBe(0.25);   // 4.91 × 5%
    expect(q.rateInclTax).toBe(5.16); // and they add up exactly
    expect(q.rateInclTax).toBe(q.rateBeforeTax + q.gstAmount);
  });

  it('quotes a rate that a reader can multiply', () => {
    // The whole point of rounding here: every printed figure is exact at
    // the precision it is printed to.
    expect(extend(q.rateBeforeTax, 25_000)).toBe(122750);
    expect(extend(q.rateInclTax, 25_000)).toBe(129000);
  });

  it('keeps the line costs adding up to the material total shown', () => {
    // What is printed must reconcile. A reader adding the column by
    // hand and getting a different answer discredits the whole sheet.
    const summed = q.materials.reduce((s, r) => s + r.cost, 0);
    expect(round(summed)).toBe(q.materialCost);
  });

  it('reports the total grams in a metre', () => {
    expect(q.totalWeightGrams).toBe(8.5);
  });
});

describe('the margin, stated as plainly as possible', () => {
  const flat = (marginPercent) => priceOneMetre({
    materials: [{ label: 'X', weightGrams: 1000, ratePerKg: 100 }], // ₹100
    conversionCost: 0, marginPercent, gstPercent: 0,
  });

  it('20% on ₹100 of cost is ₹120', () => {
    expect(flat(20).totalCost).toBe(100);
    expect(flat(20).rateBeforeTax).toBe(120);
  });

  it('is not ₹125 — that is the other convention', () => {
    expect(flat(20).rateBeforeTax).not.toBe(125);
  });

  it('0% leaves the price at cost', () => {
    expect(flat(0).rateBeforeTax).toBe(100);
  });

  it('100% doubles it', () => {
    expect(flat(100).rateBeforeTax).toBe(200);
  });
});

describe('rows that are not filled in', () => {
  it('keeps an empty row rather than dropping it', () => {
    // The form ships with four named rows. One left blank must still be
    // a row — a line that disappears as you clear it is worse than one
    // reading zero.
    const q = priceOneMetre({
      materials: [
        { label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 },
        { label: 'Weft yarn', weightGrams: 0,   ratePerKg: 0 },
      ],
      conversionCost: 0, marginPercent: 0, gstPercent: 0,
    });
    expect(q.materials).toHaveLength(2);
    expect(q.materials[1].cost).toBe(0);
    expect(q.materialCost).toBe(1.008);
  });

  it('prices a quote with no materials at just the conversion cost', () => {
    const q = priceOneMetre({ materials: [], conversionCost: 2, marginPercent: 10, gstPercent: 5 });
    expect(q.materialCost).toBe(0);
    expect(q.totalCost).toBe(2);
    expect(q.rateBeforeTax).toBe(2.2);
  });

  it('survives being called with nothing at all', () => {
    const q = priceOneMetre();
    expect(q.totalCost).toBe(0);
    expect(q.rateInclTax).toBe(0);
    expect(q.materials).toEqual([]);
  });

  it('survives materials being the wrong type entirely', () => {
    expect(priceOneMetre({ materials: 'nonsense' }).materials).toEqual([]);
    expect(priceOneMetre({ materials: null }).totalCost).toBe(0);
  });
});

describe('rows the user added beyond the four', () => {
  it('prices any number of extra materials the same way', () => {
    const q = priceOneMetre({
      materials: [
        ...recipe().materials,
        { label: 'Dye',      weightGrams: 0.5, ratePerKg: 400 }, // 0.2
        { label: 'Finish',   weightGrams: 0.3, ratePerKg: 300 }, // 0.09
      ],
      conversionCost: 0, marginPercent: 0, gstPercent: 0,
    });
    expect(q.materials).toHaveLength(6);
    expect(q.materialCost).toBe(round(2.842 + 0.2 + 0.09));
  });
});

describe('extending a rate over a quantity', () => {
  it('multiplies out to two places, because it is a money total', () => {
    expect(extend(4.91, 5000)).toBe(24550);
  });

  it('rounds a fractional total to paise', () => {
    expect(extend(1.005, 3)).toBe(3.02);
  });

  it('is zero for a missing quantity', () => {
    expect(extend(4.91, 0)).toBe(0);
    expect(extend(4.91, undefined)).toBe(0);
  });
});

describe('precision', () => {
  it('carries four places through the COSTING, so a small material is not flattened', () => {
    // At two places 0.4536 would become 0.45 — 1.3% out, which over a
    // 50,000 m order is real money. Only the final quoted rate rounds.
    const q = priceOneMetre({
      materials: [{ label: 'X', weightGrams: 1.26, ratePerKg: 360 }],
      conversionCost: 0, marginPercent: 0, gstPercent: 0,
    });
    expect(q.materialCost).toBe(0.4536);
  });

  it('does not accumulate a floating-point tail', () => {
    const q = priceOneMetre({
      materials: [
        { label: 'A', weightGrams: 0.1, ratePerKg: 100 },
        { label: 'B', weightGrams: 0.2, ratePerKg: 100 },
      ],
      conversionCost: 0, marginPercent: 0, gstPercent: 0,
    });
    // 0.01 + 0.02, which in binary floating point is 0.030000000000000002
    expect(q.materialCost).toBe(0.03);
  });
});

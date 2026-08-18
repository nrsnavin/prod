'use strict';
// ══════════════════════════════════════════════════════════════════
//  20mm AND 25mm ARE NOT THE SAME PRODUCT
//
//  This matcher decides which elastic a line on a customer's purchase
//  order refers to. Get it wrong and an order is drafted for the wrong
//  cloth — a different beam, a different rate, and a lot the customer
//  sends back.
//
//  "20mm Knitted Elastic - White" and "25mm Knitted Elastic - White"
//  are one character apart. Every general-purpose string-similarity
//  library scores them around 0.9 and would confidently pick either.
//  That is the single failure this file exists to prevent, and the
//  rule — numbers compared separately, a conflict BLOCKS rather than
//  merely lowers the score — is what these tests are mostly about.
// ══════════════════════════════════════════════════════════════════

const F = require('../../utils/fuzzyMatch');

const elastics = [
  { id: 'e20', label: '20mm Knitted Elastic - White' },
  { id: 'e25', label: '25mm Knitted Elastic - White' },
  { id: 'e20b', label: '20mm Knitted Elastic - Black' },
  { id: 'e38', label: '38mm Woven Elastic - Natural' },
];

// ══════════════════════════════════════════════════════════════════
//  1. THE NUMERIC RULE
// ══════════════════════════════════════════════════════════════════
describe('a width conflict blocks a candidate outright', () => {
  test('25mm is never offered for a 20mm line, at any score', () => {
    // Everything else about the two strings is identical. Edit distance
    // says 0.96. The answer still has to be "not this one".
    const { candidates, blocked } = F.rank('20MM KNITTED ELASTIC WHITE', elastics);

    expect(candidates.map((c) => c.id)).not.toContain('e25');
    expect(blocked.map((b) => b.id)).toContain('e25');
    expect(blocked.find((b) => b.id === 'e25').reason).toMatch(/says 20 .* this says 25/);
  });

  test('the block is reported with its reason, not silently dropped', () => {
    // Somebody looking for a product that is not in the list needs to
    // see WHY it was withheld, or they will assume the master is
    // missing it and create a duplicate.
    const { blocked } = F.rank('20mm elastic', elastics);
    expect(blocked.length).toBeGreaterThan(0);
    for (const b of blocked) expect(b.reason).toMatch(/says/);
  });

  test('a candidate with no numbers at all is still comparable', () => {
    // "Elastic Tape" carries no width. It cannot conflict, so it is
    // scored on words alone rather than blocked.
    const { candidates } = F.rank('20mm elastic tape', [{ id: 'x', label: 'Elastic Tape' }]);
    expect(candidates.map((c) => c.id)).toContain('x');
  });

  test('a query with no numbers does not block anything', () => {
    const { blocked } = F.rank('knitted elastic white', elastics);
    expect(blocked).toEqual([]);
  });

  test('units and spacing do not change the number', () => {
    // A PO says "20 MM", the master says "20mm". Same product.
    for (const q of ['20 MM knitted elastic', '20mm knitted elastic', '20MM  Knitted  Elastic']) {
      const { best } = F.rank(q, elastics);
      expect(best.id).toMatch(/^e20/);
    }
  });

  test('a length on the line does not conflict with a width', () => {
    // "20mm x 100m" names two numbers; the master names one. Sharing
    // ONE is enough — the conflict rule fires only when they share none.
    const { candidates } = F.rank('20mm x 100m knitted elastic white', elastics);
    expect(candidates[0].id).toBe('e20');
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. WHEN A MATCH MAY BE PRESELECTED
// ══════════════════════════════════════════════════════════════════
describe('confidence', () => {
  test('a clear winner is confident', () => {
    const { confident, best } = F.rank('20mm Knitted Elastic - White', elastics);
    expect(confident).toBe(true);
    expect(best.id).toBe('e20');
  });

  test('two near-identical candidates are NOT confident', () => {
    // The colour is what separates these and the line does not name
    // one. Two candidates neck and neck is a coin toss, and a
    // preselected coin toss is how the wrong product reaches an order
    // without anybody looking at it.
    const { confident, candidates } = F.rank('20mm Knitted Elastic', elastics);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(confident).toBe(false);
  });

  test('a weak best match is not confident even when it is alone', () => {
    const { confident } = F.rank('some cord we do not make', elastics);
    expect(confident).toBe(false);
  });

  test('nothing plausible returns nothing rather than the least-bad option', () => {
    // Offering the closest of four wrong answers is worse than offering
    // none: it invites a confirm.
    const { best, candidates } = F.rank('hydraulic pump seal kit', elastics);
    expect(candidates).toEqual([]);
    expect(best).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. THE ORDINARY PART
// ══════════════════════════════════════════════════════════════════
describe('word and character matching', () => {
  test('extra words on the master do not penalise a match', () => {
    // The customer writes less than we do. "20mm knitted elastic"
    // should still find "20mm Knitted Elastic - White" when it is the
    // only 20mm product.
    const { best } = F.rank('20mm knitted elastic', [elastics[0], elastics[3]]);
    expect(best.id).toBe('e20');
  });

  test('case and punctuation are irrelevant', () => {
    expect(F.normalise('20mm KNITTED ELASTIC — White!')).toBe('20mm knitted elastic white');
  });

  test('a small typo still matches', () => {
    const { best } = F.rank('20mm knited elastic white', elastics);
    expect(best.id).toBe('e20');
  });

  test('customers match on name alone', () => {
    const customers = [
      { id: 'c1', label: 'Sri Lakshmi Garments' },
      { id: 'c2', label: 'Lakshmi Textiles' },
    ];
    const { best, confident } = F.rank('SRI LAKSHMI GARMENTS', customers);
    expect(best.id).toBe('c1');
    expect(confident).toBe(true);
  });

  test('two similarly named customers, neither exact, are not preselected', () => {
    // Both are plausible readings of what was written and nothing
    // separates them, so a person picks.
    const customers = [
      { id: 'c1', label: 'Lakshmi Textiles Pvt Ltd' },
      { id: 'c2', label: 'Lakshmi Textiles' },
    ];
    expect(F.rank('Lakshmi Textile Company', customers).confident).toBe(false);
  });

  // ── A decision, recorded rather than quietly flipped ─────────────
  //
  // This assertion previously read `rank('Lakshmi Textiles', …)` and
  // expected NO preselection, on the reasoning that "Lakshmi Textiles"
  // and "Lakshmi Textiles Pvt Ltd" might be the same company written
  // two ways. Adding the exact-match rule contradicted it, and the
  // honest question was which behaviour is right rather than which is
  // convenient.
  //
  // It is right to preselect. The PO names one master EXACTLY; the
  // other is a different string and, on paper, a different legal
  // entity. An exact name match is the strongest evidence available,
  // the name is the most prominent thing on the draft, and a person
  // still confirms. The genuinely ambiguous case — neither candidate
  // exact — is the test directly above, and it still refuses.
  test('an exact customer name is preselected over a longer variant', () => {
    const customers = [
      { id: 'c1', label: 'Lakshmi Textiles Pvt Ltd' },
      { id: 'c2', label: 'Lakshmi Textiles' },
    ];
    const { best, confident } = F.rank('Lakshmi Textiles', customers);
    expect(best.id).toBe('c2');
    expect(confident).toBe(true);
    // The variant is still offered, one click away.
    expect(F.rank('Lakshmi Textiles', customers).candidates.map((c) => c.id)).toContain('c1');
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. THE PIECES
// ══════════════════════════════════════════════════════════════════
describe('primitives', () => {
  test('numbersIn pulls numbers, whatever surrounds them', () => {
    expect(F.numbersIn('20mm x 100m @ 12.50')).toEqual([20, 100, 12.5]);
    expect(F.numbersIn('knitted elastic')).toEqual([]);
  });

  test('wordsIn drops bare numbers, keeping the words', () => {
    expect(F.wordsIn('20mm knitted 100 elastic')).toEqual(['20mm', 'knitted', 'elastic']);
  });

  test('levenshtein is the plain edit distance', () => {
    expect(F.levenshtein('kitten', 'sitting')).toBe(3);
    expect(F.levenshtein('same', 'same')).toBe(0);
    expect(F.levenshtein('', 'abc')).toBe(3);
  });

  test('an empty candidate list is empty, not an error', () => {
    expect(F.rank('anything', [])).toMatchObject({ best: null, candidates: [], confident: false });
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. THE EXACT-MATCH EXCEPTION
// ══════════════════════════════════════════════════════════════════
describe('an exact match is confident, but a tie is not', () => {
  test('a perfect match is preselected even with a close sibling', () => {
    // The margin rule alone refuses this: "20mm Knitted Elastic - White"
    // scores 1.0 and "…- Black" scores 0.87, a margin of 0.13. Refusing
    // to preselect a PERFECT match because a sibling colour exists is
    // caution that costs a click on every line of every order.
    const { confident, best } = F.rank('20mm Knitted Elastic - White', elastics);
    expect(best.score).toBe(1);
    expect(confident).toBe(true);
  });

  test('two masters with the same name are still a decision for a person', () => {
    // A genuine tie is the one case where an exact match proves nothing.
    const dupes = [
      { id: 'a', label: 'Lakshmi Textiles' },
      { id: 'b', label: 'Lakshmi Textiles' },
    ];
    expect(F.rank('Lakshmi Textiles', dupes).confident).toBe(false);
  });

  test('punctuation and case differences still count as exact', () => {
    // The customer types in caps and drops the dash. Same product.
    const { confident } = F.rank('20MM KNITTED ELASTIC WHITE', elastics);
    expect(confident).toBe(true);
  });
});

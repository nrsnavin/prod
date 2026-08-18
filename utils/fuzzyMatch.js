'use strict';
// ══════════════════════════════════════════════════════════════════
//  MATCHING WHAT A CUSTOMER WROTE TO WHAT WE MAKE
//
//  A customer's purchase order says "20mm KNITTED ELASTIC WHITE". The
//  elastic master says "20mm Knitted Elastic - White". Those are the
//  same product and a human sees it instantly.
//
//  It also says "25mm Knitted Elastic - White", which is one character
//  different and a COMPLETELY DIFFERENT PRODUCT — a different beam, a
//  different rate, a different cloth. Ship it and the customer sends
//  the lot back.
//
//  ── That asymmetry is the whole design ───────────────────────────
//  A generic string-similarity library scores "20mm" against "25mm" at
//  about 0.9 and would confidently pick the wrong one. So numbers are
//  not treated as characters here. They are extracted, compared
//  separately, and a CONFLICT IS FATAL: if the document says 20 and the
//  candidate says 25, the candidate is not offered at any score.
//
//  The rest — word overlap, then edit distance as a tiebreak — is
//  ordinary. The numeric rule is the part that stops this being
//  dangerous.
//
//  ── Nothing here decides anything ────────────────────────────────
//  This returns ranked candidates with scores. The caller shows them to
//  a person. A confident match is still a suggestion, because the cost
//  of a wrong product on an order is measured in returned goods, and
//  the cost of a click is a click.
// ══════════════════════════════════════════════════════════════════

/** Lowercase, strip punctuation, collapse whitespace. */
function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The numbers in a string, as numbers.
 *
 * "20mm x 100m" gives [20, 100]. Units are deliberately ignored: the
 * elastic master and a customer's PO rarely agree on whether it is
 * "20mm", "20 mm" or "20MM", and none of that changes the product.
 */
function numbersIn(s) {
  return (normalise(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/** Words, with pure numbers removed — those are compared separately. */
function wordsIn(s) {
  return normalise(s).split(' ').filter((w) => w && !/^\d+(\.\d+)?$/.test(w));
}

/** Levenshtein distance, iterative, two rows. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Edit distance as a 0–1 similarity. */
function editRatio(a, b) {
  const A = normalise(a), B = normalise(b);
  const longest = Math.max(A.length, B.length);
  return longest === 0 ? 1 : 1 - levenshtein(A, B) / longest;
}

/**
 * How well `query` matches `candidate`, and whether it may be offered
 * at all.
 *
 * Returns `{ score, blocked, reason }`. A blocked candidate is never
 * shown, whatever it scored — see the numeric rule in the header.
 */
function similarity(query, candidate) {
  const qNums = numbersIn(query);
  const cNums = numbersIn(candidate);

  // ── The rule that matters ──
  //
  // If both sides name numbers and they share none, this is a different
  // product wearing a similar name. 20mm and 25mm elastic differ by one
  // character and by everything else.
  if (qNums.length > 0 && cNums.length > 0) {
    const shared = qNums.filter((n) => cNums.includes(n));
    if (shared.length === 0) {
      return {
        score: 0,
        blocked: true,
        reason: `The document says ${qNums.join(', ')} and this says ${cNums.join(', ')}.`,
      };
    }
  }

  const qWords = wordsIn(query);
  const cWords = wordsIn(candidate);

  // Word overlap, asymmetric toward the query: a candidate that
  // contains every word the customer wrote is a good match even if it
  // carries extra words of its own ("- White", "Heavy").
  const cSet = new Set(cWords);
  const covered = qWords.filter((w) => cSet.has(w)).length;
  const wordScore = qWords.length > 0 ? covered / qWords.length : 0;

  // Numeric agreement, when both name numbers.
  const numScore = (qNums.length && cNums.length)
    ? qNums.filter((n) => cNums.includes(n)).length / Math.max(qNums.length, cNums.length)
    : null;

  const edit = editRatio(query, candidate);

  // Weighted, with numbers dominating where they exist. A width is the
  // single most discriminating thing on an elastic line.
  const score = numScore != null
    ? 0.45 * numScore + 0.35 * wordScore + 0.20 * edit
    : 0.65 * wordScore + 0.35 * edit;

  return { score: Math.round(score * 1000) / 1000, blocked: false, reason: null };
}

/**
 * Rank `candidates` against `query`.
 *
 * @param {string} query
 * @param {Array<{id: string, label: string}>} candidates
 * @param {{limit?: number, floor?: number}} opts
 * @returns {{ best: object|null, candidates: object[], confident: boolean, blocked: object[] }}
 */
function rank(query, candidates, { limit = 5, floor = 0.35 } = {}) {
  const scored = [];
  const blocked = [];

  for (const c of candidates) {
    const { score, blocked: isBlocked, reason } = similarity(query, c.label);
    if (isBlocked) { blocked.push({ ...c, reason }); continue; }
    if (score >= floor) scored.push({ ...c, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const best = top[0] || null;

  // ── When is a match confident enough to preselect? ──
  //
  // Normally two conditions, and the second is the one people forget:
  // the best match must be strong AND clearly better than the
  // runner-up. Two candidates at 0.82 is not a confident match, it is a
  // coin toss — and a preselected coin toss is how the wrong product
  // reaches an order without anybody looking.
  //
  // The exception is an EXACT match. If the customer wrote precisely
  // what the master says, there is nothing to be unsure about, and the
  // margin rule alone would refuse it: "20mm Knitted Elastic - White"
  // scores 1.0 while "…- Black" scores 0.87, a margin of 0.13, and a
  // perfect match would go unselected because a sibling colour exists.
  // Guarded on the runner-up being strictly lower, so a genuine tie —
  // two masters with the same name — is still a decision for a person.
  const runnerUp = top[1]?.score ?? 0;
  const exact = !!best && best.score >= 0.999 && runnerUp < best.score;
  const confident = !!best && (exact || (best.score >= 0.75 && (best.score - runnerUp) >= 0.15));

  return { best, candidates: top, confident, blocked };
}

module.exports = {
  rank, similarity, normalise, numbersIn, wordsIn, levenshtein, editRatio,
};

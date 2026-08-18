'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SMALL AMOUNT OF STATISTICS THIS SYSTEM NEEDS
//
//  Written out rather than pulled in. Three reasons, in order:
//
//    1. Every number these produce ends up in front of somebody who
//       will be asked to defend it — a supplier whose lot was rejected,
//       an operator whose shift was named, an engineer told to strip a
//       loom. A dependency they cannot read is a worse answer than
//       thirty lines they can.
//    2. It is thirty lines.
//    3. Two services now share this. Duplicating it was how the
//       multiple-comparison correction would eventually end up applied
//       in one report and forgotten in the other.
//
//  Nothing here is clever. The care is all in WHICH test is applied
//  and what is done about having asked many questions at once.
// ══════════════════════════════════════════════════════════════════

/**
 * Complementary error function, Abramowitz & Stegun 7.1.26.
 *
 * The workhorse: both the chi-square p-value at one degree of freedom
 * (p = erfc(sqrt(x/2))) and the normal tail are expressed through it.
 * Accurate to ~1e-7, several orders more than any decision made here.
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF: P(Z <= z). */
const normalCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

/**
 * 2×2 chi-square with Yates' continuity correction.
 *
 * Yates matters and is not ceremony: these tables routinely carry cells
 * in single figures, where the uncorrected statistic is optimistic and
 * would hand out significance the data does not support.
 */
function chiSquare2x2(a, b, c, d) {
  const n = a + b + c + d;
  if (n === 0) return { chi2: 0, p: 1 };

  const rowA = a + b, rowB = c + d;
  const colA = a + c, colB = b + d;
  if (rowA === 0 || rowB === 0 || colA === 0 || colB === 0) return { chi2: 0, p: 1 };

  const num = Math.abs(a * d - b * c) - n / 2;
  // The correction can push a tiny association below zero; that is a
  // statistic of zero, not a negative one.
  const chi2 = num <= 0 ? 0 : (n * num * num) / (rowA * rowB * colA * colB);
  return { chi2, p: erfc(Math.sqrt(chi2 / 2)) };
}

/**
 * Welch's two-sample comparison, one-tailed for a DROP.
 *
 * `recent` against `baseline`, returning how surprising it would be to
 * see a fall this large if nothing had changed. One-tailed on purpose:
 * the question asked of a loom is "has it got worse", and a two-tailed
 * test would spend half its power on the possibility that it got
 * better — which is not a maintenance decision.
 *
 * The normal approximation is used rather than a t-distribution. With
 * the twenty-plus shifts per window this is called with, the difference
 * is in the third decimal of a p-value that is only ever compared
 * against a threshold; the t would need an incomplete beta function to
 * buy that. Stated here so nobody has to wonder whether it was an
 * oversight.
 */
function welchDropTest(recent, baseline) {
  const { mean: mR, variance: vR, n: nR } = recent;
  const { mean: mB, variance: vB, n: nB } = baseline;
  if (nR < 2 || nB < 2) return { z: 0, p: 1, dropPct: null };

  const se = Math.sqrt(vR / nR + vB / nB);
  const dropPct = mB !== 0 ? ((mB - mR) / mB) * 100 : null;
  if (se === 0) {
    // No variance anywhere. Identical means are no evidence; a
    // difference with zero spread is as certain as this can express.
    return { z: 0, p: mR === mB ? 1 : 0, dropPct };
  }

  const z = (mR - mB) / se;
  return { z, p: normalCdf(z), dropPct };
}

/**
 * Benjamini–Hochberg: which of these p-values survive at the given FDR.
 *
 * The correction that stops a report being noise. Test forty machines
 * against a raw 5% threshold and two look sick by chance alone — then
 * get stripped, because the report came with a number.
 *
 * Chosen over Bonferroni deliberately. Bonferroni across sixty
 * candidates is so severe that a genuinely failing loom would have to
 * be nearly stopped before it was named, and a report that never names
 * anything gets switched off. BH controls the SHARE of findings that
 * are false rather than the chance of any false finding at all, which
 * is the right trade when the output is "go and look at this".
 */
function benjaminiHochberg(pValues, fdr = 0.10) {
  const indexed = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const m = indexed.length;
  let cutoff = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k].p <= ((k + 1) / m) * fdr) cutoff = k;
  }
  const pass = new Array(m).fill(false);
  for (let k = 0; k <= cutoff; k++) pass[indexed[k].i] = true;
  return pass;
}

/** Mean, variance (population) and n of a numeric array. */
function summarise(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { n, mean, variance };
}

/** The median, without sorting the caller's array underneath them. */
function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

module.exports = {
  erfc, normalCdf, chiSquare2x2, welchDropTest, benjaminiHochberg,
  summarise, median,
};

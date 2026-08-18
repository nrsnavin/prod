'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT YOUR OWN QUOTES ALREADY KNOW ABOUT YOUR PRICING
//
//  Quote.status has carried accepted / declined / expired since the
//  quotation module was built. That is a labelled outcome dataset —
//  every price you ever named, next to whether the customer took it —
//  and until now nothing read it. Pricing was done on instinct while
//  the evidence sat in the database.
//
//  ── What this is, and firmly is not ──────────────────────────────
//  It is a report on history. It says "of the quotes you priced near
//  this margin, this share were accepted". It does not set prices, it
//  is not consulted by any write path, and no route anywhere calls it
//  to decide a number. That restraint is the point: pricing is a
//  commercial judgement with a relationship behind it, and a model that
//  has seen forty quotes has no business overriding the person who has
//  seen the customer.
//
//  ── Two estimators, and it always says which one answered ────────
//  With forty quotes a fitted curve is theatre. So:
//
//    • the EMPIRICAL estimator buckets quotes by price-to-cost ratio
//      and reports the observed win rate per bucket. Blunt, honest,
//      works from the first dozen.
//    • the LOGISTIC estimator fits a smooth curve, and is only offered
//      once there is enough data on both sides of the outcome for the
//      fit to mean anything.
//
//  Every response names the estimator, the sample size behind it, and
//  the plant-wide baseline to compare against. A percentage with no n
//  beside it is how somebody talks themselves into a bad price.
//
//  ── The leakage that would have made this useless ────────────────
//  "Customer win rate" is the strongest feature available and also the
//  easiest way to build a model that scores beautifully and predicts
//  nothing. Computed naively, a customer's own outcome is inside the
//  feature used to predict that outcome. It is computed LEAVE-ONE-OUT
//  here — see customerPriorWinRate — which costs a few lines and is the
//  difference between a number and a mirror.
// ══════════════════════════════════════════════════════════════════

const Quote = require('../models/Quote');

// ── What counts as evidence ──────────────────────────────────────
//
// Only quotes the customer actually answered. A draft was never sent, a
// 'sent' quote is still in play, and a cancelled one was withdrawn by
// us — none of the three is the customer declining a price, and folding
// them in would move the win rate with how tidy the sales desk is
// rather than with whether the pricing works.
const WON  = new Set(['accepted']);
const LOST = new Set(['declined', 'expired']);

/** Below this, a fitted curve is decoration. */
const MIN_FOR_LOGISTIC = 25;
/** Below this on either side, there is nothing to fit at all. */
const MIN_PER_CLASS = 5;
/** A bucket with fewer than this is reported but flagged as thin. */
const MIN_PER_BUCKET = 3;

// ── Feature extraction ────────────────────────────────────────────

/**
 * The quantity-weighted price-to-cost ratio of a quote.
 *
 * 1.0 means quoted at cost; 1.35 means a 35% markup. Weighted by line
 * value rather than averaged flat, because a quote is won or lost on
 * the money, and a 2000 m line at a thin margin dominates a 50 m line
 * priced fat.
 *
 * Uses the FROZEN per-line costing, never a recomputation. A quote is a
 * commitment made on a particular day at particular yarn prices; re-
 * costing it today would restate history at this month's prices and
 * attribute the outcome to a number nobody ever quoted.
 */
function priceRatio(quote) {
  let value = 0;
  let cost  = 0;

  for (const l of quote.lines || []) {
    // Fall back to a single metre when no quantity was given, so a
    // quantity-less quote still contributes its ratio rather than
    // vanishing into a zero weight.
    const qty  = l.quantityMetres > 0 ? l.quantityMetres : 1;
    const rate = Number(l.rateBeforeTax) || 0;
    const unit = Number(l.totalCost) || 0;
    if (unit <= 0 || rate <= 0) continue;   // uncosted line: no signal
    value += rate * qty;
    cost  += unit * qty;
  }

  return cost > 0 ? value / cost : null;
}

/** Days the quote was left open. A tight validity is its own signal. */
function validityDays(quote) {
  if (!quote.date || !quote.validTill) return null;
  const d = (new Date(quote.validTill) - new Date(quote.date)) / 86_400_000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * How this customer has decided BEFORE this quote — never including it.
 *
 * The leave-one-out rule is not a refinement. A customer's win rate
 * computed over a set that contains this quote's own outcome is a
 * feature that already knows the answer: the model learns to read it
 * back, reports a flattering accuracy, and predicts nothing at all on a
 * quote that has not happened yet.
 */
function customerPriorWinRate(rows, i) {
  const key = rows[i].customerKey;
  if (!key) return null;

  let won = 0, total = 0;
  for (let j = 0; j < rows.length; j++) {
    if (j === i) continue;                      // the leave-one-out
    if (rows[j].customerKey !== key) continue;
    // Only what was decided BEFORE this quote was sent. Using a
    // customer's later decisions to predict an earlier one is the same
    // leak wearing a different hat.
    if (rows[j].date > rows[i].date) continue;
    total += 1;
    if (rows[j].won) won += 1;
  }
  return total > 0 ? { rate: won / total, n: total } : null;
}

/**
 * Pull every decided quote into a flat, numeric row.
 *
 * Returns rows sorted oldest first — the order matters, because the
 * customer-history feature is built from what came before.
 */
async function loadRows({ since, customerId, productName } = {}) {
  const filter = { status: { $in: [...WON, ...LOST] } };
  if (since) filter.date = { $gte: since };
  if (customerId) filter.customer = customerId;
  if (productName) {
    filter['lines.productName'] = new RegExp(
      String(productName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'
    );
  }

  const quotes = await Quote.find(filter)
    .select('quoteNo date validTill customer customerName status lines totalQuantityMetres grandTotal')
    .sort({ date: 1 })
    .lean();

  const rows = [];
  for (const q of quotes) {
    const ratio = priceRatio(q);
    // A quote with no costing behind it cannot say anything about
    // price. Dropped rather than defaulted — a made-up ratio of 1.0
    // would drag the whole curve toward cost.
    if (ratio == null) continue;

    rows.push({
      id:           String(q._id),
      quoteNo:      q.quoteNo,
      date:         new Date(q.date),
      customerKey:  q.customer ? String(q.customer) : (q.customerName || '').trim().toLowerCase() || null,
      customerName: q.customerName,
      status:       q.status,
      won:          WON.has(q.status),
      ratio,
      marginPct:    (ratio - 1) * 100,
      qty:          Number(q.totalQuantityMetres) || 0,
      value:        Number(q.grandTotal) || 0,
      validity:     validityDays(q),
      products:     (q.lines || []).map((l) => l.productName).filter(Boolean),
    });
  }
  return rows;
}

// ── The empirical estimator ──────────────────────────────────────

/** Bucket edges in margin percent. Coarse on purpose. */
const BANDS = [
  { label: 'at or below cost', min: -Infinity, max: 0 },
  { label: '0–10%',   min: 0,  max: 10 },
  { label: '10–20%',  min: 10, max: 20 },
  { label: '20–30%',  min: 20, max: 30 },
  { label: '30–45%',  min: 30, max: 45 },
  { label: 'above 45%', min: 45, max: Infinity },
];

/**
 * Observed win rate per margin band.
 *
 * The honest answer when there is not much data, and still the answer
 * worth reading when there is: it makes no assumption about the shape
 * of the curve, and a band with four quotes in it says four.
 */
function empiricalBands(rows) {
  return BANDS.map((b) => {
    const inBand = rows.filter((r) => r.marginPct >= b.min && r.marginPct < b.max);
    const wins = inBand.filter((r) => r.won).length;
    return {
      band: b.label,
      minMarginPct: b.min === -Infinity ? null : b.min,
      maxMarginPct: b.max === Infinity ? null : b.max,
      quotes: inBand.length,
      wins,
      winRatePct: inBand.length > 0 ? Math.round((wins / inBand.length) * 100) : null,
      thin: inBand.length > 0 && inBand.length < MIN_PER_BUCKET,
    };
  });
}

// ── The logistic estimator ───────────────────────────────────────

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Logistic regression by gradient descent, with L2.
 *
 * Written out rather than pulled in: it is thirty lines, it has no
 * dependency risk, and — more to the point — every step of it can be
 * read by whoever has to defend a price to a customer. A black box
 * would not survive that conversation.
 *
 * Ridge (L2) is not optional here. Quote data separates easily: if
 * every quote above 40% margin lost, an unregularised fit drives that
 * coefficient to infinity and reports a 0% win chance with total
 * confidence, on the strength of three quotes.
 */
function fitLogistic(X, y, { iterations = 4000, lr = 0.1, l2 = 1.0 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;

  for (let it = 0; it < iterations; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;

    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, k) => s + v * w[k], b);
      const err = sigmoid(z) - y[i];
      for (let k = 0; k < d; k++) gw[k] += err * X[i][k];
      gb += err;
    }

    for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] / n + (l2 * w[k]) / n);
    b -= lr * (gb / n);
  }
  return { w, b };
}

/** Column means and standard deviations, for standardising. */
function standardise(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const sd   = new Array(d).fill(0);

  for (const row of X) for (let k = 0; k < d; k++) mean[k] += row[k] / X.length;
  for (const row of X) for (let k = 0; k < d; k++) sd[k] += (row[k] - mean[k]) ** 2 / X.length;
  for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k]) || 1;

  return {
    mean, sd,
    apply: (row) => row.map((v, k) => (v - mean[k]) / sd[k]),
  };
}

/**
 * Build the design matrix.
 *
 * Four features, all of which somebody could have guessed matter, which
 * is the point — a feature nobody can explain is a feature nobody will
 * trust when the model disagrees with them.
 */
function buildFeatures(rows) {
  const X = [];
  const y = [];
  for (let i = 0; i < rows.length; i++) {
    const prior = customerPriorWinRate(rows, i);
    X.push([
      rows[i].marginPct,
      Math.log1p(rows[i].qty),
      // A customer with no history gets the neutral 0.5 rather than a
      // zero, which would read as "never buys anything".
      prior ? prior.rate : 0.5,
      prior ? Math.min(prior.n, 20) : 0,
    ]);
    y.push(rows[i].won ? 1 : 0);
  }
  return { X, y };
}

// ── The public shape ─────────────────────────────────────────────

/**
 * The win/loss picture, optionally narrowed to a customer or product.
 *
 * Always returns something: with no data at all it says so, rather than
 * throwing or — worse — returning zeros that read as "you never win".
 */
async function analyse({ since, customerId, productName, days } = {}) {
  const from = since || (days ? new Date(Date.now() - days * 86_400_000) : undefined);
  const rows = await loadRows({ since: from, customerId, productName });

  const wins   = rows.filter((r) => r.won).length;
  const losses = rows.length - wins;
  const declined = rows.filter((r) => r.status === 'declined').length;
  const expired  = rows.filter((r) => r.status === 'expired').length;

  const base = {
    quotes: rows.length,
    wins,
    losses,
    // Reported apart because they are not the same evidence. A decline
    // is the customer saying no to a price; an expiry may be a quote
    // nobody chased. Somebody reading a poor win rate deserves to know
    // which of the two it is made of.
    lossBreakdown: { declined, expired },
    baselineWinRatePct: rows.length > 0 ? Math.round((wins / rows.length) * 100) : null,
    windowFrom: from ? from.toISOString().slice(0, 10) : null,
    filters: { customerId: customerId || null, productName: productName || null },
  };

  if (rows.length === 0) {
    return { ...base, estimator: 'none', bands: [], curve: [], note: 'No decided quotes in this window.' };
  }

  const bands = empiricalBands(rows);

  // ── Can a curve be fitted at all? ──
  const enough = rows.length >= MIN_FOR_LOGISTIC
    && wins >= MIN_PER_CLASS
    && losses >= MIN_PER_CLASS;

  if (!enough) {
    return {
      ...base,
      estimator: 'empirical',
      bands,
      curve: [],
      note: rows.length < MIN_FOR_LOGISTIC
        ? `${rows.length} decided quotes — too few to fit a curve. The bands below are the observed history, not a prediction.`
        : `Only ${Math.min(wins, losses)} on one side of the outcome. The bands are observed history, not a prediction.`,
    };
  }

  const { X, y } = buildFeatures(rows);
  const scaler = standardise(X);
  const { w, b } = fitLogistic(X.map(scaler.apply), y);

  // ── The curve somebody actually reads ──
  //
  // Win probability across the margin range, holding the other features
  // at the median quote. Expected contribution is win probability times
  // the margin itself: the highest-probability price is at cost, and
  // that is not the price you want.
  const medianQty = [...rows].sort((a, b2) => a.qty - b2.qty)[Math.floor(rows.length / 2)].qty;
  const priors = rows.map((_, i) => customerPriorWinRate(rows, i)).filter(Boolean);
  const medPriorRate = priors.length
    ? priors.map((p) => p.rate).sort((a, b2) => a - b2)[Math.floor(priors.length / 2)]
    : 0.5;
  const medPriorN = priors.length
    ? priors.map((p) => Math.min(p.n, 20)).sort((a, b2) => a - b2)[Math.floor(priors.length / 2)]
    : 0;

  const curve = [];
  for (let m = 0; m <= 60; m += 5) {
    const z = scaler
      .apply([m, Math.log1p(medianQty), medPriorRate, medPriorN])
      .reduce((s, v, k) => s + v * w[k], b);
    const p = sigmoid(z);
    curve.push({
      marginPct: m,
      winProbabilityPct: Math.round(p * 100),
      // Relative — the units are "margin points won per quote sent",
      // which is comparable across the row and meaningless on its own.
      expectedMarginPoints: Math.round(p * m * 10) / 10,
    });
  }

  const best = curve.reduce((a, c) => (c.expectedMarginPoints > a.expectedMarginPoints ? c : a), curve[0]);

  return {
    ...base,
    estimator: 'logistic',
    bands,
    curve,
    bestExpectedMarginPct: best.marginPct,
    note: `Fitted on ${rows.length} decided quotes. Advisory only — it reports what happened, and knows nothing about the conversation behind any of it.`,
  };
}

/**
 * The same picture for one specific quote that is still in play, so it
 * can be read beside the price on screen.
 */
async function forQuote(quoteId) {
  const quote = await Quote.findById(quoteId)
    .select('quoteNo customer customerName lines totalQuantityMetres status date')
    .lean();
  if (!quote) return null;

  const ratio = priceRatio(quote);
  const marginPct = ratio != null ? (ratio - 1) * 100 : null;

  // Plant-wide first, then this customer — a customer with four quotes
  // cannot carry a curve, but their four are still worth showing.
  const overall  = await analyse({});
  const customer = quote.customer ? await analyse({ customerId: quote.customer }) : null;

  let atThisPrice = null;
  if (marginPct != null) {
    const source = overall.estimator === 'logistic' ? overall : null;
    if (source) {
      // Nearest point on the fitted curve rather than a re-fit: the
      // curve is what was reported above, and a second number that
      // disagrees with the chart by a percent would only cause doubt.
      atThisPrice = source.curve.reduce(
        (a, c) => (Math.abs(c.marginPct - marginPct) < Math.abs(a.marginPct - marginPct) ? c : a),
        source.curve[0]
      );
    }
  }

  return {
    quoteNo: quote.quoteNo,
    customerName: quote.customerName,
    marginPct: marginPct != null ? Math.round(marginPct * 10) / 10 : null,
    atThisPrice,
    overall,
    customer,
  };
}

module.exports = {
  analyse, forQuote,
  // Exposed for tests — the arithmetic is the product here, so it is
  // tested directly rather than only through a route.
  _internals: {
    priceRatio, validityDays, customerPriorWinRate, empiricalBands,
    fitLogistic, standardise, buildFeatures, loadRows,
    WON, LOST, MIN_FOR_LOGISTIC, MIN_PER_CLASS, BANDS,
  },
};

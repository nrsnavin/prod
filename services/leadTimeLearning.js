'use strict';
// ══════════════════════════════════════════════════════════════════
//  LEARNING HOW LONG A SUPPLIER ACTUALLY TAKES
//
//  Lead time is the input the whole reorder-point model rests on, and
//  it arrived as a field somebody has to type. A typed field is a
//  guess that ages: it is wrong the day a supplier's mill gets busy,
//  and nobody goes back to correct it.
//
//  The system already records the truth. A goods receipt names the
//  purchase order it came against, so
//
//      inwardDate − purchaseOrder.date
//
//  is an OBSERVED lead time, in days, for that supplier and that
//  material. Every delivery adds one. This reads them and keeps a
//  running estimate that gets better as receipts accumulate — no
//  training run, no model file, nothing to retrain: the estimate IS
//  the data, recomputed on read.
//
//  ── Why median and MAD, not mean and standard deviation ──────────
//  A single PO received 400 days late — cancelled and then quietly
//  receipted, or a date typed wrong — moves a mean enormously and a
//  standard deviation more than that. The mill would see its safety
//  stock triple because of one bad row, and would rightly stop
//  trusting the number.
//
//  The median does not move. MAD (median absolute deviation), scaled
//  by 1.4826, estimates the same spread a standard deviation would on
//  clean normal data, and ignores the outlier entirely. It is also
//  explainable in a sentence: "half your deliveries land within four
//  days of thirteen".
//
//  ── Why lead-time VARIABILITY matters as much as the average ─────
//  With a variable lead time the correct safety stock is
//
//      SS = z × √( L̄·σ_d² + d̄²·σ_L² )
//
//  The second term is usually the bigger one for a mill. A supplier
//  averaging 14 days ±1 and one averaging 14 days ±10 need completely
//  different cover, and a model that knows only the average treats
//  them identically. This is what makes learning worth doing: not a
//  better average, a spread that was never available before.
//
//  ── What it will not do ──────────────────────────────────────────
//  It never silently overrides a figure a person set. A typed lead
//  time wins, because somebody may know something the history cannot
//  — a supplier who has just changed hands, a new shipping route. The
//  learned figure is offered, labelled, alongside.
// ══════════════════════════════════════════════════════════════════

const DAY_MS = 86_400_000;

// Below this, the sample says more about luck than about the supplier.
// Three is the fewest from which a median and a spread mean anything
// at all; the confidence label below is what stops it being trusted
// like thirty.
const MIN_OBSERVATIONS = 3;

// Deliveries older than this stop describing how the supplier works
// now. A year keeps a seasonal pattern visible without letting a
// supplier's behaviour from two mills ago set today's safety stock.
const DEFAULT_WINDOW_DAYS = 365;

// A receipt this long after its PO is a data-entry artefact — a
// cancelled order receipted later, a backdated PO — not a lead time.
// Dropped rather than winsorised: it is not a slow delivery, it is a
// different kind of event.
const MAX_PLAUSIBLE_DAYS = 400;

const median = (sorted) => {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Median absolute deviation, scaled to be comparable with a standard
 * deviation on normal data.
 */
function madSd(values, med) {
  if (values.length < 2) return 0;
  const deviations = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * (median(deviations) ?? 0);
}

/**
 * How much to trust the estimate. Words, not a number between 0 and 1 —
 * a buyer needs to know whether to act on it, not to interpret 0.62.
 */
function confidenceFor(n) {
  if (n >= 12) return 'high';
  if (n >= 6)  return 'medium';
  if (n >= MIN_OBSERVATIONS) return 'low';
  return 'none';
}

/**
 * Turn receipts into observed lead times.
 *
 * The FIRST receipt against a purchase order is the delivery event.
 * A PO received in three instalments has one lead time — when the
 * goods started arriving — not three, and counting the later ones
 * would teach the model that this supplier is slow when it is really
 * just splitting a consignment.
 *
 * @param {Array} receipts  [{ purchaseOrder, rawMaterial, inwardDate }]
 * @param {Map}   poById    id → { date, supplier }
 * @returns {Array<{supplierId, materialId, days, at}>}
 */
function observationsFrom(receipts, poById, { now = new Date(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const firstByPoMaterial = new Map();   // `${po}:${material}` → receipt
  const cutoff = now.getTime() - windowDays * DAY_MS;

  for (const r of receipts) {
    if (!r.purchaseOrder || !r.rawMaterial) continue;
    const po = poById.get(String(r.purchaseOrder));
    if (!po || !po.date) continue;

    const at = new Date(r.inwardDate || r.createdAt);
    if (isNaN(at.getTime()) || at.getTime() < cutoff) continue;

    const key = `${String(r.purchaseOrder)}:${String(r.rawMaterial)}`;
    const seen = firstByPoMaterial.get(key);
    if (!seen || at < seen.at) {
      firstByPoMaterial.set(key, { at, po, materialId: String(r.rawMaterial) });
    }
  }

  const out = [];
  for (const { at, po, materialId } of firstByPoMaterial.values()) {
    const days = (at.getTime() - new Date(po.date).getTime()) / DAY_MS;
    // Negative means the receipt predates its own PO — backdated entry.
    // Not a same-day delivery, and not information.
    if (days < 0 || days > MAX_PLAUSIBLE_DAYS) continue;
    out.push({
      supplierId: po.supplier ? String(po.supplier) : null,
      materialId,
      days: Math.round(days * 10) / 10,
      at,
    });
  }
  return out;
}

/** Median, spread and confidence for one bag of observations. */
function summarise(daysList) {
  const values = daysList.slice().sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return { n: 0, median: null, sd: 0, confidence: 'none', min: null, max: null };
  const med = median(values);
  return {
    n,
    median: Math.round(med * 10) / 10,
    sd: Math.round(madSd(values, med) * 10) / 10,
    confidence: confidenceFor(n),
    min: values[0],
    max: values[n - 1],
  };
}

/**
 * Build the lookup the forecast asks per material.
 *
 * Two levels, because they answer different questions. A material's own
 * history is the better answer when it exists — a dyed yarn is slower
 * than a greige one from the same mill. The supplier's pooled history
 * is the fallback, and for a material bought twice it is the ONLY
 * usable answer.
 */
function buildIndex(observations) {
  const bySupplier = new Map();
  const byMaterial = new Map();

  for (const o of observations) {
    if (o.supplierId) {
      if (!bySupplier.has(o.supplierId)) bySupplier.set(o.supplierId, []);
      bySupplier.get(o.supplierId).push(o.days);
    }
    const key = `${o.supplierId || '-'}:${o.materialId}`;
    if (!byMaterial.has(key)) byMaterial.set(key, []);
    byMaterial.get(key).push(o.days);
  }

  const supplier = new Map();
  for (const [k, v] of bySupplier) supplier.set(k, summarise(v));
  const material = new Map();
  for (const [k, v] of byMaterial) material.set(k, summarise(v));

  return { supplier, material };
}

/**
 * The lead time to actually use, and where it came from.
 *
 * Precedence, and the reasoning for it:
 *
 *   1. a figure typed on the MATERIAL      — the most specific thing a
 *                                            person has said
 *   2. a figure typed on the SUPPLIER      — ditto, less specific
 *   3. the material's own observed history — data beats no data
 *   4. the supplier's observed history     — pooled, still data
 *   5. nothing                             — 0, which is the old
 *                                            behaviour and is flagged
 *
 * Typed values win because somebody may know something the history
 * cannot: a supplier who has just changed hands, a route that closed.
 * The learned figure is always reported alongside, so a manual entry
 * that history contradicts is visible rather than silently obeyed.
 */
function resolveLeadTime({ materialLeadTime, supplierLeadTime, observed }) {
  const learned = observed?.material?.confidence !== 'none' && observed?.material
    ? observed.material
    : (observed?.supplier?.confidence !== 'none' ? observed.supplier : null);

  const asNum = (v) => (v == null || v === '' ? null : Number(v));
  const mat = asNum(materialLeadTime);
  const sup = asNum(supplierLeadTime);

  if (mat != null && Number.isFinite(mat)) {
    return {
      days: mat, sd: learned?.sd ?? 0, source: 'material',
      learned, disagrees: learned ? Math.abs(learned.median - mat) >= 5 : false,
    };
  }
  if (sup != null && Number.isFinite(sup) && sup > 0) {
    return {
      days: sup, sd: learned?.sd ?? 0, source: 'supplier',
      learned, disagrees: learned ? Math.abs(learned.median - sup) >= 5 : false,
    };
  }
  if (learned) {
    const from = observed?.material?.confidence !== 'none' && observed?.material
      ? 'observed-material'
      : 'observed-supplier';
    return { days: learned.median, sd: learned.sd, source: from, learned, disagrees: false };
  }
  return { days: 0, sd: 0, source: 'none', learned: null, disagrees: false };
}

module.exports = {
  observationsFrom,
  buildIndex,
  summarise,
  resolveLeadTime,
  confidenceFor,
  madSd,
  MIN_OBSERVATIONS,
  DEFAULT_WINDOW_DAYS,
  MAX_PLAUSIBLE_DAYS,
};

'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHEN TO BUY YARN, AND HOW MUCH
//
//  The old forecast projected stock over a horizon and ordered enough
//  to cover it. That is not a replenishment rule, because it never asks
//  the only question that decides urgency: HOW LONG DOES THE YARN TAKE
//  TO ARRIVE. Ordering on the day stock runs out is ordering three
//  weeks late.
//
//  This is the standard reorder-point model, which is what a mill
//  actually needs:
//
//      demand during the wait    D_L  = d̄ × L
//      safety stock              SS   = z × σ_d × √L
//      reorder point             ROP  = D_L + SS
//      net stock                 NET  = onHand + onOrder − committed
//      order when                NET  < ROP
//      order quantity            Q    = ROP + coverDays × d̄ − NET
//
//  Every term is a number somebody can point at and argue with, which
//  is the property that matters: a buyer who cannot see why the system
//  asked for 800 kg will order what they were going to order anyway.
//
//  ── Why safety stock is √L and not L ─────────────────────────────
//  Demand over L days is the sum of L daily draws. Variances add, so
//  the standard deviation of that sum grows with √L, not L. Using L
//  would demand roughly √L times too much safety stock — on a 16-day
//  lead time, four times too much yarn sitting on the floor.
//
//  ── What this deliberately is NOT ────────────────────────────────
//  There is no learned model here. The inputs a mill has — a few
//  hundred draws a year, per material — do not support one, and a
//  black box that says "buy 800" is worse than an arithmetic rule that
//  says why. The language model's job is to explain the ranking in
//  words, not to choose the number. See the note in api/rawMaterial.js.
// ══════════════════════════════════════════════════════════════════

// Service level → z. A mill does not want a slider with 40 positions;
// it wants "how often am I willing to run out?".
const SERVICE_LEVELS = Object.freeze({
  90: 1.2816,
  95: 1.6449,
  98: 2.0537,
  99: 2.3263,
});
const DEFAULT_SERVICE_LEVEL = 95;

const zFor = (pct) => SERVICE_LEVELS[pct] ?? SERVICE_LEVELS[DEFAULT_SERVICE_LEVEL];

const DAY_MS = 86_400_000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Daily demand series from dated draws, over a window.
 *
 * Bucketed per DAY rather than averaged over the window, because the
 * spread between days is the whole input to safety stock. A material
 * drawn 300 kg once a month and one drawn 10 kg every day have the same
 * mean and completely different risk.
 *
 * @param {Array<{at: Date, quantity: number}>} draws
 * @param {number} windowDays
 * @param {Date}   now
 * @returns {{ mean: number, sd: number, days: number, active: number }}
 */
function dailyDemand(draws, windowDays, now = new Date()) {
  const days = Math.max(1, Math.floor(windowDays));
  const buckets = new Array(days).fill(0);

  for (const d of draws) {
    const age = Math.floor((now.getTime() - new Date(d.at).getTime()) / DAY_MS);
    if (age < 0 || age >= days) continue;
    buckets[age] += Math.max(0, num(d.quantity));
  }

  const total = buckets.reduce((s, v) => s + v, 0);
  const mean  = total / days;
  // Population sd over the window — every day in the window is observed,
  // including the zero ones, which is exactly the point.
  const variance = buckets.reduce((s, v) => s + (v - mean) ** 2, 0) / days;

  return {
    mean,
    sd: Math.sqrt(variance),
    days,
    active: buckets.filter((v) => v > 0).length,
  };
}

/**
 * How lumpy the demand is — which decides whether the normal-based
 * safety stock above is even the right tool.
 *
 *   smooth       draws on most days; the model fits
 *   intermittent long gaps between draws; the model over-orders,
 *                because σ is dominated by the zero days
 *   new          not enough history to say anything
 *
 * Reported rather than acted on. A buyer told "this yarn moves 4 days
 * in 30, treat the figure as a floor" can use their judgement; a system
 * that silently switches formula cannot be argued with.
 */
function demandPattern({ active, days }, drawCount) {
  if (drawCount < 3) return 'new';
  const activeRatio = active / days;
  if (activeRatio < 0.2) return 'intermittent';
  return 'smooth';
}

/**
 * Everything about one material's replenishment position.
 *
 * @param {object} input
 * @param {number} input.onHand
 * @param {number} input.onOrder      raised, not yet received
 * @param {number} input.committed    named by orders not yet drawn
 * @param {number} input.minStock     the manual floor, still honoured
 * @param {number} input.leadTimeDays
 * @param {number} input.coverDays    how long an order should last
 * @param {number} input.serviceLevel
 * @param {{mean:number, sd:number}} input.demand
 */
function position({
  onHand = 0,
  onOrder = 0,
  committed = 0,
  minStock = 0,
  leadTimeDays = 0,
  coverDays = 30,
  serviceLevel = DEFAULT_SERVICE_LEVEL,
  demand,
  now = new Date(),
} = {}) {
  const d   = Math.max(0, num(demand?.mean));
  const sd  = Math.max(0, num(demand?.sd));
  const L   = Math.max(0, num(leadTimeDays));
  const z   = zFor(serviceLevel);

  const demandDuringLead = d * L;
  const safetyStock      = z * sd * Math.sqrt(L);

  // The manual floor is a FLOOR, not an alternative. Somebody set it
  // for a reason the statistics cannot see — a dye lot that must not be
  // split, a supplier who disappears in monsoon season.
  const reorderPoint = Math.max(demandDuringLead + safetyStock, num(minStock));

  // On-order counts: it is stock that is coming. Committed does not
  // count: it is stock that is leaving. Netting both is what stops the
  // same shortfall being ordered twice.
  const netStock = num(onHand) + Math.max(0, num(onOrder)) - Math.max(0, num(committed));

  const shouldOrder = netStock < reorderPoint;

  // Cover the wait, the safety stock, and then `coverDays` of running —
  // so the buyer is not back here next week for the same yarn.
  const targetLevel   = reorderPoint + d * Math.max(0, coverDays);
  const suggestedQty  = shouldOrder ? Math.ceil(Math.max(0, targetLevel - netStock)) : 0;

  // Days of cover left, and the LAST day an order still lands in time.
  // This is the number the whole thing exists to produce.
  const daysOfCover = d > 0 ? netStock / d : null;
  const stockoutAt  = daysOfCover != null && daysOfCover <= 3650
    ? new Date(now.getTime() + daysOfCover * DAY_MS)
    : null;
  const orderByAt   = stockoutAt ? new Date(stockoutAt.getTime() - L * DAY_MS) : null;

  // Late means an order placed TODAY arrives after stock runs out. That
  // is a different and more urgent thing than "below the reorder point",
  // and it is the one that stops a loom.
  const alreadyLate = orderByAt ? orderByAt.getTime() < now.getTime() : false;

  let severity = 'ok';
  if (shouldOrder) severity = 'warn';
  if (shouldOrder && (alreadyLate || netStock < 0)) severity = 'critical';

  return {
    onHand: r2(num(onHand)),
    onOrder: r2(Math.max(0, num(onOrder))),
    committed: r2(Math.max(0, num(committed))),
    netStock: r2(netStock),

    dailyDemand: r2(d),
    demandSd: r2(sd),
    leadTimeDays: L,
    demandDuringLead: r2(demandDuringLead),
    safetyStock: r2(safetyStock),
    minStock: r2(num(minStock)),
    reorderPoint: r2(reorderPoint),
    serviceLevel,

    shouldOrder,
    suggestedQty,
    daysOfCover: daysOfCover != null ? r2(daysOfCover) : null,
    projectedStockoutDate: stockoutAt ? stockoutAt.toISOString().slice(0, 10) : null,
    // Null when there is no demand at all — "order by" is meaningless
    // for a material nothing consumes, and a date there would be noise.
    orderByDate: orderByAt ? orderByAt.toISOString().slice(0, 10) : null,
    alreadyLate,
    severity,
  };
}

/**
 * Round an order up to what the supplier will actually sell.
 *
 * A pack size of 25 kg and a suggestion of 812 kg means 825. Ordering
 * 812 gets you 825 and an invoice nobody expected, or a phone call.
 */
function applyPurchaseRules(qty, { minOrderQty = 0, packSize = 0 } = {}) {
  let q = Math.max(0, Math.ceil(num(qty)));
  if (q === 0) return 0;
  const moq = Math.max(0, num(minOrderQty));
  if (moq > 0) q = Math.max(q, moq);
  const pack = Math.max(0, num(packSize));
  if (pack > 0) q = Math.ceil(q / pack) * pack;
  return q;
}

module.exports = {
  dailyDemand,
  demandPattern,
  position,
  applyPurchaseRules,
  zFor,
  SERVICE_LEVELS,
  DEFAULT_SERVICE_LEVEL,
};

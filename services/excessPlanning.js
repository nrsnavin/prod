'use strict';
// ══════════════════════════════════════════════════════════════════
//  EXCESS PLANNING
//  File: services/excessPlanning.js
//
//  A job used to be refused outright the moment it planned more than
//  the order had left: `pending < requested → 400`. Real weaving does
//  not work that way — you set the loom for a round number of meters,
//  you allow for the checking rejection, and you plan a little over.
//
//  So a line may now be planned up to 120% of what was ORDERED. Past
//  that it still goes through, but only with a reason, which is kept
//  on the order and shown on its detail page.
//
//  THE PART THAT COSTS MONEY. The order's approval drew raw material
//  for the ORDERED quantity and no more. Every excess meter therefore
//  needs yarn that nobody has deducted, so the excess carries its own
//  material requirement, checked against stock and drawn at the point
//  the job is raised. Planning excess without that draw is how stock
//  on the screen stops matching stock on the rack.
//
//  Measured PER ELASTIC LINE, not across the order: material and
//  production are both per elastic, so the check belongs where the
//  consequence lands — and one line cannot quietly spend another's
//  headroom.
// ══════════════════════════════════════════════════════════════════

const { computeMaterialRequirement } = require('../utils/materialRequirement');

/** A line may reach this much of its ordered quantity with no comment. */
const FREE_EXCESS_PCT = 20;

/** A reason has to say something. Matches the force-approval minimum. */
const MIN_REASON_LENGTH = 8;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * What each requested line means against the order.
 *
 * @param {Array<{elastic, quantity}>} requested   the job's lines
 * @param {object} order                           with elasticOrdered + jobs
 * @param {Map<string, number>} plannedByElastic   already planned elsewhere
 * @returns {Array} one row per requested line
 */
function assessLines(requested, order, plannedByElastic) {
  const orderedBy = new Map(
    (order.elasticOrdered || []).map((l) => [String(l.elastic?._id ?? l.elastic), num(l.quantity)])
  );

  return requested.map((line) => {
    const id = String(line.elastic);
    const ordered = orderedBy.get(id) ?? 0;
    const alreadyPlanned = plannedByElastic.get(id) ?? 0;
    const requestedQty = num(line.quantity);
    const totalPlanned = alreadyPlanned + requestedQty;

    // Excess is measured against the ORDER, not against what is left:
    // two jobs each inside the allowance must not add up to 40% over.
    const excess = Math.max(0, totalPlanned - ordered);
    const excessPct = ordered > 0 ? r2((excess / ordered) * 100) : (excess > 0 ? Infinity : 0);

    return {
      elastic: id,
      ordered,
      alreadyPlanned,
      requested: requestedQty,
      totalPlanned,
      excess: r2(excess),
      excessPct,
      needsReason: excessPct > FREE_EXCESS_PCT,
      onOrder: orderedBy.has(id),
    };
  });
}

/**
 * Sum what the order's existing jobs have already planned per elastic.
 * Read from the jobs themselves rather than from `pendingElastic`, which
 * is a derived mirror — the excess rule must not compound a drift in it.
 */
function plannedFromJobs(jobs) {
  const planned = new Map();
  for (const j of jobs || []) {
    for (const l of j.elastics || []) {
      const id = String(l.elastic);
      planned.set(id, (planned.get(id) ?? 0) + num(l.quantity));
    }
  }
  return planned;
}

/**
 * Material needed for the excess meters only.
 *
 * The ordered meters were costed and drawn at approval; asking for the
 * requirement of the whole planned quantity here would draw that yarn
 * a second time.
 */
async function excessMaterialRequirement(rows) {
  const lines = rows
    .filter((r) => r.excess > 0)
    .map((r) => ({ elastic: r.elastic, quantity: r.excess }));
  if (lines.length === 0) return [];
  return computeMaterialRequirement(lines);
}

/**
 * Which of those materials the stock cannot cover.
 * @returns {Array<{rawMaterial, name, required, inStock, short}>}
 */
function stockShortfalls(requirement, stockById) {
  const short = [];
  for (const r of requirement) {
    const id = String(r.rawMaterial);
    const inStock = num(stockById.get(id));
    const required = num(r.requiredWeight);
    if (required > inStock) {
      short.push({
        rawMaterial: id,
        name: r.name || 'Unnamed material',
        required: r2(required),
        inStock: r2(inStock),
        short: r2(required - inStock),
      });
    }
  }
  return short;
}

/** Lines whose excess is past the free allowance, for an error message. */
const linesNeedingReason = (rows) => rows.filter((r) => r.needsReason);

/** Is this reason good enough to record against the order? */
function reasonIsUsable(reason) {
  return typeof reason === 'string' && reason.trim().length >= MIN_REASON_LENGTH;
}

/** A one-line human summary of an over-allowance line, for the 409 body. */
const describeLine = (r, nameOf = (id) => id) =>
  `${nameOf(r.elastic)}: planning ${r.totalPlanned} m against ${r.ordered} m ordered `
  + `— ${r.excess} m over (${r.excessPct === Infinity ? '∞' : r.excessPct}%)`;

module.exports = {
  FREE_EXCESS_PCT,
  MIN_REASON_LENGTH,
  assessLines,
  plannedFromJobs,
  excessMaterialRequirement,
  stockShortfalls,
  linesNeedingReason,
  reasonIsUsable,
  describeLine,
};

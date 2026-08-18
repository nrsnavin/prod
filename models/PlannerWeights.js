'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE PLANNER HAS LEARNED ABOUT WHAT YOU ACTUALLY WANT
//
//  The optimiser minimises
//
//      score = totalLate·W_LATE + changeovers·W_CHANGE + imbalance·W_BAL
//
//  and those three numbers were constants somebody picked once. They
//  encode a claim about this plant's priorities — that one late working
//  day costs ten changeovers — and nothing ever checked that claim
//  against anybody's behaviour.
//
//  Every time an admin moves a line before accepting a plan, they are
//  stating a preference the objective got wrong. This collection is
//  where that gets kept and turned back into weights.
//
//  ── One row, on purpose ──────────────────────────────────────────
//  A singleton. Weights are a property of the plant, not of a user or a
//  horizon — a per-admin objective would mean the plan changed shape
//  depending on who opened the page, and the plan of record is supposed
//  to be one thing.
//
//  ── Why the history is kept ──────────────────────────────────────
//  A learner that cannot be audited is a learner nobody will leave
//  switched on. Every update records what it saw and what it did, so
//  "why does it stop batching colours?" has an answer, and a bad run can
//  be pointed at rather than argued about. Bounded, because this is a
//  diagnostic and not an archive.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/**
 * The starting point, and what a reset returns to.
 *
 * W_LATE is the ANCHOR and is never learned. The objective's scale is
 * unidentifiable — doubling all three weights picks exactly the same
 * plan — so one of them has to be held still or the whole vector drifts
 * without changing a single decision. Lateness is the natural choice
 * because it is the term everybody already reasons in: "how many days
 * late" is a unit a person has intuitions about, and the other two are
 * then readable as exchange rates against it.
 */
const DEFAULT_WEIGHTS = Object.freeze({
  late: 10,
  changeover: 1,
  balance: 0.1,
});

/**
 * Bounds. One strange acceptance must not be able to wreck the planner.
 *
 * These are wide enough that a genuine preference can express itself —
 * changeover cost can move 10× in either direction — and tight enough
 * that no sequence of updates can drive a term to zero (silently
 * dropping it from the objective) or to a value that swamps lateness.
 */
const BOUNDS = Object.freeze({
  changeover: { min: 0.1, max: 10 },
  balance:    { min: 0.01, max: 5 },
});

const UpdateSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    /** Who accepted the plan this was learned from. */
    actor: { type: String, default: '' },
    /** Lines in the plan — the update is normalised by this. */
    lines: { type: Number, default: 0 },
    /** The objective terms of what the planner proposed. */
    proposed: {
      late:       { type: Number, default: 0 },
      changeover: { type: Number, default: 0 },
      balance:    { type: Number, default: 0 },
    },
    /** The objective terms of what the human actually accepted. */
    accepted: {
      late:       { type: Number, default: 0 },
      changeover: { type: Number, default: 0 },
      balance:    { type: Number, default: 0 },
    },
    /** Weights after this update. */
    weights: {
      late:       { type: Number },
      changeover: { type: Number },
      balance:    { type: Number },
    },
    /** Plain-language account of what moved and why. */
    note: { type: String, default: '' },
  },
  { _id: false }
);

const PlannerWeightsSchema = new mongoose.Schema(
  {
    /** Singleton key. Exactly one document, always. */
    key: { type: String, default: 'default', unique: true, immutable: true },

    late:       { type: Number, default: DEFAULT_WEIGHTS.late },
    changeover: { type: Number, default: DEFAULT_WEIGHTS.changeover },
    balance:    { type: Number, default: DEFAULT_WEIGHTS.balance },

    /**
     * How many corrections these rest on.
     *
     * Not decoration. Below the warm-up threshold the learned weights
     * are NOT used — see services/plannerLearning.js. Two corrections
     * is a coincidence and would reshape every plan in the plant.
     */
    observations: { type: Number, default: 0 },

    /** Most recent first, bounded. */
    history: { type: [UpdateSchema], default: [] },

    lastResetAt: { type: Date },
    lastResetBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.PlannerWeights ||
  mongoose.model('PlannerWeights', PlannerWeightsSchema);
module.exports.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
module.exports.BOUNDS = BOUNDS;

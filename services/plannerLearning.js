'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PLANNER LEARNING WHAT THIS PLANT ACTUALLY WANTS
//
//  The optimiser minimises a weighted sum of three things it can count:
//  late working days, changeovers, and load imbalance. The weights were
//  constants. They asserted that one late day is worth ten changeovers,
//  and nothing had ever checked that against what anybody here does.
//
//  When an admin moves a line before accepting, they have chosen a plan
//  the objective scores WORSE than the one it offered. That is not
//  noise. It is a labelled statement that the weights are wrong, and it
//  says in which direction.
//
//  ── The rule, in one line ────────────────────────────────────────
//
//      w ← w − η · (φ(accepted) − φ(proposed)) / lines
//
//  This is the structured perceptron update, and the sign is the whole
//  thing. If the accepted plan has MORE changeovers than the proposed
//  one and the human took it anyway, they care less about changeovers
//  than the objective claimed — so W_CHANGE goes DOWN. If they moved
//  lines to cut changeovers and swallowed a late day for it, W_CHANGE
//  goes UP. Nothing more clever than that, and every step is arithmetic
//  a person can redo on paper.
//
//  ── Four things that make it safe rather than merely clever ──────
//
//  1. THE ANCHOR. The objective's scale is unidentifiable: doubling all
//     three weights selects exactly the same plan. Left free, the vector
//     wanders forever without changing a single decision, and the
//     numbers on the screen become meaningless. W_LATE is pinned at 10
//     and everything is renormalised against it after every update, so
//     the other two read as exchange rates: "a changeover costs 0.4 late
//     days" is a sentence somebody can agree or disagree with.
//
//  2. NORMALISED BY PLAN SIZE. A 200-line plan differs from its
//     alternative by bigger absolute counts than a 20-line plan does.
//     Without dividing by lines, one busy week would move the weights
//     ten times as far as a quiet one for no better reason.
//
//  3. CLAMPED. Bounds in models/PlannerWeights.js. A single strange
//     acceptance — somebody dragging every line onto one loom to see
//     what happens — must not be able to drive a term to zero and
//     silently delete it from the objective.
//
//  4. A WARM-UP. Below MIN_OBSERVATIONS the learned weights are not used
//     at all; the planner runs on the defaults. Two corrections are a
//     coincidence, and acting on a coincidence would reshape every plan
//     in the plant. Same discipline as the complaint themes and the
//     staffing forecast: thin data produces no output rather than a
//     confident one.
//
//  ── What this deliberately does NOT learn ───────────────────────
//  Rates. How fast a machine runs an elastic is already learned, per
//  pair, by the Gamma–Poisson posterior in EtaRatePosterior, from
//  closed shifts — actual production, not opinion. That is a better
//  signal than anybody's schedule edit and it is already wired in. This
//  learns only the PREFERENCE between competing plans, which is the one
//  thing no amount of production data can reveal.
// ══════════════════════════════════════════════════════════════════

const PlannerWeights = require('../models/PlannerWeights');
const { DEFAULT_WEIGHTS, BOUNDS } = require('../models/PlannerWeights');

/**
 * Step size.
 *
 * Small on purpose. This runs once per accepted plan — a handful of
 * times a week, not thousands of times a second — so there is no need
 * to move fast and every reason not to: a week of unusual orders should
 * nudge the objective, not redefine it. At 0.5, roughly ten consistent
 * corrections are needed to halve or double a weight.
 */
const LEARNING_RATE = 0.5;

/** Corrections needed before the learned weights are used at all. */
const MIN_OBSERVATIONS = 5;

/** How many updates to keep for inspection. */
const HISTORY_LIMIT = 50;

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

/** The singleton, created on first use. */
async function _doc() {
  const existing = await PlannerWeights.findOne({ key: 'default' });
  if (existing) return existing;
  try {
    return await PlannerWeights.create({ key: 'default' });
  } catch {
    // Lost a create race with another request; the winner's document is
    // the one we want either way.
    return PlannerWeights.findOne({ key: 'default' });
  }
}

/**
 * The weights the optimiser should run with right now.
 *
 * Returns the defaults, and says so, until enough corrections have been
 * seen. `learned` is the honest flag for the screen: a planner claiming
 * to have learned something from two accepts would be lying.
 */
async function currentWeights() {
  let doc = null;
  try {
    doc = await _doc();
  } catch (err) {
    // Never let a weights read take the planner down. A plan on the
    // default objective is a working plan; a 500 is not.
    console.warn('[plannerLearning] weights read failed:', err?.message);
  }

  if (!doc || doc.observations < MIN_OBSERVATIONS) {
    return {
      ...DEFAULT_WEIGHTS,
      learned: false,
      observations: doc?.observations || 0,
      needed: MIN_OBSERVATIONS,
    };
  }

  return {
    late: doc.late,
    changeover: doc.changeover,
    balance: doc.balance,
    learned: true,
    observations: doc.observations,
    needed: MIN_OBSERVATIONS,
  };
}

/**
 * The three numbers the objective is built from, for one plan.
 *
 * Kept in one place so the proposed and accepted plans are always
 * measured the same way — computing them twice in two files is how one
 * of them would eventually acquire a rounding the other did not.
 */
function features({ totalLate = 0, changeovers = 0, imbalance = 0 } = {}) {
  return {
    late: Number(totalLate) || 0,
    changeover: Number(changeovers) || 0,
    balance: Number(imbalance) || 0,
  };
}

/**
 * Readable account of what an update did.
 *
 * Written here rather than in the UI because the reasoning belongs with
 * the arithmetic, and because somebody reading the history six months
 * from now will not have the UI in front of them.
 */
function _describe(delta, before, after) {
  const parts = [];
  const say = (name, d, b, a) => {
    if (Math.abs(a - b) < 1e-9) return;
    const dir = a > b ? 'up' : 'down';
    parts.push(
      `${name} ${dir} ${b.toFixed(3)} → ${a.toFixed(3)} (accepted plan had ` +
      `${d > 0 ? 'more' : 'fewer'} of them)`
    );
  };
  say('changeover cost', delta.changeover, before.changeover, after.changeover);
  say('balance cost', delta.balance, before.balance, after.balance);
  return parts.length ? parts.join('; ') : 'no measurable change';
}

/**
 * Learn from one accepted plan.
 *
 * `proposed` and `accepted` are the objective terms of the two plans,
 * both measured by the planner's own _evaluate so they are comparable.
 * Returns what happened, including the no-op cases, because a caller
 * that cannot tell "learned nothing" from "did not run" is the silence
 * this whole programme exists to remove.
 */
async function observe({ proposed, accepted, lines, actor = '' } = {}) {
  const p = features(proposed);
  const a = features(accepted);
  const n = Math.max(1, Number(lines) || 0);

  const delta = {
    late:       a.late - p.late,
    changeover: a.changeover - p.changeover,
    balance:    a.balance - p.balance,
  };

  // Accepted exactly what was offered. No disagreement, nothing to
  // learn — and recording it as an observation would let a hundred
  // rubber-stamped plans satisfy the warm-up threshold without a single
  // correction behind it.
  const unchanged =
    Math.abs(delta.late) < 1e-9 &&
    Math.abs(delta.changeover) < 1e-9 &&
    Math.abs(delta.balance) < 1e-9;
  if (unchanged) return { updated: false, reason: 'unchanged' };

  let doc;
  try {
    doc = await _doc();
  } catch (err) {
    console.warn('[plannerLearning] observe failed to load weights:', err?.message);
    return { updated: false, reason: 'error' };
  }

  const before = { late: doc.late, changeover: doc.changeover, balance: doc.balance };

  // ── The update ──
  //
  // Minus, because the objective is MINIMISED: a feature the human took
  // more of is a feature we were charging too much for.
  //
  // `late` is updated with the rest and then normalised away by the
  // anchor below. Doing it that way rather than skipping it keeps the
  // update a plain vector operation — a special case for one component
  // is how the sign convention gets applied inconsistently later.
  const step = (w, d) => w - (LEARNING_RATE * d) / n;
  let next = {
    late:       step(before.late, delta.late),
    changeover: step(before.changeover, delta.changeover),
    balance:    step(before.balance, delta.balance),
  };

  // ── The anchor ──
  //
  // Renormalise so lateness is back at its fixed value. If the update
  // drove it to zero or below, the ratio is meaningless and the only
  // safe thing is to leave the weights where they were and say so.
  if (!(next.late > 1e-6)) {
    return { updated: false, reason: 'degenerate', note: 'update drove the lateness anchor to zero' };
  }
  const scale = DEFAULT_WEIGHTS.late / next.late;
  next = {
    late:       DEFAULT_WEIGHTS.late,
    changeover: clamp(next.changeover * scale, BOUNDS.changeover),
    balance:    clamp(next.balance * scale, BOUNDS.balance),
  };

  const note = _describe(delta, before, next);

  doc.late = next.late;
  doc.changeover = next.changeover;
  doc.balance = next.balance;
  doc.observations += 1;
  doc.history.unshift({
    at: new Date(), actor, lines: n,
    proposed: p, accepted: a, weights: next, note,
  });
  if (doc.history.length > HISTORY_LIMIT) doc.history = doc.history.slice(0, HISTORY_LIMIT);

  try {
    await doc.save();
  } catch (err) {
    console.warn('[plannerLearning] weights save failed:', err?.message);
    return { updated: false, reason: 'error' };
  }

  return {
    updated: true,
    before,
    after: next,
    delta,
    note,
    observations: doc.observations,
    // Below the threshold the new weights are stored but NOT yet in use.
    // Saying so is the difference between "it learned" and "it will
    // start using this once it has seen enough".
    inUse: doc.observations >= MIN_OBSERVATIONS,
  };
}

/** Everything the screen needs, including the history. */
async function report() {
  const doc = await _doc();
  const active = await currentWeights();
  return {
    active: { late: active.late, changeover: active.changeover, balance: active.balance },
    learned: active.learned,
    stored: { late: doc.late, changeover: doc.changeover, balance: doc.balance },
    defaults: { ...DEFAULT_WEIGHTS },
    bounds: BOUNDS,
    observations: doc.observations,
    needed: MIN_OBSERVATIONS,
    learningRate: LEARNING_RATE,
    lastResetAt: doc.lastResetAt || null,
    lastResetBy: doc.lastResetBy || '',
    history: (doc.history || []).slice(0, 20),
  };
}

/** Back to the constants, keeping the fact that it happened. */
async function reset(actor = '') {
  const doc = await _doc();
  doc.late = DEFAULT_WEIGHTS.late;
  doc.changeover = DEFAULT_WEIGHTS.changeover;
  doc.balance = DEFAULT_WEIGHTS.balance;
  doc.observations = 0;
  doc.history = [];
  doc.lastResetAt = new Date();
  doc.lastResetBy = actor;
  await doc.save();
  return { ...DEFAULT_WEIGHTS };
}

module.exports = {
  currentWeights, observe, report, reset, features,
  LEARNING_RATE, MIN_OBSERVATIONS, HISTORY_LIMIT,
};

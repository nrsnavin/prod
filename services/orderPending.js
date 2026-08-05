'use strict';
//
// ══════════════════════════════════════════════════════════════
//  ORDER PENDING QUANTITY
//
//  pending = ordered − PLANNED (the quantity committed to job orders)
//
//  Pending answers "how much of this order still needs a job raised for
//  it". It is NOT a production figure: once a job covers the quantity,
//  that quantity is no longer pending regardless of how much has been
//  woven. Production is tracked on the job (JobOrder.producedElastic) and
//  mirrored onto Order.producedElastic for reporting — it must never move
//  pending, or planning and production fight each other.
//
//  (The production cascade used to recompute pending as ordered − produced,
//  which overwrote the planning deduction: planning 600 of 1000 dropped
//  pending to 400, then producing 200 pushed it back up to 800.)
//
//  Cancelled jobs release their quantity back to pending. Completed jobs
//  do NOT — the quantity stays committed; the order is fulfilled by that
//  job, not waiting for another one.
// ══════════════════════════════════════════════════════════════

const JobOrder = require('../models/JobOrder');

// Jobs that no longer hold any of the order's quantity.
const RELEASING_STATUSES = ['cancelled'];

/**
 * Recompute `order.pendingElastic` from the order's live job orders.
 * Mutates the order in place — the caller saves (optionally in a session).
 *
 * @param {Document} order    a mongoose Order document
 * @param {ClientSession} [session]
 */
async function recomputePending(order, session) {
  let q = JobOrder.find({
    order: order._id,
    status: { $nin: RELEASING_STATUSES },
  }).select('elastics');
  if (session) q = q.session(session);
  const jobs = await q;

  const planned = {};
  for (const j of jobs) {
    for (const e of j.elastics || []) {
      if (!e?.elastic) continue;
      const id = e.elastic.toString();
      planned[id] = (planned[id] || 0) + (e.quantity || 0);
    }
  }

  // Guard o.elastic like the jobs loop above guards e.elastic: the
  // app-wide blank-ref normaliser can leave a null ref on a malformed
  // row, and one such row would crash every recompute on this order.
  order.pendingElastic = (order.elasticOrdered || [])
    .filter((o) => o?.elastic)
    .map((o) => ({
      elastic: o.elastic,
      // Never negative: over-planning an order is a data problem, not a
      // reason to show a negative outstanding quantity.
      quantity: Math.max(0, (o.quantity || 0) - (planned[o.elastic.toString()] || 0)),
    }));

  return order.pendingElastic;
}

/**
 * Mirror total produced meters from the order's jobs onto
 * Order.producedElastic. Tracking only — never touches pending.
 */
async function recomputeProduced(order, session) {
  let q = JobOrder.find({ order: order._id }).select('producedElastic');
  if (session) q = q.session(session);
  const jobs = await q;

  const produced = {};
  for (const j of jobs) {
    for (const p of j.producedElastic || []) {
      if (!p?.elastic) continue;
      const id = p.elastic.toString();
      produced[id] = (produced[id] || 0) + (p.quantity || 0);
    }
  }

  for (const row of order.producedElastic || []) {
    row.quantity = produced[row.elastic.toString()] || 0;
  }
  return order.producedElastic;
}

/**
 * Mirror total packed metres from the order's jobs onto
 * Order.packedElastic.
 *
 * Packing used to update the JOB's figure and push a fingerprint onto
 * the order without touching the order's own numbers — so the audit
 * trail said metres had been packed while the order said none had. It
 * matters twice over now that pending means ordered less packed: an
 * order with every metre packed still read as entirely outstanding.
 *
 * Derived from the jobs, not incremented in place. A counter drifts the
 * moment a packing is corrected or reversed, or the same request is
 * replayed; a recompute can only ever say what the jobs say.
 *
 * Tracking only — packing never touches pending, which is ordered less
 * PLANNED and answers a different question.
 */
async function recomputePacked(order, session) {
  let q = JobOrder.find({ order: order._id }).select('packedElastic');
  if (session) q = q.session(session);
  const jobs = await q;

  const packed = {};
  for (const j of jobs) {
    for (const p of j.packedElastic || []) {
      if (!p?.elastic) continue;
      const id = p.elastic.toString();
      packed[id] = (packed[id] || 0) + (p.quantity || 0);
    }
  }

  for (const row of order.packedElastic || []) {
    row.quantity = packed[row.elastic.toString()] || 0;
  }
  return order.packedElastic;
}

module.exports = {
  recomputePending,
  recomputeProduced,
  recomputePacked,
  RELEASING_STATUSES,
};

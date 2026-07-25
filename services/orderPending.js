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

  order.pendingElastic = (order.elasticOrdered || []).map((o) => ({
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

module.exports = { recomputePending, recomputeProduced, RELEASING_STATUSES };

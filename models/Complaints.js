'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER SAYING SOMETHING WAS WRONG
//
//  Distinct from EmployeeFeedback, which is the worker-facing channel
//  and has its own lifecycle. This one points outward: a customer, the
//  job they received, and what they said about it.
//
//  ── Why this file changed shape ──────────────────────────────────
//  It was written as an ES module (`export default`) in a codebase
//  where every other model is CommonJS, and it had no routes and no
//  mount — nothing could file a complaint, read one, or resolve one.
//  So the collection could only ever have been empty, and any service
//  that `require`d it would have got `{ default: Model }` rather than a
//  model and failed on the first query. Both are fixed here.
//
//  ── `job`, not `order` ───────────────────────────────────────────
//  The link was previously called `order` while referencing JobOrder.
//  That mattered enough to rename: the whole value of a complaint
//  record is the trail behind it, and the trail runs through the JOB —
//  warping programme, beams, yarn lots. Someone reading `complaint.order`
//  and joining it against the Order collection gets no rows, or worse,
//  rows belonging to a different customer entirely. See
//  migrations/20260818000002-complaint-order-to-job.js.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/**
 * What the complaint is about.
 *
 * Deliberately coarse and deliberately deterministic. The free text is
 * where the detail lives, but free text cannot be counted, and a report
 * that says "shade complaints tripled this quarter" needs a field it can
 * group by on day one — not a year from now when there is enough prose
 * to cluster. See services/complaintThemes.js for why that distinction
 * is enforced rather than hoped for.
 */
const CATEGORIES = ['shade', 'strength', 'width', 'finish', 'quantity', 'packing', 'delivery', 'other'];

const STATUSES = ['Open', 'InReview', 'Resolved', 'Rejected', 'Closed'];

const ComplaintSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, default: Date.now },

    customer: {
      type: mongoose.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },

    /** The job that was delivered. The head of the lot trail. */
    job: {
      type: mongoose.Types.ObjectId,
      ref: 'JobOrder',
      required: true,
      index: true,
    },

    /**
     * Which elastic on the job, where the customer said.
     *
     * Optional on purpose. A job routinely carries several elastics and
     * the customer's message rarely names one — recording a guess here
     * would narrow the blast radius to the wrong product, which is the
     * one failure mode this whole feature exists to prevent. Empty means
     * "they did not say", and the trace then covers the whole job.
     */
    elastic: { type: mongoose.Types.ObjectId, ref: 'Elastic' },

    category: { type: String, enum: CATEGORIES, default: 'other', index: true },

    status: { type: String, enum: STATUSES, default: 'Open', required: true, index: true },

    /** What they said, in their words. */
    reason: { type: String, required: true, trim: true },

    /** Anything added afterwards — a call, a photo description. */
    feedback: { type: String, trim: true, default: '' },

    actionTakenBy: { type: mongoose.Types.ObjectId, ref: 'Employee' },

    /** What was found and done. Written when the complaint is settled. */
    resolution: { type: String, default: '' },

    attachments: [{ type: String }],
  },
  { timestamps: true }
);

// The two orderings anyone actually asks for: newest first overall, and
// newest first for one customer.
ComplaintSchema.index({ date: -1 });
ComplaintSchema.index({ customer: 1, date: -1 });

module.exports = mongoose.model('Complaint', ComplaintSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;

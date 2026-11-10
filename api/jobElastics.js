'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — THE ELASTICS A JOB MAKES  (part of /api/v2/job)
//
//    POST  /update-elastics
//    GET   /:jobId/order-elastics
//    POST  /:jobId/change-elastic
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const { assertVersion } = require('../utils/versioning');
const ErrorHandler     = require('../utils/ErrorHandler');
const { isAdmin } = require('../middleware/auth');
const JobOrder    = require('../models/JobOrder');
const Order       = require('../models/Order');
const Warping     = require('../models/Warping');
const Covering    = require('../models/Covering');
const { recomputePending } = require('../services/orderPending.js');
const WarpingBatch = require('../models/WarpingBatch');
const { stampFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { requireReason } = require('../utils/auditReason');
const { carryEarmarksForward } = require('../services/lotAllocation');
const { assessLines, plannedFromJobs } = require('../services/excessPlanning');
const { changeElasticMidRun, orderElasticsForJob } = require('../services/jobMidRun');
const router = express.Router();

// ─────────────────────────────────────────────────────────────
//  4b. EDIT THE JOB'S ELASTIC QUANTITIES
//
//  Only while the job is still PREPARATORY and neither its warping nor
//  its covering has started.
//
//  Those two conditions are not the same thing and both matter. The
//  status says the job has not reached the loom; the stages say nobody
//  has begun building a beam for it. A warping programme in progress is
//  a commitment made in the physical world — sections chosen, lots
//  drawn, a beam part-built — and changing the quantity underneath it
//  leaves the programme and the job describing different work, with the
//  programme winning because it is what the machine follows.
//
//  ── What it cascades to ──────────────────────────────────────────
//  The job's own lines, its warping's `elasticOrdered` and its
//  covering's `elasticPlanned` (both mirrors written at create), the
//  order's pending figures, and the order's raw material requirement —
//  restated for what is now PLANNED, so the requirement sheet and the
//  yarn that left stock tell the same story.
//
//  ── What it deliberately does not do ────────────────────────────
//  It does not redraw material. The excess draw at create took yarn out
//  of stock for the metres over the order; changing the quantity here
//  changes that excess, and reversing and re-applying a stock draw is a
//  separate, heavier piece of work than this route should be doing
//  quietly. So an edit that would change the excess is REFUSED, naming
//  what to do instead. A silent partial cascade would be worse than a
//  refusal — it is how a stock figure becomes a number nobody can
//  account for.
// ─────────────────────────────────────────────────────────────
router.post(
  '/update-elastics',
  isAdmin('admin', 'production', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, elastics } = req.body;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));
    if (!Array.isArray(elastics) || elastics.length === 0)
      return next(new ErrorHandler('elastics array must not be empty', 400));

    const auditReason = requireReason(req);
    if (!auditReason)
      return next(new ErrorHandler('A reason (min 3 chars) is required to edit', 400));

    for (const e of elastics) {
      if (!e.elastic) return next(new ErrorHandler('Each entry must name an elastic', 400));
      const q = Number(e.quantity);
      if (!Number.isFinite(q) || q <= 0)
        return next(new ErrorHandler('Each quantity must be a positive number', 400));
    }
    const ids = elastics.map((e) => String(e.elastic));
    if (new Set(ids).size !== ids.length)
      return next(new ErrorHandler('The same elastic appears twice', 400));

    // ── All of it in one transaction ────────────────────────────────
    // The job, its warping and covering programmes and the order's
    // pending and yarn requirement used to be separate writes: a failure
    // between them left the sheets on the floor disagreeing with the job.
    // And the "has preparation started?" check could be overtaken by a
    // warping batch raised at the same moment; both now write the
    // warping, so one is retried and re-checks.
    let job;
    let carried;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        job = await JobOrder.findById(jobId).session(session);
        if (!job) throw new ErrorHandler('Job not found', 404);
        // Two planners changing one job's quantities: the second is a 409
        // and re-reads, rather than replacing the first person's figures.
        assertVersion(job, req);
        // Preparatory: the lines are free to change, and so is which
        // elastics there are, as long as nothing is drawn yet. Running
        // (weaving, finishing, checking): the same elastics, each at no
        // less than what was woven — the beam came up short, or the loom
        // was set for a rounder number — and nothing made is touched.
        const running = ['weaving', 'finishing', 'checking'].includes(job.status);
        if (job.status !== 'preparatory' && !running) {
          throw new ErrorHandler(
            `Quantities can be changed until the job reaches packing (current: "${job.status}").`,
            400
          );
        }

        if (!running) {
          // ── Has the floor started on it? ──────────────────────────────
          const warping  = job.warping  ? await Warping.findById(job.warping).select('status').session(session).lean()   : null;
          const covering = job.covering ? await Covering.findById(job.covering).select('status').session(session).lean() : null;
          const batches  = await WarpingBatch.countDocuments({ job: job._id, status: { $ne: 'cancelled' } }).session(session);
          const started = [];
          if (warping  && warping.status  !== 'open') started.push(`warping is ${warping.status}`);
          if (covering && covering.status !== 'open') started.push(`covering is ${covering.status}`);
          // A batch is yarn off the rack, whatever the stage says.
          if (batches > 0) started.push(`${batches} warping batch(es) already raised`);
          if (started.length > 0) {
            const err = new ErrorHandler(
              `Quantities cannot be changed once preparation has started — ${started.join('; ')}.`,
              409
            );
            err.code = 'JOB_PREPARATION_STARTED';
            err.details = { blockers: started };
            throw err;
          }
        } else {
          const have = new Set((job.elastics || []).map((e) => String(e.elastic)));
          const sent = new Set(elastics.map((e) => String(e.elastic)));
          if (have.size !== sent.size || [...have].some((id) => !sent.has(id))) {
            throw new ErrorHandler(
              'A running job keeps its elastics: send every line it has, and only those. ' +
              'To bring one in or close one out, use Change elastic.',
              400
            );
          }
          const woven = (rows, id) => (rows || []).find((r) => String(r.elastic) === id)?.quantity || 0;
          for (const e of elastics) {
            const id = String(e.elastic);
            const line = job.elastics.find((l) => String(l.elastic) === id);
            const q = Number(e.quantity);
            if (line.frozen && q !== line.quantity) {
              throw new ErrorHandler(`A frozen line stays at what was woven (${line.quantity} m).`, 400);
            }
            const made = Math.max(woven(job.producedElastic, id), woven(job.packedElastic, id));
            if (q < made) {
              throw new ErrorHandler(
                `${made} m of this elastic is already woven or packed; the plan cannot be below that.`, 400
              );
            }
          }
        }

        const order = await Order.findById(job.order).session(session);
        if (!order) throw new ErrorHandler('Order not found for this job', 404);

        // ── Every line must still belong to the order ───────────────────
        const siblings = await JobOrder.find({
          order: order._id, status: { $ne: 'cancelled' }, _id: { $ne: job._id },
        }).select('elastics').session(session).lean();

        const rows = assessLines(elastics, order, plannedFromJobs(siblings));
        const offOrder = rows.find((r) => !r.onOrder);
        if (offOrder) {
          throw new ErrorHandler(
            `Elastic ${offOrder.elastic} is not part of this order`, 400
          );
        }

        // ── The excess must not change ──────────────────────────────────
        // See the note above. Compared against what THIS job's lines
        // currently make it, with the siblings held constant.
        const before = assessLines(
          (job.elastics || []).map((e) => ({ elastic: e.elastic, quantity: e.quantity })),
          order,
          plannedFromJobs(siblings)
        );
        const excessOf = (set) =>
          Math.round(set.reduce((sum, r) => sum + Math.max(0, r.excess || 0), 0) * 1000) / 1000;
        const wasExcess = excessOf(before);
        const nowExcess = excessOf(rows);

        if (nowExcess !== wasExcess) {
          const err = new ErrorHandler(
            `This edit changes the over-planned quantity (${wasExcess} → ${nowExcess}), and the ` +
            `yarn for the original excess has already been drawn from stock. Cancel this job and ` +
            `raise it again at the quantity you want, so the material is drawn once and correctly.`,
            409
          );
          err.code = 'JOB_EXCESS_WOULD_CHANGE';
          err.details = { wasExcess, nowExcess };
          throw err;
        }

        // ── Apply ───────────────────────────────────────────────────────
        const previous = (job.elastics || []).map((e) => ({
          elastic: String(e.elastic), quantity: e.quantity,
        }));
        const zeroed = elastics.map((e) => ({ elastic: e.elastic, quantity: 0 }));

        if (running) {
          // Only the figures move; the lines, their flags and everything
          // made against them stay.
          for (const e of elastics) {
            const line = job.elastics.find((l) => String(l.elastic) === String(e.elastic));
            line.quantity = Number(e.quantity);
          }
        } else {
          job.elastics       = elastics.map((e) => ({ elastic: e.elastic, quantity: Number(e.quantity) }));
          // Nothing has been made yet — the job is preparatory and no beam
          // has been started — so these are reset rather than carried across,
          // which also drops rows for an elastic the edit removed.
          job.producedElastic = zeroed;
          job.packedElastic   = zeroed;
          job.wastageElastic  = zeroed;
        }

        stampFingerprint(job, ACTION_CODES.JOB_STAGE_UPDATED, {
          req,
          meta: {
            change: 'elastics',
            auditReason,
            before: previous,
            after: job.elastics.map((e) => ({ elastic: String(e.elastic), quantity: e.quantity })),
          },
        });
        job.markModified('fingerprints');
        job.increment();
        await job.save({ session });

        // The two programmes mirror the job's lines; they are written from
        // them at create and would otherwise keep the old figures on the
        // sheet that goes to the machine.
        // One after the other (a session runs one operation at a time).
        // Writing the warping also makes this edit collide with a warping
        // batch being raised at the same moment, which writes it too: one
        // of them is retried and sees the other.
        // A running job's programmes are done: the sheets they printed
        // are history, and are left as they were.
        if (!running && job.warping) {
          await Warping.updateOne({ _id: job.warping }, { $set: { elasticOrdered: job.elastics } }, { session });
        }
        if (!running && job.covering) {
          await Covering.updateOne({ _id: job.covering }, { $set: { elasticPlanned: job.elastics } }, { session });
        }

        // ── The order ───────────────────────────────────────────────────
        // Pending is recomputed from the order's live jobs rather than
        // adjusted in place, so a re-run cannot double-count.
        await recomputePending(order, session);

        // And the requirement is restated for what is now PLANNED — the
        // "calculate the MRP again" half of this. Same shape as the create
        // route uses, so the two cannot drift.
        const allRows = assessLines(job.elastics, order, plannedFromJobs(siblings));
        const plannedLines = (order.elasticOrdered || []).map((l) => {
          const row = allRows.find((r) => String(r.elastic) === String(l.elastic));
          return {
            elastic: l.elastic,
            quantity: row ? Math.max(row.ordered, row.totalPlanned) : Number(l.quantity) || 0,
          };
        });
        // Carried, not assigned — the same reason as the create route.
        // computeMaterialRequirement returns rows with no `lots` field, so
        // this line used to wipe every dye lot the order had set aside,
        // silently, every time somebody edited a job's quantity.
        const recomputed = await computeMaterialRequirement(plannedLines);
        carried = carryEarmarksForward(order.rawMaterialRequired, recomputed);
        order.rawMaterialRequired = carried.rows;
        order.updatedItemsAt = new Date();
        await order.save({ session });
      });
    } finally {
      await session.endSession();
    }

    // Say it in the response rather than only in a log. Cutting a job's
    // quantity can shrink a requirement below what was already promised,
    // and the planner who just did it is the one person who can decide
    // whether the freed yarn should go somewhere else.
    const lotNote = [
      carried.trimmed.length
        && `Dye lots trimmed to fit on ${carried.trimmed.map((t) => t.name).join(', ')}`,
      carried.dropped.length
        && `Dye lots released on ${carried.dropped.map((d) => d.name).join(', ')}`,
    ].filter(Boolean).join('. ');

    res.json({
      success: true,
      message: 'Job quantities updated, and the order requirement recalculated'
        + (lotNote ? `. ${lotNote}.` : ''),
      lots: { trimmed: carried.trimmed, released: carried.dropped },
      job: {
        _id: job._id,
        jobOrderNo: job.jobOrderNo,
        status: job.status,
        elastics: job.elastics,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  4b. CHANGE THE ELASTIC MID-RUN — the exceptional case
//
//  POST /job/:jobId/change-elastic
//    { elastic, quantity, auditReason, freeze: [ids], heads, confirmHooks, expectedVersion }
//  GET  /job/:jobId/order-elastics
//    the order's elastics as candidates: ordered, planned, pending, on this job
//
//  See services/jobMidRun.js. The line that leaves is frozen at what
//  was woven; the one that comes in must be on the order and within
//  what it still has unplanned; the loom's heads follow if asked.
// ─────────────────────────────────────────────────────────────
router.get(
  '/:jobId/order-elastics',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.jobId)) return next(new ErrorHandler('Job not found', 404));
    res.json({ success: true, ...(await orderElasticsForJob(req.params.jobId)) });
  })
);

router.post(
  '/:jobId/change-elastic',
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res) => {
    const out = await changeElasticMidRun({
      jobId: req.params.jobId,
      elastic: req.body.elastic || null,
      quantity: req.body.quantity,
      freeze: req.body.freeze ?? [],
      heads: req.body.heads ?? 'frozen',
      confirmHooks: req.body.confirmHooks === true,
    }, req);
    res.json({
      success: true,
      message: out.message,
      frozen: out.frozen,
      headsChanged: out.headsChanged,
      job: { _id: out.job._id, jobOrderNo: out.job.jobOrderNo, status: out.job.status, elastics: out.job.elastics },
    });
  })
);

module.exports = router;

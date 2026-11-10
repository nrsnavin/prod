'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — STATUS, WEAVING READINESS, CANCEL, WASTAGE  (part of /api/v2/job)
//
//    POST  /update-status
//    GET   /:jobId/weaving-readiness
//    POST  /cancel
//    POST  /create-wastage
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const JobOrder    = require('../models/JobOrder');
const Order       = require('../models/Order');
const Wastage     = require('../models/Wastage');
const Machine     = require('../models/Machine');
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');
const { checkWeavingReadiness } = require('../services/weavingReadiness');
// Job status flow, transition rules, per-stage timestamps and the
// stampStage helper all live in domain/jobStatus.js — the single
// source of truth (was previously re-encoded three times in this file).
const { validateTransition, stampStage } = require('../domain/jobStatus');
// The order's own rule. This router changes an order's status three
// times as a side effect of something happening to a job, and none of
// those writes used to ask where the order actually was — which is how
// cancelling a job on a CANCELLED order set it back to Approved.
const orderLifecycle = require('../services/orderLifecycle');
const dispatchQueue = require('../services/dispatchQueue');
const { outsourcingBlockers } = require('../utils/outsourcingRecord');
const router = express.Router();

/**
 * Let go of every machine standing on a job.
 *
 * Takes the JOB, not a machine id. The link lives on both documents —
 * `job.machine` and `machine.orderRunning` — and releasing by the job's
 * side alone misses a machine that holds the job while the job does not
 * point back, which is a state the non-transactional assign path can
 * produce. Such a machine was then held forever: nothing would ever
 * release it, because the job it claimed to run had no idea.
 *
 * `elastics` is cleared too. Leaving the head plan on a free machine
 * makes the next job's picker show heads already mapped to another
 * job's products.
 *
 * Never touches a machine in maintenance — that is not a job holding it,
 * and "free" would put a machine back in the picker that is in pieces.
 */
async function releaseMachinesForJob(job, session = null) {
  if (!job?._id) return;

  await Machine.updateMany(
    { orderRunning: job._id, status: 'running' },
    { $set: { status: 'free', orderRunning: null, elastics: [] } },
    { session }
  );

  // The mirror-image stray: the job points at a machine that no longer
  // claims it.
  if (job.machine) {
    await Machine.updateOne(
      { _id: job.machine, status: { $ne: 'maintenance' } },
      { $set: { status: 'free', orderRunning: null, elastics: [] } },
      { session }
    );
  }
}

// ─────────────────────────────────────────────────────────────
//  5. UPDATE JOB STATUS
// ─────────────────────────────────────────────────────────────
router.post(
  '/update-status',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, nextStatus } = req.body;
    if (!jobId)      return next(new ErrorHandler('jobId is required', 400));
    if (!nextStatus) return next(new ErrorHandler('nextStatus is required', 400));

    // ── One transaction, on the job as it is now ──────────────────
    // The transition used to be judged on a copy read before anything
    // was written, then saved: a cancellation (or another status move)
    // landing in between was overwritten, and the looms were released
    // before the save that could still fail. Now the job is read, judged
    // and written inside one transaction; a write that collides with
    // another is retried from the read.
    //
    // Completing a job also writes its ORDER. Two last jobs completing
    // at the same moment each saw the other still running, so neither
    // closed the order, which then stayed in progress with every job
    // done. Both now write the order, so the second is retried, sees
    // the first done, and closes it.
    let job;
    let stageFp;
    let completionFp = null;
    const actor = actorFromRequest(req);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        completionFp = null;
        job = await JobOrder.findById(jobId).session(session);
        if (!job) throw new ErrorHandler('Job not found', 404);

        const check = validateTransition(job.status, nextStatus);
        if (!check.ok) throw new ErrorHandler(check.message, 400);

        if (check.gate === 'weaving-readiness') {
          const readiness = await checkWeavingReadiness(job._id, session);
          if (!readiness.ready) {
            const err = new ErrorHandler(
              `Job cannot move to weaving yet — ${readiness.blockers.join('; ')}`,
              409
            );
            err.code = 'WEAVING_NOT_READY';
            err.details = { status: job.status, stages: readiness.stages, blockers: readiness.blockers };
            throw err;
          }
        }

        // An outsourced job's vendor record must be complete before it
        // comes back for finishing.
        if (nextStatus === 'finishing' && job.productionMode === 'outsource') {
          const blockers = outsourcingBlockers(job.outsourcing);
          if (blockers.length > 0) {
            const err = new ErrorHandler(
              `Job cannot move to finishing yet — complete the vendor record: ${blockers.join('; ')}`,
              409
            );
            err.code = 'OUTSOURCING_INCOMPLETE';
            err.details = { status: job.status, vendor: job.outsourceVendor || '', blockers };
            throw err;
          }
        }

        // Off the loom: let the machines go, in the same transaction as
        // the status, so a failed save does not leave them released.
        if (nextStatus === 'finishing') {
          await releaseMachinesForJob(job, session);
          job.machine = undefined;
        }

        const previousStage = job.status;
        stageFp = buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
          entityId: job._id,
          actor,
          meta: {
            previousStage,
            newStage:        nextStatus,
            jobOrderNo:      job.jobOrderNo,
            machineReleased: nextStatus === 'finishing',
          },
        });
        job.fingerprints.push(stageFp);

        if (nextStatus === 'completed') {
          // Touch the order first: see above. Any two completions on one
          // order now write the same document and cannot both read stale.
          await Order.updateOne({ _id: job.order }, { $currentDate: { updatedAt: true } }, { session });

          const siblingJobs = await JobOrder.find({ order: job.order, _id: { $ne: job._id } })
            .select('status').session(session);
          const allDone = siblingJobs.every(j => ['completed', 'cancelled'].includes(j.status));

          // 🪪 Job completion milestone fingerprint
          completionFp = buildFingerprint(ACTION_CODES.JOB_COMPLETED, {
            entityId: job._id,
            actor,
            meta: {
              jobOrderNo:        job.jobOrderNo,
              orderId:           job.order.toString(),
              allSiblingsDone:   allDone,
              orderClosedByThis: allDone,
            },
          });
          job.fingerprints.push(completionFp);

          // The last job done closes the order and gives its reserved
          // stock back (services/orderLifecycle.js), unless the order was
          // cancelled or deleted, which its jobs finishing never undoes.
          if (allDone) {
            await orderLifecycle.lastJobCompleted(session, job, {
              actor, userId: req.user?._id, completionFp,
            });
          }
        }

        stampStage(job, nextStatus, req.user?._id);
        job.status = nextStatus;
        await job.save({ session });

        // Packing is the dispatch stage: the job joins the dispatch queue,
        // waiting for marketing / admin to say how urgent delivery is. In
        // the same transaction, so the move and the queue entry stand or
        // fall together. Completing a job that somehow has no entry (one
        // already past packing when the queue arrived) adds it then.
        if (nextStatus === 'packing' || nextStatus === 'completed') {
          await dispatchQueue.enqueueJob(job, {
            session, actor: { by: req.user?._id, byName: req.user?.name || '' },
          });
        }
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      message: `Job advanced to "${nextStatus}"`,
      data:    { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
      fingerprint: stageFp,
      completionFingerprint: completionFp,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  5b. WEAVING READINESS
//      Read-only. Lets the UI show the "move to weaving" action and
//      the reason it is unavailable BEFORE the user presses it,
//      rather than only as an error afterwards.
// ─────────────────────────────────────────────────────────────
router.get(
  '/:jobId/weaving-readiness',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) {
      return next(new ErrorHandler('Invalid job id', 400));
    }
    const readiness = await checkWeavingReadiness(req.params.jobId);
    if (readiness.jobStatus === 'unknown') {
      return next(new ErrorHandler('Job not found', 404));
    }
    res.json({ success: true, data: readiness });
  })
);

// ─────────────────────────────────────────────────────────────
//  6. CANCEL JOB
// ─────────────────────────────────────────────────────────────
router.post(
  '/cancel',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, reason } = req.body;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));
    // One transaction, on the job as it is now. This was a run of
    // separate writes on a copy read first: the looms released, the job
    // saved, then the order. A failure part-way left the order still
    // counting a cancelled job's quantity, and a completion or another
    // cancel landing in between was overwritten. Re-read and judged
    // inside the transaction; anything colliding with it is retried.
    let job;
    let fp;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        job = await JobOrder.findById(jobId).session(session);
        if (!job) throw new ErrorHandler('Job not found', 404);
        if (job.status === 'cancelled') throw new ErrorHandler('Job is already cancelled', 400);
        if (job.status === 'completed') throw new ErrorHandler('A completed job cannot be cancelled', 400);

        // Whatever the job was standing on, it is not standing on it now.
        //
        // This used to run only for a job in WEAVING that pointed at a
        // machine. A machine can be claimed while the job is still
        // preparatory — the system offers that deliberately, to reserve
        // capacity — so cancelling such a job left its machine running
        // forever on a job that no longer exists to release it.
        await releaseMachinesForJob(job, session);
        job.machine = undefined;

        const previousStatus = job.status;
        stampStage(job, 'cancelled', req.user?._id);
        job.status = 'cancelled';
        if (reason) job.cancelReason = reason;

        // 🪪 Fingerprint: JOB_CANCELLED
        fp = buildFingerprint(ACTION_CODES.JOB_CANCELLED, {
          entityId: job._id,
          actor:    actorFromRequest(req),
          meta: {
            previousStatus,
            reason:     reason || null,
            jobOrderNo: job.jobOrderNo,
          },
        });
        job.fingerprints.push(fp);
        await job.save({ session });

        // Nothing left to deliver: off the dispatch queue, if it was on it.
        await dispatchQueue.cancelForJob(job._id, 'Job cancelled', {
          session, actor: { by: req.user?._id, byName: req.user?.name || '' },
        });

        // Only now that the job is marked 'cancelled' does its planned
        // quantity return to pending: recomputed after the save, in the
        // same transaction. With nothing live left, a running order goes
        // back to waiting (services/orderLifecycle.js).
        await orderLifecycle.jobCancelled(job, { userId: req.user?._id, session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      message: 'Job cancelled and quantities restored to order',
      data: { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
      fingerprint: fp,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  7. CREATE WASTAGE ENTRY
// ─────────────────────────────────────────────────────────────
router.post(
  '/create-wastage',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, elasticId, employeeId, quantity, penalty, reason } = req.body;
    if (!jobId)      return next(new ErrorHandler('jobId is required', 400));
    if (!elasticId)  return next(new ErrorHandler('elasticId is required', 400));
    if (!employeeId) return next(new ErrorHandler('employeeId is required', 400));
    if (!reason?.trim()) return next(new ErrorHandler('reason is required', 400));
    if (typeof quantity !== 'number' || quantity <= 0)
      return next(new ErrorHandler('quantity must be a positive number', 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const job = await JobOrder.findById(jobId).session(session);
        if (!job) throw new ErrorHandler('Job not found', 404);
        if (!['weaving', 'finishing', 'checking'].includes(job.status))
          throw new ErrorHandler(`Wastage can only be recorded during weaving, finishing, or checking`, 400);
        if (!job.elastics.find(e => e.elastic.toString() === elasticId.toString()))
          throw new ErrorHandler('Elastic is not part of this job', 400);

        // Wastage.create with a session expects array-form input
        const [wastage] = await Wastage.create([{
          job: job._id, elastic: elasticId, employee: employeeId,
          quantity, penalty: penalty || 0, reason: reason.trim(),
        }], { session });

        const idx = job.wastageElastic.findIndex(e => e.elastic.toString() === elasticId.toString());
        if (idx >= 0) job.wastageElastic[idx].quantity += quantity;
        job.wastages.push(wastage._id);

        // 🪪 Fingerprint per wastage entry on the job's timeline.
        //    Job-only — granular events don't fan out to the order.
        const fp = buildFingerprint(ACTION_CODES.WASTAGE_RECORDED, {
          entityId: job._id,
          actor:    actorFromRequest(req),
          meta: {
            wastageId:  wastage._id.toString(),
            elasticId:  elasticId.toString(),
            employeeId: employeeId.toString(),
            quantity,
            penalty:    penalty || 0,
            reason:     reason.trim(),
            jobStage:   job.status,
          },
        });
        job.fingerprints.push(fp);
        await job.save({ session });

        resp = { wastage, fingerprint: fp };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

module.exports = router;

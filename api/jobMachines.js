'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — SUMMARY, OPERATORS, CHECKING, MACHINES  (part of /api/v2/job)
//
//    GET   /summary
//    GET   /job-operators
//    GET   /jobs-checking
//    POST  /assign-machine
//    GET   /free-machines
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const JobOrder    = require('../models/JobOrder');
const Machine     = require('../models/Machine');
const ShiftDetail = require('../models/ShiftDetail');
const { draftedForJobs } = require('../services/floorDrafts');
const { setMachineLoading } = require('../services/machineLoading');
const { stampFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { checkWeavingReadiness } = require('../services/weavingReadiness');
// Job status flow, transition rules, per-stage timestamps and the
// stampStage helper all live in domain/jobStatus.js — the single
// source of truth (was previously re-encoded three times in this file).
const { stampStage } = require('../domain/jobStatus');
const { checkHookFit, hookFitError } = require('../utils/machineFit');
const { loadingAfter } = require("./jobShared");
const router = express.Router();

// ─────────────────────────────────────────────────────────────
//  8. SUMMARY
// ─────────────────────────────────────────────────────────────
router.get(
  '/summary',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));
    const job = await JobOrder.findById(jobId)
      .populate('elastics.elastic', 'name')
      .populate('producedElastic.elastic', 'name')
      .populate('packedElastic.elastic', 'name')
      .populate('wastageElastic.elastic', 'name');
    if (!job) return next(new ErrorHandler('Job not found', 404));
    // Entered on the floor, not verified yet (services/floorDrafts.js):
    // shown beside the verified figure, never added to it.
    const drafts = (await draftedForJobs([job._id])).get(String(job._id));
    const summary = job.elastics.map(e => {
      const find = arr => arr.find(x => x.elastic._id.toString() === e.elastic._id.toString())?.quantity || 0;
      const planned  = e.quantity;
      const produced = find(job.producedElastic);
      const packed   = find(job.packedElastic);
      const wasted   = find(job.wastageElastic);
      const drafted  = drafts?.byElastic.get(String(e.elastic._id)) || 0;
      return {
        elasticId: e.elastic._id, elasticName: e.elastic.name,
        planned, produced, packed, wasted,
        // Metres entered on the floor and waiting to be verified. What
        // `produced` will become once they are; a claim until then.
        drafted,
        // Changed mid-run (services/jobMidRun.js): a frozen line is
        // complete as it stands; an added one came in with a reason.
        frozen: !!e.frozen, plannedBeforeFreeze: e.plannedBeforeFreeze ?? null, addedMidRun: !!e.addedMidRun,
        // planned − produced, and NOT − wasted.
        //
        // `producedElastic` is GROSS: it is what came off the loom, and
        // recording wastage only adds to `wastageElastic` — api/wastage.js
        // never decrements produced. So the wasted meters are already
        // inside `produced`, and subtracting them here took them out a
        // second time: a job that had run its full quantity and rejected
        // 50 m read as 50 m still to weave, and the error grew with every
        // wastage entry.
        //
        // Wastage is a record, not a claim on the plan. It is reported on
        // its own column above. How much GOOD elastic the customer is
        // owed is a different question with a different answer — the
        // order's `pendingDelivery` (ordered − packed), which is why the
        // two are kept apart.
        remaining: Math.max(0, planned - produced),
        packingPct: planned > 0 ? Math.round((packed / planned) * 100) : 0,
      };
    });
    res.json({
      success: true, jobId: job._id, jobNo: job.jobOrderNo, status: job.status, summary,
      // How many floor entries on this job are waiting to be verified.
      draftShifts: drafts?.shifts || 0,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  9. JOB OPERATORS
// ─────────────────────────────────────────────────────────────
router.get(
  '/job-operators',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler('Job ID is required', 400));
    const shifts = await ShiftDetail.find({ job: id }).populate('employee', 'name department');
    const seen = new Set(); const operators = [];
    for (const s of shifts) {
      if (s.employee && !seen.has(s.employee._id.toString())) {
        seen.add(s.employee._id.toString());
        operators.push(s.employee);
      }
    }
    res.json({ success: true, operators });
  })
);

// ─────────────────────────────────────────────────────────────
//  10. JOBS IN CHECKING
// ─────────────────────────────────────────────────────────────
router.get(
  '/jobs-checking',
  catchAsyncErrors(async (req, res, next) => {
    const jobs = await JobOrder.find({ status: 'checking' })
      .populate('customer', 'name')
      .select('_id jobOrderNo elastics customer date');
    res.json({ success: true, jobs });
  })
);

// ─────────────────────────────────────────────────────────────
//  11. ASSIGN MACHINE
// ─────────────────────────────────────────────────────────────
router.post(
  '/assign-machine',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId, elastics } = req.body;
    if (!jobId)     return next(new ErrorHandler('jobId is required.', 400));
    if (!machineId) return next(new ErrorHandler('machineId is required.', 400));
    if (!Array.isArray(elastics) || elastics.length === 0)
      return next(new ErrorHandler('elastics must be a non-empty array of { head, elastic }.', 400));

    for (const entry of elastics) {
      if (typeof entry.head !== 'number' || !Number.isInteger(entry.head) || entry.head < 1)
        return next(new ErrorHandler(`Invalid head value "${entry.head}". Must be a positive integer.`, 400));
      if (entry.elastic != null && !mongoose.Types.ObjectId.isValid(entry.elastic))
        return next(new ErrorHandler(`Invalid elastic id "${entry.elastic}" for head ${entry.head}.`, 400));
    }

    const headNums = elastics.map(e => e.head);
    if (new Set(headNums).size !== headNums.length)
      return next(new ErrorHandler('Duplicate head numbers found.', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found.', 404));
    if (!['weaving', 'preparatory'].includes(job.status))
      return next(new ErrorHandler(`Machine can only be assigned while job is preparatory or weaving (current: "${job.status}").`, 400));

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler('Machine not found.', 404));
    const ownedByThisJob = machine.orderRunning?.toString() === job._id.toString();
    if (machine.status !== 'free' && !ownedByThisJob)
      return next(new ErrorHandler(`Machine "${machine.ID}" is currently ${machine.status} on another job.`, 400));
    // The plan may run fewer heads than the loom has, never more.
    if (elastics.length > machine.NoOfHead)
      return next(new ErrorHandler(`${machine.ID} has ${machine.NoOfHead} heads; got ${elastics.length} head entries.`, 400));

    const sortedHeads = [...headNums].sort((a, b) => a - b);
    for (let i = 0; i < sortedHeads.length; i++) {
      if (sortedHeads[i] !== i + 1)
        return next(new ErrorHandler(`Head numbers must run 1 to ${elastics.length} without gaps.`, 400));
    }

    const jobElasticIds = new Set(job.elastics.map(e => e.elastic.toString()));
    for (const entry of elastics) {
      if (entry.elastic != null && !jobElasticIds.has(entry.elastic.toString()))
        return next(new ErrorHandler(`Elastic "${entry.elastic}" (head ${entry.head}) is not part of this job.`, 400));
    }

    // ── Can the machine actually run what is being put on it? ────────
    // Everything above checks the SHAPE of the head map — no gaps, no
    // duplicates, the right count, every elastic on the job. None of it
    // asks whether the machine has enough hooks for the product, so a
    // 24-hook elastic went onto a 12-hook machine without a word and
    // was found out at the machine with the beam already up.
    //
    // A confirmation, not a refusal: see utils/machineFit.js.
    const fit = await checkHookFit(machine, elastics.map((e) => e.elastic));
    if (!fit.fits && req.body?.confirmHooks !== true) {
      return next(hookFitError(machine, fit, ErrorHandler));
    }

    // ── Claim the machine and link the job, in one transaction ──────
    //
    // The checks above read the machine and the job outside any
    // transaction, so on their own they prove nothing by the time the
    // write lands: two supervisors assigning the same free loom to two
    // jobs both saw "free", both saved, and the second silently took the
    // loom from under the first job, which still pointed at it. The
    // machine and the job were also two separate writes, so a failure
    // between them left a machine running a job that never heard of it.
    //
    // Now, as /plan-weaving does: the job is re-read inside the
    // transaction, the machine is claimed by a conditional update that
    // only matches while it is free (or already this job's), and every
    // link moves together or not at all.
    const headPlan = elastics.map(e => ({ head: e.head, elastic: e.elastic ? new mongoose.Types.ObjectId(e.elastic) : null }));
    const session = await mongoose.startSession();
    let held = null;
    let claimed;
    try {
      await session.withTransaction(async () => {
        held = null; // a retried transaction starts again from nothing
        const txJob = await JobOrder.findById(job._id).session(session);
        if (!txJob || !['weaving', 'preparatory'].includes(txJob.status)) {
          throw new ErrorHandler(
            `Machine can only be assigned while job is preparatory or weaving (current: "${txJob?.status ?? 'deleted'}").`, 409
          );
        }

        claimed = await Machine.findOneAndUpdate(
          {
            _id: machine._id,
            $or: [{ status: 'free' }, { status: 'running', orderRunning: txJob._id }],
          },
          { $set: { status: 'running', orderRunning: txJob._id, elastics: headPlan } },
          { new: true, session }
        );
        if (!claimed) {
          const fresh = await Machine.findById(machine._id).select('ID status').session(session).lean();
          throw new ErrorHandler(
            `Machine "${fresh?.ID ?? machine.ID}" was just taken: it is now ${fresh?.status ?? 'gone'} on another job.`, 409
          );
        }

        // Let go of any other machine still standing on this job, by the
        // machine's own claim (orderRunning), whichever side of the link
        // survived. Scoped to this job and to `running`, so someone
        // else's machine and a machine in maintenance are untouched.
        await Machine.updateMany(
          { _id: { $ne: claimed._id }, orderRunning: txJob._id, status: 'running' },
          { $set: { status: 'free', orderRunning: null, elastics: [] } },
          { session }
        );
        // The mirror-image stray: the job points at a machine that no
        // longer claims it.
        if (txJob.machine && txJob.machine.toString() !== claimed._id.toString()) {
          await Machine.updateOne(
            // $eq and $ne on the one field: two `_id` keys in an object
            // literal is not a conjunction, the second silently replaces
            // the first.
            { _id: { $eq: txJob.machine, $ne: claimed._id }, status: { $ne: 'maintenance' } },
            { $set: { status: 'free', orderRunning: null, elastics: [] } },
            { session }
          );
        }

        // Assigning a machine reserves capacity; it does not make the job
        // prepared. The status only moves once warping and covering are
        // both completed, the same rule /update-status enforces. Read
        // inside the transaction so an in-flight completion is visible.
        if (txJob.status === 'preparatory') {
          const readiness = await checkWeavingReadiness(txJob._id, session);
          held = readiness.ready ? null : readiness.blockers;

          if (readiness.ready) {
            txJob.status = 'weaving';
            stampStage(txJob, 'weaving', req.user?._id);
            // 🪪 Fingerprint: JOB_STAGE_UPDATED (preparatory → weaving)
            stampFingerprint(txJob, ACTION_CODES.JOB_STAGE_UPDATED, {
              req,
              meta: {
                previousStage: 'preparatory',
                newStage:      'weaving',
                jobOrderNo:    txJob.jobOrderNo,
                machineId:     claimed._id.toString(),
                machineName:   claimed.ID,
              },
            });
          }
        }
        await setMachineLoading(claimed._id, loadingAfter(req, claimed, txJob.machine?.toString() ?? null), { session });
        txJob.machine = claimed._id;
        await txJob.save({ session });
        job.status = txJob.status;
      });
    } finally {
      await session.endSession();
    }

    const populatedMachine = await Machine.findById(machine._id).populate('elastics.elastic', 'name').lean();
    return res.status(200).json({
      success: true,
      message: held
        ? `Machine "${machine.ID}" assigned. The job stays in preparatory — ${held.join('; ')}.`
        : `Machine "${machine.ID}" assigned with ${elastics.length}-head plan.`,
      weavingHeld: held ? { blockers: held } : null,
      data: {
        jobId: job._id, jobStatus: job.status, machineId: machine._id, machineID: machine.ID, NoOfHead: machine.NoOfHead,
        headPlan: (populatedMachine.elastics || []).map(e => ({ head: e.head, elasticId: e.elastic?._id, elasticName: e.elastic?.name ?? '-' })),
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  12. FREE MACHINES
// ─────────────────────────────────────────────────────────────
router.get(
  '/free-machines',
  catchAsyncErrors(async (_req, res) => {
    const machines = await Machine.find({ status: 'free' }).select('ID manufacturer NoOfHead NoOfHooks').lean();
    return res.status(200).json({
      success: true, count: machines.length,
      machines: machines.map(m => ({ id: m._id, machineID: m.ID, manufacturer: m.manufacturer ?? '', noOfHead: m.NoOfHead, noOfHooks: m.NoOfHooks })),
    });
  })
);

module.exports = router;

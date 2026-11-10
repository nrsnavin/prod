'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — RAISE A JOB, THE LISTS, ITS DETAIL, PLAN WEAVING  (part of /api/v2/job)
//
//    POST  /create
//    GET   /jobs
//    GET   /
//    GET   /detail
//    GET   /weaving-readiness
//    POST  /plan-weaving
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const { sendError } = require('../utils/routeError');
const JobOrder    = require('../models/JobOrder');
const Machine     = require('../models/Machine');
const { refreshOpenShiftHeads } = require('../utils/machineHeads');
const { setMachineLoading } = require('../services/machineLoading');
const { stampFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');
const { checkWeavingReadiness } = require('../services/weavingReadiness');
// Job status flow, transition rules, per-stage timestamps and the
// stampStage helper all live in domain/jobStatus.js — the single
// source of truth (was previously re-encoded three times in this file).
const { JOB_STATUSES, stampStage } = require('../domain/jobStatus');
const { raiseJob } = require('../services/jobRaise');
const { checkHookFit, hookFitError } = require('../utils/machineFit');
const { loadingAfter } = require("./jobShared");
const router = express.Router();

function fullJobPopulate(query) {
  return query
    .populate('order',    'orderNo po status')
    .populate('customer', 'name phone')
    .populate('machine',  'ID manufacturer NoOfHeads status')
    .populate('createdBy', 'name role')
    .populate('updatedBy', 'name role')
    .populate('weavingBy',   'name role')
    .populate('finishingBy', 'name role')
    .populate('checkingBy',  'name role')
    .populate('packingBy',   'name role')
    .populate('completedBy', 'name role')
    .populate('cancelledBy', 'name role')
    .populate('elastics.elastic',        'name')
    .populate('producedElastic.elastic', 'name')
    .populate('packedElastic.elastic',   'name')
    .populate('wastageElastic.elastic',  'name')
    .populate({
      path:    'warping',
      select:  'status date completedDate elasticOrdered warpingPlan',
      populate: { path: 'elasticOrdered.elastic', select: 'name' },
    })
    .populate({
      path:    'covering',
      select:  'status date completedDate elasticPlanned',
      populate: { path: 'elasticPlanned.elastic', select: 'name' },
    })
    .populate({
      path:    'shiftDetails',
      populate: { path: 'employee', select: 'name department' },
    })
    .populate({
      path:    'wastages',
      populate: [
        { path: 'elastic',  select: 'name' },
        { path: 'employee', select: 'name' },
      ],
    })
    .populate({
      path:    'packingDetails',
      populate: [
        { path: 'elastic',   select: 'name' },
        { path: 'packedBy',  select: 'name' },
        { path: 'checkedBy', select: 'name' },
      ],
    });
}

// ─────────────────────────────────────────────────────────────
//  1. CREATE JOB ORDER
// ─────────────────────────────────────────────────────────────
router.post(
  '/create',
  catchAsyncErrors(async (req, res, next) => {
    // The rules live in services/jobRaise.js; this parses and answers.
    const { job, warping, covering, jobFp } = await raiseJob(req.body, {
      actor: actorFromRequest(req),
      userId: req.user?._id,
    });

    res.status(201).json({
      success: true,
      message: 'Job Order created with Warping & Covering programmes',
      data: {
        job:      { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
        warping:  { _id: warping._id,  status: warping.status  },
        covering: { _id: covering._id, status: covering.status },
      },
      fingerprint: jobFp,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  2. LIST JOBS
// ─────────────────────────────────────────────────────────────
router.get(
  '/jobs',
  catchAsyncErrors(async (req, res, next) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip  = (page - 1) * limit;
    const { status, search, customer } = req.query;
    const filter = {};
    if (status && status !== 'all') {
      if (!JOB_STATUSES.includes(status))
        return next(new ErrorHandler(`Invalid status "${status}"`, 400));
      filter.status = status;
    }
    // Narrow to one customer's jobs. Added for the complaint form, which
    // has to pick the job a specific customer received — `search` only
    // matches a job number, and filtering the page client-side would
    // silently hide every job outside the newest twenty.
    if (customer) {
      if (!mongoose.Types.ObjectId.isValid(customer)) {
        return next(new ErrorHandler('Invalid customer id', 400));
      }
      filter.customer = customer;
    }
    if (search) {
      const n = Number(search);
      if (!isNaN(n) && Number.isInteger(n)) filter.jobOrderNo = n;
    }
    const [jobs, total] = await Promise.all([
      JobOrder.find(filter)
        .populate('customer', 'name')
        .populate('machine',  'ID status')
        .populate('createdBy', 'name role')
        // The order it serves and its metres (planned, made, packed), so
        // the list can show how far along each job is and how long its
        // order has left. Added fields only: older callers read the rest.
        .populate('order', 'orderNo supplyDate')
        .select('jobOrderNo status date customer machine createdAt createdBy order elastics.quantity producedElastic.quantity packedElastic.quantity')
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit),
      JobOrder.countDocuments(filter),
    ]);
    res.json({
      success: true, jobs,
      pagination: { total, page, limit, pages: Math.ceil(total / limit), hasMore: skip + jobs.length < total },
    });
  })
);

router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const [jobs, total] = await Promise.all([
      JobOrder.find(filter)
        .populate('customer', 'name')
        .populate('elastics.elastic', 'name')
        .populate('createdBy', 'name role')
        .select('jobOrderNo date status customer elastics producedElastic createdBy createdAt')
        .sort({ jobOrderNo: -1 })
        .skip((+page - 1) * +limit).limit(+limit).lean(),
      JobOrder.countDocuments(filter),
    ]);
    return res.json({
      success: true, total, page: +page, pages: Math.ceil(total / +limit),
      data: jobs.map(j => ({
        id: j._id, jobOrderNo: j.jobOrderNo, jobNo: `J-${j.jobOrderNo}`,
        date: new Date(j.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        status: j.status, customerName: j.customer?.name || '-',
        totalPlanned: (j.elastics || []).reduce((s, e) => s + (e.quantity || 0), 0),
        totalProduced: (j.producedElastic || []).reduce((s, e) => s + (e.quantity || 0), 0),
        createdByName: j.createdBy?.name || null,
        createdByRole: j.createdBy?.role || null,
      })),
    });
  } catch (err) {
    console.error('[GET /jobs]', err);
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
//  3. GET JOB DETAIL
// ─────────────────────────────────────────────────────────────
router.get(
  '/detail',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler('Job ID is required', 400));
    const job = await fullJobPopulate(JobOrder.findById(id));
    if (!job) return next(new ErrorHandler('Job not found', 404));

    // 🪪 Surface a sorted fingerprint feed alongside the raw job
    const fingerprints = (job.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ success: true, job, fingerprints });
  })
);

// ─────────────────────────────────────────────────────────────
//  WEAVING READINESS
// ─────────────────────────────────────────────────────────────
router.get(
  '/weaving-readiness',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler('Job ID is required', 400));
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return next(new ErrorHandler('Invalid job id', 400));
    }
    const job = await JobOrder.findById(id).select('status machine jobOrderNo');
    if (!job) return next(new ErrorHandler('Job not found', 404));

    // Same verdict as GET /:jobId/weaving-readiness — one rule, two
    // response shapes, because this older query-param form is kept for
    // callers that already speak it. Deriving both from the service is
    // what stops them drifting into disagreeing about the same job.
    const readiness = await checkWeavingReadiness(id);
    const stage = (name) => readiness.stages.find((s) => s.stage === name);

    res.json({
      success: true, jobOrderNo: job.jobOrderNo, jobStatus: job.status,
      warpingStatus:  stage('warping')?.status ?? null,
      coveringStatus: stage('covering')?.status ?? null,
      warpingDone:    stage('warping')?.done ?? false,
      coveringDone:   stage('covering')?.done ?? false,
      readyForWeaving: readiness.ready,
      blockers: readiness.blockers,
      machineAssigned: !!job.machine,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  4. PLAN WEAVING
// ─────────────────────────────────────────────────────────────
router.post(
  '/plan-weaving',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId, headElasticMap } = req.body;
    if (!jobId)     return next(new ErrorHandler('jobId is required', 400));
    if (!machineId) return next(new ErrorHandler('machineId is required', 400));
    if (!headElasticMap || !Object.keys(headElasticMap).length)
      return next(new ErrorHandler('headElasticMap must be a non-empty object', 400));
    // A head with no elastic is FREE: it stays on the plan, runs nothing
    // and is counted for nothing. At least one head has to run.
    if (!Object.values(headElasticMap).some(Boolean))
      return next(new ErrorHandler('At least one head must run an elastic; the rest can be free.', 400));

    // `let`: re-read inside the transaction below, which is the copy that
    // is judged and written. This one only fails fast on the common case.
    let job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));
    if (!['preparatory', 'weaving'].includes(job.status))
      return next(new ErrorHandler(`Job must be preparatory or weaving (current: "${job.status}")`, 400));
    // A running job CAN be moved to another machine. It used to be
    // refused outright, which meant a breakdown mid-run had no answer
    // inside the system: the job had to be walked back a stage before
    // it could be put on a working machine.
    //
    // Safe to allow because the old machine is released inside the same
    // transaction as the new claim (below) — the refusal was standing in
    // for a release that did not exist.
    // ── Can the machine actually run what is being put on it? ────────
    // Before the transaction, so the caller gets a clean 409 it can act
    // on rather than a claimed machine and an aborted write. The same
    // check guards /assign-machine — both routes reach the same head
    // map, and a rule enforced on one of them is not a rule.
    const machineForFit = await Machine.findById(machineId).select('ID NoOfHooks NoOfHead');
    if (!machineForFit) return next(new ErrorHandler('Machine not found', 404));
    // Heads in use: the plan may run fewer heads than the loom has (a wide
    // elastic that fits on 6 of 8), but never more, and from head 1 up.
    const headKeys = Object.keys(headElasticMap).map(Number).sort((a, b) => a - b);
    if (headKeys.some((k, i) => !Number.isInteger(k) || k !== i)) {
      return next(new ErrorHandler('Heads must run from head 1 up, without gaps.', 400));
    }
    if (headKeys.length > (Number(machineForFit.NoOfHead) || 0)) {
      return next(new ErrorHandler(
        `${machineForFit.ID} has ${machineForFit.NoOfHead} heads; the plan uses ${headKeys.length}.`, 400
      ));
    }
    const fit = await checkHookFit(machineForFit, Object.values(headElasticMap));
    if (!fit.fits && req.body?.confirmHooks !== true) {
      return next(hookFitError(machineForFit, fit, ErrorHandler));
    }

    let movingWhileRunning =
      job.status === 'weaving' &&
      job.machine &&
      job.machine.toString() !== String(machineId);
    let previousMachineId = job.machine ? job.machine.toString() : null;

    // Machine claim + job status flip must be atomic. Without a
    // transaction two concurrent /plan-weaving requests could both
    // see machine.status === 'free' and both claim it, leaving the
    // loser with a half-applied job state.
    const session = await mongoose.startSession();
    let machine;
    // Blockers that kept the job in preparatory, or null if it advanced.
    let held = null;
    try {
      await session.withTransaction(async () => {
        // The job as it is now, not as it was before the transaction: a
        // job cancelled meanwhile must not be flipped back to weaving,
        // and a retried attempt must not stamp its audit entries twice
        // on a copy it already changed.
        held = null;
        job = await JobOrder.findById(jobId).session(session);
        if (!job) throw new ErrorHandler('Job not found', 404);
        if (!['preparatory', 'weaving'].includes(job.status)) {
          throw new ErrorHandler(`Job must be preparatory or weaving (current: "${job.status}")`, 409);
        }
        movingWhileRunning =
          job.status === 'weaving' && job.machine && job.machine.toString() !== String(machineId);
        previousMachineId = job.machine ? job.machine.toString() : null;

        // Atomic claim: only flip free → running, so the second
        // racing request gets null and bails cleanly.
        // Claim only a free machine, OR the one this job is already on —
        // re-picking the same machine is a head-plan edit, and failing it
        // with "not free" would be the system objecting to its own state.
        machine = await Machine.findOneAndUpdate(
          {
            _id: machineId,
            $or: [
              { status: 'free' },
              { status: 'running', orderRunning: job._id },
            ],
          },
          {
            $set: {
              status:       'running',
              orderRunning: job._id,
              elastics:     Object.entries(headElasticMap).map(
                ([head, elastic]) => ({ head: Number(head) + 1, elastic: elastic || null })
              ),
            },
          },
          { new: true, session }
        );
        if (!machine) {
          // Disambiguate the failure for the caller.
          const fresh = await Machine.findById(machineId).session(session);
          if (!fresh) throw new ErrorHandler('Machine not found', 404);
          throw new ErrorHandler(
            `Machine is not free (current: "${fresh.status}")`, 400
          );
        }

        // ── Let go of whatever this job was already on ───────────────
        // This route claimed the new machine and released nothing, so
        // moving a job to another machine left the first one stuck on
        // "running" for a job it was no longer part of — unavailable to
        // everything else, for good. It is the route the machine picker
        // actually calls, which is why the release on /assign-machine
        // never covered this.
        //
        // Released by `orderRunning` — the machine's own claim — so a
        // machine holding the job is let go whichever side of the link
        // survived. Scoped to this job, so someone else's running
        // machine is untouched, and to `running`, so a machine in
        // maintenance is not put back in the picker.
        //
        // Deliberately after the claim and inside the same transaction:
        // if the machine being asked for turns out not to be free, the
        // whole thing rolls back and the job stays on the machine it was
        // already running. Releasing first would strand the job on
        // nothing.
        await Machine.updateMany(
          { _id: { $ne: machine._id }, orderRunning: job._id, status: 'running' },
          { $set: { status: 'free', orderRunning: null, elastics: [] } },
          { session }
        );
        if (job.machine && job.machine.toString() !== machine._id.toString()) {
          // The mirror-image stray: the job points at a machine that no
          // longer claims it.
          await Machine.updateOne(
            { _id: { $eq: job.machine, $ne: machine._id }, status: { $ne: 'maintenance' } },
            { $set: { status: 'free', orderRunning: null, elastics: [] } },
            { session }
          );
        }

        // Planning a machine is not the same as being prepared. A job
        // only becomes weaving once its warping and covering are both
        // completed — the same rule /update-status enforces. Read inside
        // the transaction so an in-flight completion is visible.
        if (job.status === 'preparatory') {
          const readiness = await checkWeavingReadiness(job._id, session);
          held = readiness.ready ? null : readiness.blockers;

          if (readiness.ready) {
            job.status = 'weaving';
            stampStage(job, 'weaving', req.user?._id);
            stampFingerprint(job, ACTION_CODES.JOB_STAGE_UPDATED, {
              req,
              meta:     {
                previousStage: 'preparatory',
                newStage:      'weaving',
                jobOrderNo:    job.jobOrderNo,
                machineId:     machine._id.toString(),
                machineName:   machine.ID,
              },
            });
          }
        }
        // A machine changed under a running job is a production event
        // in its own right — no stage moved, so nothing else would have
        // recorded it. Names both machines, because "which one was it on
        // before" is the question asked afterwards.
        if (movingWhileRunning) {
          stampFingerprint(job, ACTION_CODES.JOB_MACHINE_CHANGED, {
            req,
            meta: {
              jobOrderNo:      job.jobOrderNo,
              fromMachineId:   previousMachineId,
              toMachineId:     machine._id.toString(),
              toMachineName:   machine.ID,
            },
          });
        }

        // Re-planning the heads of the machine this job is already on:
        // its shifts not yet verified take the new head plan, so they are
        // verified and corrected against the heads that actually run.
        if (previousMachineId === machine._id.toString()) {
          await refreshOpenShiftHeads(machine, job._id, session);
        }

        // Loading: a loom just given a job is loaded before it weaves,
        // and those shifts count for nothing (services/machineLoading.js).
        // Asked for explicitly; otherwise a new machine starts weaving
        // and a re-plan of the same machine keeps what it was.
        await setMachineLoading(machine._id, loadingAfter(req, machine, previousMachineId), { session });

        job.machine = machine._id;
        await job.save({ session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      // The plan is saved and the machine is claimed either way — what
      // is withheld is only the status. Saying so plainly beats a
      // message that claims a move which did not happen; the job
      // advances on its own the moment preparation finishes.
      message: held
        ? `Weaving plan saved. The job stays in preparatory — ${held.join('; ')}.`
        : 'Weaving plan saved. Job is now in weaving.',
      weavingHeld: held ? { blockers: held } : null,
      data: {
        job:     { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
        machine: { _id: machine._id, ID: machine.ID, status: machine.status },
      },
    });
  })
);

module.exports = router;

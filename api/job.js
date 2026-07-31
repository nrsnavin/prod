'use strict';

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const { isAuthenticated } = require('../middleware/auth');

const JobOrder    = require('../models/JobOrder');
const Order       = require('../models/Order');
const Warping     = require('../models/Warping');
const Covering    = require('../models/Covering');
const Wastage     = require('../models/Wastage');
const Machine     = require('../models/Machine');
const { recomputePending } = require('../services/orderPending.js');
const ShiftDetail = require('../models/ShiftDetail');
const WarpingBatch = require('../models/WarpingBatch');

const { buildFingerprint, stampFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { buildMrpPdf } = require('../utils/mrpPdf');
const { getPdfBranding } = require('../services/documentSettings.js');

// Every job route requires a logged-in user. The previous setup left
// the whole router anonymous, including the alternate `/:jobId`
// detail at the bottom of the file and the machine-assign / stage-
// transition mutations.
router.use(isAuthenticated);

// Job status flow, transition rules, per-stage timestamps and the
// stampStage helper all live in domain/jobStatus.js — the single
// source of truth (was previously re-encoded three times in this file).
const {
  JOB_STATUSES,
  validateTransition,
  stampStage,
  enteredAtField,
} = require('../domain/jobStatus');

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

async function releaseMachine(machineId) {
  if (!machineId) return;
  const machine = await Machine.findById(machineId);
  if (!machine) return;
  machine.status       = 'free';
  machine.orderRunning = null;
  await machine.save();
}

// ─────────────────────────────────────────────────────────────
//  1. CREATE JOB ORDER
// ─────────────────────────────────────────────────────────────
router.post(
  '/create',
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, date, elastics } = req.body;
    if (!orderId) return next(new ErrorHandler('orderId is required', 400));
    if (!date)    return next(new ErrorHandler('date is required', 400));
    if (!Array.isArray(elastics) || elastics.length === 0)
      return next(new ErrorHandler('elastics array must not be empty', 400));

    for (const e of elastics) {
      if (!e.elastic) return next(new ErrorHandler('Each elastic entry must have an elastic ID', 400));
      if (typeof e.quantity !== 'number' || e.quantity <= 0)
        return next(new ErrorHandler('Each elastic quantity must be a positive number', 400));
    }

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler('Order not found', 404));
    if (!['Open', 'InProgress'].includes(order.status))
      return next(new ErrorHandler(`Cannot create job for order with status "${order.status}"`, 400));

    for (const e of elastics) {
      const pending = order.pendingElastic.find(p => p.elastic.toString() === e.elastic.toString());
      if (!pending) return next(new ErrorHandler(`Elastic ${e.elastic} is not part of this order`, 400));
      if (pending.quantity < e.quantity)
        return next(new ErrorHandler(`Requested quantity (${e.quantity}) exceeds pending (${pending.quantity})`, 400));
    }

    const zeroed = elastics.map(e => ({ elastic: e.elastic, quantity: 0 }));
    const job = await JobOrder.create({
      date: new Date(date), order: order._id, customer: order.customer,
      status: 'preparatory', elastics,
      producedElastic: zeroed, packedElastic: zeroed, wastageElastic: zeroed,
    });

    const [warping, covering] = await Promise.all([
      Warping.create({ date: new Date(), job: job._id, elasticOrdered: elastics }),
      Covering.create({ date: new Date(), job: job._id, elasticPlanned: elastics }),
    ]);

    job.warping  = warping._id;
    job.covering = covering._id;

    // 🪪 Fingerprint: JOB_CREATED on the job itself
    const actor = actorFromRequest(req);
    const jobFp = buildFingerprint(ACTION_CODES.JOB_CREATED, {
      entityId: job._id,
      actor,
      meta: {
        orderId:       order._id.toString(),
        orderNo:       order.orderNo,
        jobOrderNo:    job.jobOrderNo,
        elasticCount:  elastics.length,
        totalQuantity: elastics.reduce((s, e) => s + (e.quantity || 0), 0),
      },
    });
    job.fingerprints.push(jobFp);
    await job.save();

    order.jobs.push({ job: job._id, no: job.jobOrderNo });
    // Pending = ordered − planned, recomputed from the order's live jobs
    // (now including the one just created) rather than decremented in
    // place, so every path agrees and a re-run can't double-count.
    await recomputePending(order);
    order.status = 'InProgress';

    // 🪪 Mirror fingerprint on the parent Order so the order timeline
    //    also shows that a job was spun off.
    stampFingerprint(order, ACTION_CODES.JOB_CREATED, {
      actor,
      meta: {
        jobId:          job._id.toString(),
        jobOrderNo:     job.jobOrderNo,
        elasticCount:   elastics.length,
        relatedHash:    jobFp.hash,
        relatedShortId: jobFp.shortId,
      },
    });
    await order.save();

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
    const { status, search } = req.query;
    const filter = {};
    if (status && status !== 'all') {
      if (!JOB_STATUSES.includes(status))
        return next(new ErrorHandler(`Invalid status "${status}"`, 400));
      filter.status = status;
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
        .select('jobOrderNo status date customer machine createdAt createdBy')
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
    const job = await JobOrder.findById(id)
      .populate('warping',  'status completedDate')
      .populate('covering', 'status completedDate')
      .select('status machine warping covering jobOrderNo');
    if (!job) return next(new ErrorHandler('Job not found', 404));
    const warpingDone  = job.warping?.status  === 'completed';
    const coveringDone = job.covering?.status === 'completed';
    res.json({
      success: true, jobOrderNo: job.jobOrderNo, jobStatus: job.status,
      warpingStatus: job.warping?.status ?? null, coveringStatus: job.covering?.status ?? null,
      warpingDone, coveringDone,
      readyForWeaving: warpingDone && coveringDone,
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
    if (Object.values(headElasticMap).some(v => !v))
      return next(new ErrorHandler('All machine heads must have an elastic assigned', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));
    if (!['preparatory', 'weaving'].includes(job.status))
      return next(new ErrorHandler(`Job must be preparatory or weaving (current: "${job.status}")`, 400));
    if (job.status === 'weaving' && job.machine)
      return next(new ErrorHandler('Job already has a machine assigned.', 400));

    // Machine claim + job status flip must be atomic. Without a
    // transaction two concurrent /plan-weaving requests could both
    // see machine.status === 'free' and both claim it, leaving the
    // loser with a half-applied job state.
    const session = await mongoose.startSession();
    let machine;
    try {
      await session.withTransaction(async () => {
        // Atomic claim: only flip free → running, so the second
        // racing request gets null and bails cleanly.
        machine = await Machine.findOneAndUpdate(
          { _id: machineId, status: 'free' },
          {
            $set: {
              status:       'running',
              orderRunning: job._id,
              elastics:     Object.entries(headElasticMap).map(
                ([head, elastic]) => ({ head: Number(head) + 1, elastic })
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

        if (job.status === 'preparatory') {
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
        job.machine = machine._id;
        await job.save({ session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      message: 'Weaving plan saved. Job is now in weaving.',
      data: {
        job:     { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
        machine: { _id: machine._id, ID: machine.ID, status: machine.status },
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  5. UPDATE JOB STATUS
// ─────────────────────────────────────────────────────────────
router.post(
  '/update-status',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, nextStatus } = req.body;
    if (!jobId)      return next(new ErrorHandler('jobId is required', 400));
    if (!nextStatus) return next(new ErrorHandler('nextStatus is required', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));

    const check = validateTransition(job.status, nextStatus);
    if (!check.ok) return next(new ErrorHandler(check.message, 400));

    if (nextStatus === 'finishing') {
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    const previousStage = job.status;
    const actor = actorFromRequest(req);

    // 🪪 Stage update fingerprint (every transition)
    const stageFp = buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
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

    let completionFp = null;
    if (nextStatus === 'completed') {
      const siblingJobs = await JobOrder.find({ order: job.order, _id: { $ne: job._id } }).select('status');
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

      if (allDone) {
        const order = await Order.findById(job.order);
        if (order) {
          order.status      = 'Completed';
          order.completedBy = req.user?._id || null;
          order.completedAt = new Date();
          stampFingerprint(order, ACTION_CODES.ORDER_COMPLETED, {
            actor,
            meta: {
              previousStatus:  'InProgress',
              newStatus:       'Completed',
              triggeredByJob:  job._id.toString(),
              triggerJobNo:    job.jobOrderNo,
              relatedHash:     completionFp.hash,
              relatedShortId:  completionFp.shortId,
            },
          });
          await order.save();
        }
      }
    }

    stampStage(job, nextStatus, req.user?._id);
    job.status = nextStatus;
    await job.save();

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
//  6. CANCEL JOB
// ─────────────────────────────────────────────────────────────
router.post(
  '/cancel',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, reason } = req.body;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));
    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));
    if (job.status === 'cancelled') return next(new ErrorHandler('Job is already cancelled', 400));
    if (job.status === 'completed') return next(new ErrorHandler('A completed job cannot be cancelled', 400));

    if (job.status === 'weaving' && job.machine) {
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    const previousStatus = job.status;
    stampStage(job, 'cancelled', req.user?._id);
    job.status = 'cancelled';
    if (reason) job.cancelReason = reason;

    // 🪪 Fingerprint: JOB_CANCELLED
    const fp = buildFingerprint(ACTION_CODES.JOB_CANCELLED, {
      entityId: job._id,
      actor:    actorFromRequest(req),
      meta: {
        previousStatus,
        reason:     reason || null,
        jobOrderNo: job.jobOrderNo,
      },
    });
    job.fingerprints.push(fp);
    await job.save();

    // Only now that the job is actually marked 'cancelled' does its planned
    // quantity return to pending — recompute AFTER the save, or the job
    // would still be counted as holding the quantity.
    const order = await Order.findById(job.order);
    if (order) {
      await recomputePending(order);
      const remainingJobs = await JobOrder.countDocuments({
        order: job.order, _id: { $ne: job._id }, status: { $nin: ['cancelled', 'completed'] },
      });
      if (remainingJobs === 0) order.status = 'Approved';
      await order.save();
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
    const summary = job.elastics.map(e => {
      const find = arr => arr.find(x => x.elastic._id.toString() === e.elastic._id.toString())?.quantity || 0;
      const planned  = e.quantity;
      const produced = find(job.producedElastic);
      const packed   = find(job.packedElastic);
      const wasted   = find(job.wastageElastic);
      return { elasticId: e.elastic._id, elasticName: e.elastic.name, planned, produced, packed, wasted, remaining: Math.max(0, planned - produced - wasted), packingPct: planned > 0 ? Math.round((packed / planned) * 100) : 0 };
    });
    res.json({ success: true, jobId: job._id, jobNo: job.jobOrderNo, status: job.status, summary });
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
    if (elastics.length !== machine.NoOfHead)
      return next(new ErrorHandler(`Expected ${machine.NoOfHead} head entries, got ${elastics.length}.`, 400));

    const sortedHeads = [...headNums].sort((a, b) => a - b);
    for (let i = 0; i < sortedHeads.length; i++) {
      if (sortedHeads[i] !== i + 1)
        return next(new ErrorHandler(`Head numbers must run 1 to ${machine.NoOfHead} without gaps.`, 400));
    }

    const jobElasticIds = new Set(job.elastics.map(e => e.elastic.toString()));
    for (const entry of elastics) {
      if (entry.elastic != null && !jobElasticIds.has(entry.elastic.toString()))
        return next(new ErrorHandler(`Elastic "${entry.elastic}" (head ${entry.head}) is not part of this job.`, 400));
    }

    if (job.machine && job.machine.toString() !== machineId.toString()) {
      const oldMachine = await Machine.findById(job.machine);
      if (oldMachine) { oldMachine.status = 'free'; oldMachine.orderRunning = null; oldMachine.elastics = []; await oldMachine.save(); }
    }

    machine.elastics     = elastics.map(e => ({ head: e.head, elastic: e.elastic ? new mongoose.Types.ObjectId(e.elastic) : null }));
    machine.status       = 'running';
    machine.orderRunning = job._id;
    await machine.save();

    if (job.status === 'preparatory') {
      job.status = 'weaving';
      stampStage(job, 'weaving', req.user?._id);
      // 🪪 Fingerprint: JOB_STAGE_UPDATED (preparatory → weaving)
      stampFingerprint(job, ACTION_CODES.JOB_STAGE_UPDATED, {
        req,
        meta: {
          previousStage: 'preparatory',
          newStage:      'weaving',
          jobOrderNo:    job.jobOrderNo,
          machineId:     machine._id.toString(),
          machineName:   machine.ID,
        },
      });
    }
    job.machine = machine._id;
    await job.save();

    const populatedMachine = await Machine.findById(machine._id).populate('elastics.elastic', 'name').lean();
    return res.status(200).json({
      success: true,
      message: `Machine "${machine.ID}" assigned with ${machine.NoOfHead}-head plan.`,
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

// ─────────────────────────────────────────────────────────────
//  13. JOB DETAIL (alternate — used by Flutter /:jobId)
// ─────────────────────────────────────────────────────────────
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId)
      .populate('customer', 'name phone')
      .populate('order',    'orderNo status')
      .populate('machine',  'ID manufacturer NoOfHead NoOfHooks status')
      .populate('createdBy',   'name role')
      .populate('updatedBy',   'name role')
      .populate('weavingBy',   'name role')
      .populate('finishingBy', 'name role')
      .populate('checkingBy',  'name role')
      .populate('packingBy',   'name role')
      .populate('completedBy', 'name role')
      .populate('cancelledBy', 'name role')
      .populate('elastics.elastic',        'name weaveType weight')
      .populate('producedElastic.elastic', 'name')
      .populate('packedElastic.elastic',   'name')
      .populate('wastageElastic.elastic',  'name')
      .populate({
        path: 'warping',
        populate: { path: 'warpingPlan', populate: { path: 'beams.sections.warpYarn', model: 'RawMaterial', select: 'name unit' } },
      })
      .populate({ path: 'covering', populate: { path: 'elasticPlanned.elastic', select: 'name' } })
      .populate({
        path: 'shiftDetails', model: 'ShiftDetail',
        populate: [
          { path: 'machine',  model: 'Machine',  select: 'ID NoOfHead status' },
          { path: 'employee', model: 'Employee', select: 'name department' },
          { path: 'elastics.elastic', model: 'Elastic', select: 'name weaveType' },
        ],
      })
      .populate({ path: 'wastages', model: 'Wastage', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'employee', model: 'Employee', select: 'name' }] })
      .populate({ path: 'packingDetails', model: 'Packing', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'checkedBy', model: 'Employee', select: 'name' }, { path: 'packedBy', model: 'Employee', select: 'name' }] })
      .lean();

    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
    const mapElasticQty = arr => (arr || []).map(e => ({ elasticId: e.elastic?._id || null, elasticName: e.elastic?.name || 'Unknown', quantity: e.quantity || 0 }));
    const fpUser = u => u ? { name: u.name, role: u.role } : null;

    const w = job.warping; const wp = w?.warpingPlan;
    const warping = w ? {
      status: w.status || 'open', date: fmtDate(w.date), completedDate: fmtDate(w.completedDate),
      noOfBeams: wp?.noOfBeams || 0, remarks: wp?.remarks || '',
      beams: (wp?.beams || []).map(b => ({ beamNo: b.beamNo, totalEnds: b.totalEnds, sections: (b.sections || []).map((s, i) => ({ sectionNo: i + 1, yarnName: s.warpYarn?.name || 'Unknown', yarnUnit: s.warpYarn?.unit || '', ends: s.ends || 0 })) })),
    } : null;

    const co = job.covering;
    const covering = co ? { status: co.status || 'open', date: fmtDate(co.date), completedDate: fmtDate(co.completedDate), remarks: co.remarks || '', elasticPlanned: mapElasticQty(co.elasticPlanned) } : null;

    const shiftDetails = (job.shiftDetails || []).sort((a, b) => new Date(a.date) - new Date(b.date)).map(d => ({
      id: d._id, date: fmtDate(d.date), shift: d.shift, status: d.status, timer: d.timer || '00:00:00',
      productionMeters: d.productionMeters || 0, machineName: d.machine?.ID || '-', machineNoOfHead: d.machine?.NoOfHead || 0,
      operatorName: d.employee?.name || '-', operatorDept: d.employee?.department || '',
      elastics: (d.elastics || []).map(he => ({ head: he.head, elasticName: he.elastic?.name || '-' })),
      description: d.description || '', feedback: d.feedback || '',
    }));

    const wastages = (job.wastages || []).map(wst => ({ id: wst._id, elasticName: wst.elastic?.name || '-', employeeName: wst.employee?.name || '-', quantity: wst.quantity || 0, penalty: wst.penalty || 0, reason: wst.reason || '', date: fmtDate(wst.createdAt) }));
    const packingDetails = (job.packingDetails || []).map(pk => ({ id: pk._id, elasticName: pk.elastic?.name || '-', quantity: pk.quantity || 0, rolls: pk.rolls || 0, metersPerRoll: pk.metersPerRoll || 0, total: pk.total || 0, batch: pk.batch || '-', status: pk.status || 'open', date: fmtDate(pk.createdAt) }));

    // 🪪 Newest-first fingerprint feed for the timeline UI
    const fingerprints = (job.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .map(f => ({
        code:    f.code,
        label:   f.label,
        hash:    f.hash,
        shortId: f.shortId,
        at:      f.at,
        actor:   f.actor || { id: 'system', name: 'System', role: 'system' },
        meta:    f.meta  || {},
      }));

    return res.json({
      success: true,
      data: {
        id: job._id, jobOrderNo: job.jobOrderNo, jobNo: `J-${job.jobOrderNo}`,
        date: fmtDate(job.date), status: job.status,
        customerName: job.customer?.name || '-', customerPhone: job.customer?.phone || '',
        orderNo: job.order?.orderNo || '',
        machine: job.machine ? { machineId: job.machine._id, machineName: job.machine.ID || '-', machineNoOfHead: job.machine.NoOfHead || 0, manufacturer: job.machine.manufacturer || '', status: job.machine.status || 'free' } : null,
        plannedElastics: mapElasticQty(job.elastics),
        producedElastics: mapElasticQty(job.producedElastic),
        packedElastics: mapElasticQty(job.packedElastic),
        wastageElastics: mapElasticQty(job.wastageElastic),
        warping, covering, shiftDetails, wastages, packingDetails,
        // ── Per-stage audit pointers ──
        createdBy:   fpUser(job.createdBy),
        createdAt:   job.createdAt || null,
        updatedBy:   fpUser(job.updatedBy),
        updatedAt:   job.updatedAt || null,
        weavingBy:   fpUser(job.weavingBy),
        weavingAt:   job.weavingAt   || null,
        finishingBy: fpUser(job.finishingBy),
        finishingAt: job.finishingAt || null,
        checkingBy:  fpUser(job.checkingBy),
        checkingAt:  job.checkingAt  || null,
        packingBy:   fpUser(job.packingBy),
        packingAt:   job.packingAt   || null,
        completedBy: fpUser(job.completedBy),
        completedAt: job.completedAt || null,
        cancelledBy: fpUser(job.cancelledBy),
        cancelledAt: job.cancelledAt || null,
        // 🪪 Full audit timeline (newest-first)
        fingerprints,
      },
    });
  } catch (err) {
    console.error('[GET /jobs/:jobId]', err);
    // Generic message — raw err.message can leak internals (driver
    // errors, paths) to the client.
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load job detail' });
  }
});

// ════════════════════════════════════════════════════════════════
//  MATERIAL REQUIREMENT PROGRAM (MRP)
//
//  PATCH /:jobId/production-mode  — set in_house / outsource (+vendor)
//  GET   /:jobId/mrp              — computed MRP data as JSON
//  GET   /:jobId/mrp.pdf          — the MRP sheet as a PDF download
// ════════════════════════════════════════════════════════════════

// Assemble the plain MRP data object the JSON route and the PDF
// renderer both consume. Returns null if the job doesn't exist.
async function _buildMrpData(jobId) {
  const job = await JobOrder.findById(jobId)
    .populate("customer", "name")
    .populate("order",    "orderNo")
    .populate("elastics.elastic", "name")
    .lean();
  if (!job) return null;

  const materials = await computeMaterialRequirement(job.elastics || []);

  return {
    jobId:           String(job._id),
    jobOrderNo:      job.jobOrderNo,
    orderNo:         job.order?.orderNo ?? null,
    customerName:    job.customer?.name || "",
    dateLabel:       job.date
      ? new Date(job.date).toLocaleDateString("en-IN",
          { day: "2-digit", month: "short", year: "numeric" })
      : "",
    status:          job.status,
    productionMode:  job.productionMode || "in_house",
    outsourceVendor: job.outsourceVendor || "",
    elastics: (job.elastics || []).map((e) => ({
      name:     e.elastic?.name || "Unknown",
      quantity: Number(e.quantity) || 0,
    })),
    materials,
  };
}

router.patch('/:jobId/production-mode', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const mode = req.body?.productionMode;
    if (!['in_house', 'outsource'].includes(mode))
      return res.status(400).json({ success: false, message: "productionMode must be 'in_house' or 'outsource'." });

    const update = { productionMode: mode };
    // Vendor only applies to outsource; clear it when switching back.
    if (mode === 'outsource') {
      update.outsourceVendor = typeof req.body?.outsourceVendor === 'string'
        ? req.body.outsourceVendor.trim() : '';
    } else {
      update.outsourceVendor = '';
    }

    const job = await JobOrder.findByIdAndUpdate(jobId, update, { new: true })
      .select('jobOrderNo productionMode outsourceVendor');
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    return res.json({ success: true, data: {
      jobOrderNo:      job.jobOrderNo,
      productionMode:  job.productionMode,
      outsourceVendor: job.outsourceVendor,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update production mode' });
  }
});

// ════════════════════════════════════════════════════════════════
//  GET /:jobId/yarn-lots
//
//  Which dye lots went into this job, grouped by the elastic they were
//  warped for. This is the backward half of lot traceability: the
//  forward half (/yarn-lots/:id/trace) answers "where did this lot go",
//  and this one answers "what is in this roll" — the question that
//  actually gets asked, months later, when a customer reports a shade
//  band and quotes a job number off the packing list.
//
//  Batches that were never attributed to an elastic come back under a
//  separate `unattributed` group rather than being spread across every
//  elastic on the job. Attributing them everywhere would be a guess
//  wearing the costume of a fact.
// ════════════════════════════════════════════════════════════════
router.get('/:jobId/yarn-lots', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId)
      .select('jobOrderNo elastics')
      .populate('elastics.elastic', 'name')
      .lean();
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    const batches = await WarpingBatch.find({ job: jobId })
      .populate('elastics', 'name')
      .sort({ createdAt: 1 })
      .lean();

    // Cancelled batches drew nothing in the end — their yarn went back on
    // the rack — so they are not part of what is in the goods.
    const live = batches.filter((b) => b.status !== 'cancelled');

    const groups = new Map();
    const groupFor = (key, name) => {
      if (!groups.has(key)) groups.set(key, { elasticId: key === 'unattributed' ? null : key, elasticName: name, lots: [] });
      return groups.get(key);
    };
    // Seed a group per planned elastic, so an elastic with no lots
    // recorded shows as "nothing recorded" rather than vanishing.
    for (const e of job.elastics || []) {
      if (e.elastic?._id) groupFor(String(e.elastic._id), e.elastic.name || 'Unknown');
    }

    for (const b of live) {
      const targets = (b.elastics || []).length
        ? b.elastics.map((e) => ({ key: String(e._id), name: e.name || 'Unknown' }))
        : [{ key: 'unattributed', name: 'Not attributed to an elastic' }];

      for (const t of targets) {
        const g = groupFor(t.key, t.name);
        for (const a of b.allocations || []) {
          g.lots.push({
            batchId: b._id,
            batchNo: b.batchNo,
            batchStatus: b.status,
            beamNos: b.beamNos || [],
            yarnLot: a.yarnLot,
            lotNo: a.lotNo || '',
            shade: a.shade || '',
            materialName: a.materialName || '',
            // A batch covering two elastics drew its yarn once, not twice.
            // The quantity is left whole and `sharedAcross` says how many
            // elastics it is answering for, rather than silently dividing
            // a number nobody measured that way.
            quantity: a.quantity,
            sharedAcross: targets.length,
            issuedDate: b.issuedDate || null,
          });
        }
      }
    }

    const byElastic = Array.from(groups.values()).filter(
      (g) => g.elasticId !== null || g.lots.length > 0
    );

    // The flat list of distinct lots in this job — what someone chasing a
    // complaint wants first, before drilling into which beam.
    const distinct = new Map();
    for (const g of byElastic) {
      for (const l of g.lots) {
        const key = String(l.yarnLot || l.lotNo);
        if (!distinct.has(key)) {
          distinct.set(key, {
            yarnLot: l.yarnLot, lotNo: l.lotNo, shade: l.shade, materialName: l.materialName,
          });
        }
      }
    }

    return res.json({
      success: true,
      data: {
        jobId: job._id,
        jobOrderNo: job.jobOrderNo,
        byElastic,
        lots: Array.from(distinct.values()),
        // Batches exist but none say which elastic they were for — the
        // UI uses this to explain why the trail is job-wide.
        hasUnattributed: byElastic.some((g) => g.elasticId === null),
      },
    });
  } catch (err) {
    console.error('[GET /jobs/:jobId/yarn-lots]', err);
    return res.status(500).json({ success: false, message: 'Failed to load yarn lots' });
  }
});

router.get('/:jobId/mrp', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });
    const data = await _buildMrpData(jobId);
    if (!data) return res.status(404).json({ success: false, message: 'Job not found.' });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to build MRP' });
  }
});

router.get('/:jobId/mrp.pdf', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });
    const data = await _buildMrpData(jobId);
    if (!data) return res.status(404).json({ success: false, message: 'Job not found.' });

    data.branding = await getPdfBranding();
    const pdf = await buildMrpPdf(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="MRP-job-${data.jobOrderNo ?? jobId}.pdf"`
    );
    return res.send(pdf);
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to render MRP PDF' });
  }
});

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
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /stale?days=14
//  Jobs that have been sitting in the same status for more than
//  `days` days. Powers the AIAdvisor "stale jobs" card.
//
//  Each non-terminal stage records its entry timestamp on the
//  job document (weavingAt, finishingAt, checkingAt, packingAt).
//  The "entered current status at" is whichever timestamp the
//  status maps to; preparatory falls back to createdAt because no
//  preparatoryAt field exists.
// ══════════════════════════════════════════════════════════════
router.get('/stale', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 14);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const jobs = await JobOrder.find({
      status: { $nin: ['completed', 'cancelled'] },
    })
      .select('jobOrderNo status createdAt weavingAt finishingAt checkingAt packingAt customer')
      .populate('customer', 'name')
      .lean();

    const enteredAt = (j) => {
      const field = enteredAtField(j.status);
      return (field && j[field]) || j.createdAt;
    };

    const stale = jobs
      .map((j) => {
        const enteredOn = enteredAt(j);
        const idleDays  = Math.floor(
          (Date.now() - new Date(enteredOn).getTime()) / 86_400_000
        );
        return { job: j, enteredOn, idleDays };
      })
      .filter((x) => x.idleDays > days)
      .sort((a, b) => b.idleDays - a.idleDays)
      .map((x) => ({
        jobId:        x.job._id,
        jobOrderNo:   x.job.jobOrderNo,
        status:       x.job.status,
        customerName: x.job.customer?.name ?? '—',
        enteredOn:    x.enteredOn,
        idleDays:     x.idleDays,
      }));

    return res.json({
      success:   true,
      windowDays: days,
      jobs:      stale,
      count:     stale.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /wastage-outliers?lookbackDays=30&sigmaThreshold=2
//  Machines whose recent (last 7 days) wastage total is more than
//  `sigmaThreshold` standard deviations above their own trailing
//  baseline. Joins Wastage → JobOrder.machine so the per-machine
//  signal works even though Wastage rows carry only `job`.
//
//  Guard: a machine needs at least 5 wastage events in the
//  baseline window before we'll trip an alert. New machines or
//  ones with sparse data don't fire on their first dirty shift.
// ══════════════════════════════════════════════════════════════
router.get('/wastage-outliers', async (req, res) => {
  try {
    const lookback   = Math.max(7, parseInt(req.query.lookbackDays,   10) || 30);
    const threshold  = Math.max(1, parseFloat(req.query.sigmaThreshold) || 2);
    const recentDays = 7;
    const minSamples = 5;

    const now        = Date.now();
    const lookbackAt = new Date(now - lookback   * 86_400_000);
    const recentAt   = new Date(now - recentDays * 86_400_000);

    const rows = await Wastage.aggregate([
      { $match: { createdAt: { $gte: lookbackAt } } },
      { $lookup: {
          from:         'joborders',
          localField:   'job',
          foreignField: '_id',
          as:           'jo',
        } },
      { $unwind: '$jo' },
      { $match: { 'jo.machine': { $ne: null } } },
      { $project: {
          machine:   '$jo.machine',
          quantity:  1,
          createdAt: 1,
        } },
    ]);

    // Bucket per machine: trailing baseline samples + recent window total.
    const buckets = new Map();
    for (const r of rows) {
      const key = String(r.machine);
      if (!buckets.has(key)) buckets.set(key, { samples: [], recent: 0 });
      const b = buckets.get(key);
      b.samples.push(r.quantity);
      if (r.createdAt >= recentAt) b.recent += r.quantity;
    }

    const candidateIds = [];
    const meta         = new Map();
    for (const [mid, { samples, recent }] of buckets) {
      if (samples.length < minSamples) continue;
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce(
        (acc, x) => acc + (x - mean) ** 2,
        0
      ) / samples.length;
      const stddev = Math.sqrt(variance);
      if (stddev <= 0) continue;
      const ceiling = mean + threshold * stddev;
      if (recent > ceiling) {
        candidateIds.push(mid);
        meta.set(mid, {
          recentTotal: Math.round(recent * 100) / 100,
          mean:        Math.round(mean * 100)   / 100,
          stddev:      Math.round(stddev * 100) / 100,
        });
      }
    }

    if (candidateIds.length === 0) {
      return res.json({ success: true, machines: [], count: 0 });
    }

    const Machine = require('../models/Machine');
    const machines = await Machine.find({
      _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select('ID manufacturer').lean();

    const out = machines
      .map((m) => ({
        machineId:    m._id,
        machineCode:  m.ID,
        manufacturer: m.manufacturer,
        ...meta.get(String(m._id)),
      }))
      .sort((a, b) => b.recentTotal - a.recentTotal);

    return res.json({ success: true, machines: out, count: out.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

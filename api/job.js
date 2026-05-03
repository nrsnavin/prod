'use strict';

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');

const JobOrder    = require('../models/JobOrder');
const Order       = require('../models/Order');
const Warping     = require('../models/Warping');
const Covering    = require('../models/Covering');
const Wastage     = require('../models/Wastage');
const Machine     = require('../models/Machine');
const ShiftDetail = require('../models/ShiftDetail');

const { buildFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');

const JOB_STATUSES = [
  'preparatory', 'weaving', 'finishing', 'checking', 'packing', 'completed', 'cancelled',
];

const STATUS_TRANSITIONS = {
  weaving:   'finishing',
  finishing: 'checking',
  checking:  'packing',
  packing:   'completed',
};

const STAGE_FINGERPRINT = {
  weaving:   { by: 'weavingBy',   at: 'weavingAt'   },
  finishing: { by: 'finishingBy', at: 'finishingAt' },
  checking:  { by: 'checkingBy',  at: 'checkingAt'  },
  packing:   { by: 'packingBy',   at: 'packingAt'   },
  completed: { by: 'completedBy', at: 'completedAt' },
  cancelled: { by: 'cancelledBy', at: 'cancelledAt' },
};

function stampStage(job, stage, userId) {
  const fp = STAGE_FINGERPRINT[stage];
  if (fp) {
    job[fp.by] = userId || null;
    job[fp.at] = new Date();
  }
}

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
    for (const e of elastics) {
      const pending = order.pendingElastic.find(p => p.elastic.toString() === e.elastic.toString());
      if (pending) pending.quantity -= e.quantity;
    }
    order.status = 'InProgress';

    // 🪪 Mirror fingerprint on the parent Order so the order timeline
    //    also shows that a job was spun off.
    order.fingerprints.push(buildFingerprint(ACTION_CODES.JOB_CREATED, {
      entityId: order._id,
      actor,
      meta: {
        jobId:          job._id.toString(),
        jobOrderNo:     job.jobOrderNo,
        elasticCount:   elastics.length,
        relatedHash:    jobFp.hash,
        relatedShortId: jobFp.shortId,
      },
    }));
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

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler('Machine not found', 404));
    if (machine.status !== 'free')
      return next(new ErrorHandler(`Machine is not free (current: "${machine.status}")`, 400));

    machine.status       = 'running';
    machine.orderRunning = job._id;
    machine.elastics     = Object.entries(headElasticMap).map(([head, elastic]) => ({ head: Number(head) + 1, elastic }));
    await machine.save();

    if (job.status === 'preparatory') {
      job.status = 'weaving';
      stampStage(job, 'weaving', req.user?._id);
      // 🪪 Fingerprint: JOB_STAGE_UPDATED (preparatory → weaving)
      job.fingerprints.push(buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
        entityId: job._id,
        actor:    actorFromRequest(req),
        meta:     {
          previousStage: 'preparatory',
          newStage:      'weaving',
          jobOrderNo:    job.jobOrderNo,
          machineId:     machine._id.toString(),
          machineName:   machine.ID,
        },
      }));
    }
    job.machine = machine._id;
    await job.save();

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

    const expected = STATUS_TRANSITIONS[job.status];
    if (!expected)
      return next(new ErrorHandler(`Job in status "${job.status}" cannot advance further`, 400));
    if (expected !== nextStatus)
      return next(new ErrorHandler(`Invalid transition: "${job.status}" → "${nextStatus}". Expected: "${expected}"`, 400));

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
          order.fingerprints.push(buildFingerprint(ACTION_CODES.ORDER_COMPLETED, {
            entityId: order._id,
            actor,
            meta: {
              previousStatus:  'InProgress',
              newStatus:       'Completed',
              triggeredByJob:  job._id.toString(),
              triggerJobNo:    job.jobOrderNo,
              relatedHash:     completionFp.hash,
              relatedShortId:  completionFp.shortId,
            },
          }));
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

    const order = await Order.findById(job.order);
    if (order) {
      for (const e of job.elastics) {
        const pending = order.pendingElastic.find(p => p.elastic.toString() === e.elastic.toString());
        if (pending) pending.quantity += e.quantity;
        else order.pendingElastic.push({ elastic: e.elastic, quantity: e.quantity });
      }
      const remainingJobs = await JobOrder.countDocuments({
        order: job.order, _id: { $ne: job._id }, status: { $nin: ['cancelled', 'completed'] },
      });
      if (remainingJobs === 0) order.status = 'Approved';
      await order.save();
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
      job.fingerprints.push(buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
        entityId: job._id,
        actor:    actorFromRequest(req),
        meta: {
          previousStage: 'preparatory',
          newStage:      'weaving',
          jobOrderNo:    job.jobOrderNo,
          machineId:     machine._id.toString(),
          machineName:   machine.ID,
        },
      }));
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
    return res.status(500).json({ success: false, message: err.message });
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

module.exports = router;

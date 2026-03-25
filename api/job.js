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

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────

const JOB_STATUSES = [
  'preparatory',
  'weaving',
  'finishing',
  'checking',
  'packing',
  'completed',
  'cancelled',
];

/** Only these forward transitions are legal */
const STATUS_TRANSITIONS = {
  weaving:   'finishing',
  finishing: 'checking',
  checking:  'packing',
  packing:   'completed',
};

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

function fullJobPopulate(query) {
  return query
    .populate('order',    'orderNo po status')
    .populate('customer', 'name phone')
    .populate('machine',  'ID manufacturer NoOfHeads status')
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
//  1.  CREATE JOB ORDER
//      POST /job/create
// ─────────────────────────────────────────────────────────────
router.post(
  '/create',
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, date, elastics } = req.body;

    if (!orderId) return next(new ErrorHandler('orderId is required', 400));
    if (!date)    return next(new ErrorHandler('date is required', 400));
    if (!Array.isArray(elastics) || elastics.length === 0) {
      return next(new ErrorHandler('elastics array must not be empty', 400));
    }

    for (const e of elastics) {
      if (!e.elastic)
        return next(new ErrorHandler('Each elastic entry must have an elastic ID', 400));
      if (typeof e.quantity !== 'number' || e.quantity <= 0)
        return next(new ErrorHandler('Each elastic quantity must be a positive number', 400));
    }

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler('Order not found', 404));

    if (!['Open', 'InProgress'].includes(order.status)) {
      return next(new ErrorHandler(
        `Cannot create job for an order with status "${order.status}"`, 400
      ));
    }

    for (const e of elastics) {
      const pending = order.pendingElastic.find(
        (p) => p.elastic.toString() === e.elastic.toString()
      );
      if (!pending)
        return next(new ErrorHandler(`Elastic ${e.elastic} is not part of this order`, 400));
      if (pending.quantity < e.quantity)
        return next(new ErrorHandler(
          `Requested quantity (${e.quantity}) exceeds pending (${pending.quantity})`, 400
        ));
    }

    const zeroed = elastics.map((e) => ({ elastic: e.elastic, quantity: 0 }));

    const job = await JobOrder.create({
      date:            new Date(date),
      order:           order._id,
      customer:        order.customer,
      status:          'preparatory',
      elastics,
      producedElastic: zeroed,
      packedElastic:   zeroed,
      wastageElastic:  zeroed,
    });

    const [warping, covering] = await Promise.all([
      Warping.create({ date: new Date(), job: job._id, elasticOrdered: elastics }),
      Covering.create({ date: new Date(), job: job._id, elasticPlanned: elastics }),
    ]);

    job.warping  = warping._id;
    job.covering = covering._id;
    await job.save();

    order.jobs.push({ job: job._id, no: job.jobOrderNo });

    for (const e of elastics) {
      const pending = order.pendingElastic.find(
        (p) => p.elastic.toString() === e.elastic.toString()
      );
      if (pending) pending.quantity -= e.quantity;
    }

    order.status = 'InProgress';
    await order.save();

    console.log(`[job/create] JobOrder #${job.jobOrderNo} created for Order ${orderId}`);

    res.status(201).json({
      success: true,
      message: 'Job Order created with Warping & Covering programmes',
      data: {
        job:      { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
        warping:  { _id: warping._id,  status: warping.status  },
        covering: { _id: covering._id, status: covering.status },
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  2.  LIST JOBS
//      GET /job/jobs
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
      if (!JOB_STATUSES.includes(status)) {
        return next(new ErrorHandler(
          `Invalid status "${status}". Valid: ${JOB_STATUSES.join(', ')}`, 400
        ));
      }
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
        .select('jobOrderNo status date customer machine createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      JobOrder.countDocuments(filter),
    ]);

    res.json({
      success: true,
      jobs,
      pagination: {
        total,
        page,
        limit,
        pages:   Math.ceil(total / limit),
        hasMore: skip + jobs.length < total,
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  3.  GET JOB DETAIL
//      GET /job/detail?id=<jobId>
// ─────────────────────────────────────────────────────────────
router.get(
  '/detail',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler('Job ID is required', 400));

    const job = await fullJobPopulate(JobOrder.findById(id));
    if (!job) return next(new ErrorHandler('Job not found', 404));

    res.json({ success: true, job });
  })
);


// ─────────────────────────────────────────────────────────────
//  NEW — JOB WEAVING READINESS
//  GET /job/weaving-readiness?id=<jobId>
//
//  Returns the completion status of warping and covering so the
//  Flutter client can show a "readiness" card before machine
//  assignment, telling the operator exactly what is still pending.
//
//  Response:
//    {
//      jobStatus,
//      warpingStatus,   coveringStatus,
//      warpingDone,     coveringDone,
//      readyForWeaving, // true when BOTH done
//      machineAssigned, // true when machine != null AND status == weaving
//    }
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
      success:         true,
      jobOrderNo:      job.jobOrderNo,
      jobStatus:       job.status,
      warpingStatus:   job.warping?.status  ?? null,
      coveringStatus:  job.covering?.status ?? null,
      warpingDone,
      coveringDone,
      readyForWeaving: warpingDone && coveringDone,
      machineAssigned: !!job.machine,
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  4.  PLAN WEAVING
//      POST /job/plan-weaving
//
//  Assigns a free machine and records the head→elastic map.
//
//  CHANGE: previously required job.status === "preparatory" and
//  would advance it to "weaving". Now that the auto-advance
//  happens when both warping and covering complete, this route
//  accepts BOTH "preparatory" and "weaving":
//
//    • "preparatory": assigns machine, advances to "weaving"
//      (backward-compat — operator manually plans before both
//       programmes complete)
//    • "weaving" (no machine yet): assigns machine, status stays
//       "weaving" (already advanced by the auto-hook)
// ─────────────────────────────────────────────────────────────
router.post(
  '/plan-weaving',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId, headElasticMap } = req.body;

    if (!jobId)     return next(new ErrorHandler('jobId is required', 400));
    if (!machineId) return next(new ErrorHandler('machineId is required', 400));
    if (!headElasticMap || typeof headElasticMap !== 'object' ||
        Object.keys(headElasticMap).length === 0) {
      return next(new ErrorHandler('headElasticMap must be a non-empty object', 400));
    }

    const unassigned = Object.values(headElasticMap).filter((v) => !v);
    if (unassigned.length > 0) {
      return next(new ErrorHandler(
        `${unassigned.length} machine head(s) have no elastic assigned`, 400
      ));
    }

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));

    // CHANGED: allow both "preparatory" and "weaving" (when auto-advanced
    // but machine not yet assigned)
    const allowedStatuses = ['preparatory', 'weaving'];
    if (!allowedStatuses.includes(job.status)) {
      return next(new ErrorHandler(
        `Job must be "preparatory" or "weaving" to assign machine ` +
        `(current: "${job.status}")`, 400
      ));
    }

    // If job is already "weaving" with a machine, reject (use assign-machine for reassign)
    if (job.status === 'weaving' && job.machine) {
      return next(new ErrorHandler(
        'Job already has a machine assigned. Use assign-machine to reassign.', 400
      ));
    }

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler('Machine not found', 404));

    if (machine.status !== 'free') {
      return next(new ErrorHandler(
        `Machine is not free (current: "${machine.status}")`, 400
      ));
    }

    const headPlan = Object.entries(headElasticMap).map(([head, elastic]) => ({
      head:    Number(head) + 1,
      elastic,
    }));

    machine.status       = 'running';
    machine.orderRunning = job._id;
    machine.elastics     = headPlan;
    await machine.save();

    // Only advance status if still in preparatory
    if (job.status === 'preparatory') {
      job.status = 'weaving';
    }
    job.machine = machine._id;
    await job.save();

    console.log(
      `[job/plan-weaving] Job #${job.jobOrderNo} → weaving, ` +
      `Machine ${machine.ID || machine._id}`
    );

    res.json({
      success: true,
      message: 'Weaving plan saved. Job is now in weaving.',
      data: {
        job:     { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
        machine: { _id: machine._id, ID: machine.ID, status: machine.status, headPlan },
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  5.  UPDATE JOB STATUS
//      POST /job/update-status
//
//  Forward-only: weaving → finishing → checking → packing → completed
//  weaving → finishing: releases machine
//  packing → completed: marks Order Completed if all jobs done
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
    if (!expected) {
      return next(new ErrorHandler(
        `Job in status "${job.status}" cannot advance further`, 400
      ));
    }
    if (expected !== nextStatus) {
      return next(new ErrorHandler(
        `Invalid transition: "${job.status}" → "${nextStatus}". ` +
        `Expected next: "${expected}"`, 400
      ));
    }

    if (nextStatus === 'finishing') {
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    if (nextStatus === 'completed') {
      const siblingJobs = await JobOrder.find({
        order: job.order,
        _id:   { $ne: job._id },
      }).select('status');

      const allDone = siblingJobs.every((j) =>
        ['completed', 'cancelled'].includes(j.status)
      );

      if (allDone) {
        await Order.findByIdAndUpdate(job.order, { status: 'Completed' });
        console.log(`[job/update-status] All jobs done — Order ${job.order} Completed`);
      }
    }

    job.status = nextStatus;
    await job.save();

    console.log(
      `[job/update-status] Job #${job.jobOrderNo}: → ${nextStatus}`
    );

    res.json({
      success: true,
      message: `Job advanced to "${nextStatus}"`,
      data:    { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  6.  CANCEL JOB
//      POST /job/cancel
// ─────────────────────────────────────────────────────────────
router.post(
  '/cancel',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, reason } = req.body;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));

    if (job.status === 'cancelled')
      return next(new ErrorHandler('Job is already cancelled', 400));
    if (job.status === 'completed')
      return next(new ErrorHandler('A completed job cannot be cancelled', 400));

    if (job.status === 'weaving' && job.machine) {
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    const order = await Order.findById(job.order);
    if (order) {
      for (const e of job.elastics) {
        const pending = order.pendingElastic.find(
          (p) => p.elastic.toString() === e.elastic.toString()
        );
        if (pending) {
          pending.quantity += e.quantity;
        } else {
          order.pendingElastic.push({ elastic: e.elastic, quantity: e.quantity });
        }
      }

      const remainingJobs = await JobOrder.countDocuments({
        order:  job.order,
        _id:    { $ne: job._id },
        status: { $nin: ['cancelled', 'completed'] },
      });

      if (remainingJobs === 0) order.status = 'Approved';
      await order.save();
    }

    job.status = 'cancelled';
    if (reason) job.cancelReason = reason;
    await job.save();

    console.log(`[job/cancel] Job #${job.jobOrderNo} cancelled`);

    res.json({
      success: true,
      message: 'Job cancelled and quantities restored to order',
      data:    { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  7.  CREATE WASTAGE ENTRY
//      POST /job/create-wastage
// ─────────────────────────────────────────────────────────────
router.post(
  '/create-wastage',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, elasticId, employeeId, quantity, penalty, reason } = req.body;

    if (!jobId)      return next(new ErrorHandler('jobId is required', 400));
    if (!elasticId)  return next(new ErrorHandler('elasticId is required', 400));
    if (!employeeId) return next(new ErrorHandler('employeeId is required', 400));
    if (!reason || !reason.trim()) return next(new ErrorHandler('reason is required', 400));
    if (typeof quantity !== 'number' || quantity <= 0)
      return next(new ErrorHandler('quantity must be a positive number', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));

    if (!['weaving', 'finishing', 'checking'].includes(job.status)) {
      return next(new ErrorHandler(
        `Wastage can only be recorded during weaving, finishing, or checking ` +
        `(current: "${job.status}")`, 400
      ));
    }

    const jobElastic = job.elastics.find(
      (e) => e.elastic.toString() === elasticId.toString()
    );
    if (!jobElastic) return next(new ErrorHandler('Elastic is not part of this job', 400));

    const wastage = await Wastage.create({
      job:      job._id,
      elastic:  elasticId,
      employee: employeeId,
      quantity,
      penalty:  penalty || 0,
      reason:   reason.trim(),
    });

    const idx = job.wastageElastic.findIndex(
      (e) => e.elastic.toString() === elasticId.toString()
    );
    if (idx >= 0) job.wastageElastic[idx].quantity += quantity;
    job.wastages.push(wastage._id);
    await job.save();

    res.status(201).json({ success: true, wastage });
  })
);


// ─────────────────────────────────────────────────────────────
//  8.  DAILY PRODUCTION SUMMARY
//      GET /job/summary?jobId=<id>
// ─────────────────────────────────────────────────────────────
router.get(
  '/summary',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler('jobId is required', 400));

    const job = await JobOrder.findById(jobId)
      .populate('elastics.elastic',        'name')
      .populate('producedElastic.elastic', 'name')
      .populate('packedElastic.elastic',   'name')
      .populate('wastageElastic.elastic',  'name');

    if (!job) return next(new ErrorHandler('Job not found', 404));

    const summary = job.elastics.map((e) => {
      const find = (arr) =>
        arr.find((x) => x.elastic._id.toString() === e.elastic._id.toString())
          ?.quantity || 0;

      const planned   = e.quantity;
      const produced  = find(job.producedElastic);
      const packed    = find(job.packedElastic);
      const wasted    = find(job.wastageElastic);
      const remaining = Math.max(0, planned - produced - wasted);

      return {
        elasticId:   e.elastic._id,
        elasticName: e.elastic.name,
        planned, produced, packed, wasted, remaining,
        packingPct: planned > 0 ? Math.round((packed / planned) * 100) : 0,
      };
    });

    res.json({
      success: true,
      jobId:   job._id,
      jobNo:   job.jobOrderNo,
      status:  job.status,
      summary,
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  9.  JOB OPERATORS
//      GET /job/job-operators?id=<jobId>
// ─────────────────────────────────────────────────────────────
router.get(
  '/job-operators',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler('Job ID is required', 400));

    const shifts = await ShiftDetail.find({ job: id })
      .populate('employee', 'name department');

    const seen = new Set();
    const operators = [];
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
//      GET /job/jobs-checking
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
//      POST /job/assign-machine
//
//  Used when:
//    (a) First-time machine assignment after auto-advance to weaving
//    (b) Machine swap after weaving plan was already submitted
//
//  CHANGE: previously required job.status === "weaving" strictly.
//  Now also accepts "preparatory" so it can be used as the primary
//  assignment path regardless of whether the auto-advance has fired.
// ─────────────────────────────────────────────────────────────
router.post(
  '/assign-machine',
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId, elastics } = req.body;

    if (!jobId)     return next(new ErrorHandler('jobId is required.', 400));
    if (!machineId) return next(new ErrorHandler('machineId is required.', 400));
    if (!Array.isArray(elastics) || elastics.length === 0) {
      return next(new ErrorHandler(
        'elastics must be a non-empty array of { head, elastic }.', 400
      ));
    }

    for (const entry of elastics) {
      if (typeof entry.head !== 'number' || !Number.isInteger(entry.head) || entry.head < 1)
        return next(new ErrorHandler(
          `Invalid head value "${entry.head}". Must be a positive integer.`, 400
        ));
      // elastic: null means the head is intentionally left free — skip ObjectId check
      if (entry.elastic != null &&
          !mongoose.Types.ObjectId.isValid(entry.elastic))
        return next(new ErrorHandler(
          `Invalid elastic id "${entry.elastic}" for head ${entry.head}.`, 400
        ));
    }

    const headNums = elastics.map((e) => e.head);
    if (new Set(headNums).size !== headNums.length)
      return next(new ErrorHandler('Duplicate head numbers found.', 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found.', 404));

    // CHANGED: allow both "weaving" and "preparatory"
    if (!['weaving', 'preparatory'].includes(job.status)) {
      return next(new ErrorHandler(
        `Machine can only be assigned while job is "preparatory" or "weaving" ` +
        `(current: "${job.status}").`, 400
      ));
    }

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler('Machine not found.', 404));

    const ownedByThisJob =
      machine.orderRunning?.toString() === job._id.toString();

    if (machine.status !== 'free' && !ownedByThisJob) {
      return next(new ErrorHandler(
        `Machine "${machine.ID}" is currently ${machine.status} on another job.`, 400
      ));
    }

    if (elastics.length !== machine.NoOfHead) {
      return next(new ErrorHandler(
        `Expected ${machine.NoOfHead} head entries, got ${elastics.length}.`, 400
      ));
    }

    const sortedHeads = [...headNums].sort((a, b) => a - b);
    for (let i = 0; i < sortedHeads.length; i++) {
      if (sortedHeads[i] !== i + 1) {
        return next(new ErrorHandler(
          `Head numbers must run 1 to ${machine.NoOfHead} without gaps. ` +
          `Got: [${sortedHeads.join(', ')}].`, 400
        ));
      }
    }

    const jobElasticIds = new Set(job.elastics.map((e) => e.elastic.toString()));
    for (const entry of elastics) {
      // Free heads (elastic: null) are not checked against the job's elastic list
      if (entry.elastic != null &&
          !jobElasticIds.has(entry.elastic.toString())) {
        return next(new ErrorHandler(
          `Elastic "${entry.elastic}" (head ${entry.head}) is not part of this job.`, 400
        ));
      }
    }

    // Release old machine if job had a different one
    if (job.machine && job.machine.toString() !== machineId.toString()) {
      const oldMachine = await Machine.findById(job.machine);
      if (oldMachine) {
        oldMachine.status       = 'free';
        oldMachine.orderRunning = null;
        oldMachine.elastics     = [];
        await oldMachine.save();
      }
    }

    machine.elastics = elastics.map((e) => ({
      head:    e.head,
      elastic: e.elastic ? new mongoose.Types.ObjectId(e.elastic) : null,
    }));
    machine.status       = 'running';
    machine.orderRunning = job._id;
    await machine.save();

    // If still in preparatory, advance to weaving now
    if (job.status === 'preparatory') {
      job.status = 'weaving';
    }
    job.machine = machine._id;
    await job.save();

    const populatedMachine = await Machine.findById(machine._id)
      .populate('elastics.elastic', 'name')
      .lean();

    return res.status(200).json({
      success: true,
      message: `Machine "${machine.ID}" assigned with ${machine.NoOfHead}-head plan.`,
      data: {
        jobId:     job._id,
        jobStatus: job.status,
        machineId: machine._id,
        machineID: machine.ID,
        NoOfHead:  machine.NoOfHead,
        headPlan:  (populatedMachine.elastics || []).map((e) => ({
          head:        e.head,
          elasticId:   e.elastic?._id,
          elasticName: e.elastic?.name ?? '-',
        })),
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  12. FREE MACHINES
//      GET /job/free-machines
// ─────────────────────────────────────────────────────────────
router.get(
  '/free-machines',
  catchAsyncErrors(async (_req, res) => {
    const machines = await Machine.find({ status: 'free' })
      .select('ID manufacturer NoOfHead NoOfHooks')
      .lean();

    return res.status(200).json({
      success:  true,
      count:    machines.length,
      machines: machines.map((m) => ({
        id:           m._id,
        machineID:    m.ID,
        manufacturer: m.manufacturer ?? '',
        noOfHead:     m.NoOfHead,
        noOfHooks:    m.NoOfHooks,
      })),
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  13. JOB DETAIL (alternate path)
//      GET /job/:jobId
// ─────────────────────────────────────────────────────────────
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!/^[a-f\d]{24}$/i.test(jobId)) {
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });
    }

    const job = await JobOrder.findById(jobId)
      .populate('customer', 'name phone')
      .populate('order',    'orderNo status')
      .populate('machine',  'ID manufacturer NoOfHead NoOfHooks status')
      .populate('elastics.elastic',        'name weaveType weight')
      .populate('producedElastic.elastic', 'name')
      .populate('packedElastic.elastic',   'name')
      .populate('wastageElastic.elastic',  'name')
      .populate({
        path: 'warping',
        populate: {
          path: 'warpingPlan',
          populate: { path: 'beams.sections.warpYarn', model: 'RawMaterial', select: 'name unit' },
        },
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
      .populate({
        path: 'wastages', model: 'Wastage',
        populate: [
          { path: 'elastic',  model: 'Elastic',  select: 'name' },
          { path: 'employee', model: 'Employee', select: 'name' },
        ],
      })
      .populate({
        path: 'packingDetails', model: 'Packing',
        populate: [
          { path: 'elastic',   model: 'Elastic',  select: 'name' },
          { path: 'checkedBy', model: 'Employee', select: 'name' },
          { path: 'packedBy',  model: 'Employee', select: 'name' },
        ],
      })
      .lean();

    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    const fmtDateLabel = (d) => d
      ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : null;

    const mapElasticQty = (arr) => (arr || []).map((e) => ({
      elasticId:   e.elastic?._id  || null,
      elasticName: e.elastic?.name || 'Unknown',
      quantity:    e.quantity || 0,
    }));

    const w  = job.warping;
    const wp = w?.warpingPlan;
    const warping = w ? {
      status:        w.status || 'open',
      date:          fmtDateLabel(w.date),
      completedDate: fmtDateLabel(w.completedDate),
      noOfBeams:     wp?.noOfBeams || 0,
      remarks:       wp?.remarks   || '',
      beams: (wp?.beams || []).map((b) => ({
        beamNo:    b.beamNo,
        totalEnds: b.totalEnds,
        sections:  (b.sections || []).map((s, i) => ({
          sectionNo: i + 1,
          yarnName:  s.warpYarn?.name || 'Unknown',
          yarnUnit:  s.warpYarn?.unit || '',
          ends:      s.ends || 0,
        })),
      })),
    } : null;

    const co = job.covering;
    const covering = co ? {
      status:         co.status || 'open',
      date:           fmtDateLabel(co.date),
      completedDate:  fmtDateLabel(co.completedDate),
      remarks:        co.remarks || '',
      elasticPlanned: mapElasticQty(co.elasticPlanned),
    } : null;

    const shiftDetails = (job.shiftDetails || [])
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((d) => ({
        id:               d._id,
        date:             fmtDateLabel(d.date),
        shift:            d.shift,
        status:           d.status,
        timer:            d.timer            || '00:00:00',
        productionMeters: d.productionMeters || 0,
        machineName:      d.machine?.ID      || '-',
        machineNoOfHead:  d.machine?.NoOfHead || 0,
        operatorName:     d.employee?.name   || '-',
        operatorDept:     d.employee?.department || '',
        elastics: (d.elastics || []).map((he) => ({
          head:        he.head,
          elasticName: he.elastic?.name || '-',
        })),
        description: d.description || '',
        feedback:    d.feedback    || '',
      }));

    const wastages = (job.wastages || []).map((wst) => ({
      id:           wst._id,
      elasticName:  wst.elastic?.name  || '-',
      employeeName: wst.employee?.name || '-',
      quantity:     wst.quantity || 0,
      penalty:      wst.penalty  || 0,
      reason:       wst.reason   || '',
      date:         fmtDateLabel(wst.createdAt),
    }));

    const packingDetails = (job.packingDetails || []).map((pk) => ({
      id:            pk._id,
      elasticName:   pk.elastic?.name || '-',
      quantity:      pk.quantity || 0,
      rolls:         pk.rolls    || 0,
      metersPerRoll: pk.metersPerRoll || 0,
      total:         pk.total    || 0,
      batch:         pk.batch    || '-',
      status:        pk.status   || 'open',
      date:          fmtDateLabel(pk.createdAt),
    }));

    return res.json({
      success: true,
      data: {
        id:            job._id,
        jobOrderNo:    job.jobOrderNo,
        jobNo:         `J-${job.jobOrderNo}`,
        date:          fmtDateLabel(job.date),
        status:        job.status,
        customerName:  job.customer?.name  || '-',
        customerPhone: job.customer?.phone || '',
        orderNo:       job.order?.orderNo  || '',
        machine: job.machine ? {
          machineId:       job.machine._id,
          machineName:     job.machine.ID           || '-',
          machineNoOfHead: job.machine.NoOfHead     || 0,
          manufacturer:    job.machine.manufacturer || '',
          status:          job.machine.status       || 'free',
        } : null,
        plannedElastics:  mapElasticQty(job.elastics),
        producedElastics: mapElasticQty(job.producedElastic),
        packedElastics:   mapElasticQty(job.packedElastic),
        wastageElastics:  mapElasticQty(job.wastageElastic),
        warping,
        covering,
        shiftDetails,
        wastages,
        packingDetails,
      },
    });

  } catch (err) {
    console.error('[GET /jobs/:jobId]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ── GET /api/v2/jobs  (list — lightweight) ────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      JobOrder.find(filter)
        .populate('customer', 'name')
        .populate('elastics.elastic', 'name')
        .select('jobOrderNo date status customer elastics producedElastic')
        .sort({ jobOrderNo: -1 })
        .skip((+page - 1) * +limit)
        .limit(+limit)
        .lean(),
      JobOrder.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      total,
      page:  +page,
      pages: Math.ceil(total / +limit),
      data: jobs.map((j) => ({
        id:           j._id,
        jobOrderNo:   j.jobOrderNo,
        jobNo:        `J-${j.jobOrderNo}`,
        date:         new Date(j.date).toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric',
        }),
        status:        j.status,
        customerName:  j.customer?.name || '-',
        totalPlanned:  (j.elastics || []).reduce((s, e) => s + (e.quantity || 0), 0),
        totalProduced: (j.producedElastic || []).reduce((s, e) => s + (e.quantity || 0), 0),
      })),
    });
  } catch (err) {
    console.error('[GET /jobs]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


module.exports = router;
'use strict';

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const { isAuthenticated, isAdmin } = require('../middleware/auth');

const JobOrder    = require('../models/JobOrder');
const Order       = require('../models/Order');
const Warping     = require('../models/Warping');
const Covering    = require('../models/Covering');
const Wastage     = require('../models/Wastage');
const Machine     = require('../models/Machine');
const { recomputePending } = require('../services/orderPending.js');
const ShiftDetail = require('../models/ShiftDetail');
const WarpingBatch = require('../models/WarpingBatch');
const PurchaseOrder = require('../models/PurchaseOrder');

const { buildFingerprint, stampFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { triageShortfall, createShortfallPos, skipReasons } = require('../services/shortfallPo');
const { issuedForOrder, shareForJob } = require('../services/orderIssuance');
const { checkWeavingReadiness } = require('../services/weavingReadiness');
const { plannedLotsForJob, distinctLots } = require('../services/yarnLotTrail');
const { shiftFigures, clockToMinutes } = require('../utils/shiftFigures');
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

// The order's own rule. This router changes an order's status three
// times as a side effect of something happening to a job, and none of
// those writes used to ask where the order actually was — which is how
// cancelling a job on a CANCELLED order set it back to Approved.
const { applyOrderStatus } = require('../domain/orderStatus');
const { isProductionLocked } = require('../utils/productionLock');
const { outsourcingBlockers, outsourcingDerived } = require('../utils/outsourcingRecord');
const {
  FREE_EXCESS_PCT, assessLines, plannedFromJobs, excessMaterialRequirement,
  stockShortfalls, linesNeedingReason, reasonIsUsable, describeLine,
} = require('../services/excessPlanning');
const RawMaterial = require('../models/RawMaterial');
const MaterialOutward = require('../models/MaterialOut.cjs');
const Elastic = require('../models/Elastic');
const { appendStockMovement } = require('../utils/stockLedger');

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
async function releaseMachinesForJob(job) {
  if (!job?._id) return;

  await Machine.updateMany(
    { orderRunning: job._id, status: 'running' },
    { $set: { status: 'free', orderRunning: null, elastics: [] } }
  );

  // The mirror-image stray: the job points at a machine that no longer
  // claims it.
  if (job.machine) {
    await Machine.updateOne(
      { _id: job.machine, status: { $ne: 'maintenance' } },
      { $set: { status: 'free', orderRunning: null, elastics: [] } }
    );
  }
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
    // Approved or InProgress, not Open.
    //
    // This read `['Open', 'InProgress']`, which was backwards in both
    // directions. An APPROVED order — the one the UI offers "Create
    // job" on — was refused outright, so the normal path answered
    // "Cannot create job for order with status Approved". And an OPEN
    // one was accepted and pushed to InProgress below, skipping the
    // approval that debits raw material and runs the stock guard: an
    // order could reach the floor having consumed material nobody
    // deducted, simply by raising a job on it.
    if (!['Approved', 'InProgress'].includes(order.status)) {
      return next(new ErrorHandler(
        order.status === 'Open'
          ? 'Approve the order before raising a job — approval is where raw material is deducted.'
          : `Cannot create job for order with status "${order.status}"`,
        400
      ));
    }

    // ── Excess planning ─────────────────────────────────────────
    // A line may be planned up to 120% of what was ORDERED with no
    // comment; past that only with a reason. This replaced a flat
    // "requested must not exceed pending", which refused the ordinary
    // case of setting a loom for a round number of meters.
    const siblings = await JobOrder.find({
      order: order._id, status: { $ne: 'cancelled' },
    }).select('elastics').lean();

    const rows = assessLines(elastics, order, plannedFromJobs(siblings));

    const offOrder = rows.find((r) => !r.onOrder);
    if (offOrder) {
      return next(new ErrorHandler(`Elastic ${offOrder.elastic} is not part of this order`, 400));
    }

    // Name the elastics in the messages — an id tells the planner nothing.
    const elasticDocs = await Elastic.find({ _id: { $in: rows.map((r) => r.elastic) } })
      .select('name').lean();
    const nameOf = (id) =>
      elasticDocs.find((d) => String(d._id) === String(id))?.name || 'Unnamed elastic';

    const excessRows = rows.filter((r) => r.excess > 0);
    const overAllowance = linesNeedingReason(rows);
    const excessReason = typeof req.body.excessReason === 'string' ? req.body.excessReason.trim() : '';

    if (overAllowance.length > 0 && !reasonIsUsable(excessReason)) {
      const err = new ErrorHandler(
        `Planning more than ${FREE_EXCESS_PCT}% over the ordered quantity needs a reason — `
        + overAllowance.map((r) => describeLine(r, nameOf)).join('; '),
        409
      );
      err.code = 'EXCESS_PLANNING_REASON_REQUIRED';
      err.details = {
        freeExcessPct: FREE_EXCESS_PCT,
        lines: overAllowance.map((r) => ({ ...r, name: nameOf(r.elastic) })),
      };
      return next(err);
    }

    // ── The material the excess needs ───────────────────────────
    // Approval drew yarn for the ORDERED quantity and no more, so every
    // excess meter is yarn nobody has deducted. Compute it, refuse if
    // the stock is not there, and draw it below.
    let excessRequirement = [];
    const priceById = new Map();
    if (excessRows.length > 0) {
      excessRequirement = await excessMaterialRequirement(rows);
      const materials = await RawMaterial.find({
        _id: { $in: excessRequirement.map((r) => r.rawMaterial) },
      }).select('name stock price').lean();
      const stockById = new Map(materials.map((m) => [String(m._id), m.stock]));
      // Price the draw from the same read. Writing the row at 0 and
      // correcting it afterwards leaves a window where the P&L values
      // this yarn at nothing.
      for (const m of materials) priceById.set(String(m._id), Number(m.price) || 0);

      const shortfalls = stockShortfalls(excessRequirement, stockById);
      if (shortfalls.length > 0) {
        const err = new ErrorHandler(
          'Not enough raw material for the excess quantity — '
          + shortfalls.map((s) => `${s.name} short by ${s.short} kg`).join('; '),
          409
        );
        err.code = 'INSUFFICIENT_STOCK_FOR_EXCESS';
        err.details = { shortfalls, requirement: excessRequirement };
        return next(err);
      }
    }

    // Deduct BEFORE the job exists, so a job can never reach the floor
    // on yarn that was not there. Each deduction is a single atomic
    // conditional update — `stock: { $gte: qty }` is the real guard
    // against a concurrent draw, not the read above. This route is not
    // transactional (it runs on a standalone mongod in test), so a
    // failure part-way compensates the deductions already applied.
    const drawn = [];
    if (excessRequirement.length > 0) {
      for (const r of excessRequirement) {
        const qty = Number(r.requiredWeight) || 0;
        if (qty <= 0) continue;
        const updated = await RawMaterial.findOneAndUpdate(
          { _id: r.rawMaterial, stock: { $gte: qty } },
          { $inc: { stock: -qty, totalConsumption: qty } },
          { new: true }
        );
        if (!updated) {
          for (const back of drawn) {
            await RawMaterial.updateOne(
              { _id: back.rawMaterial },
              { $inc: { stock: back.quantity, totalConsumption: -back.quantity } }
            );
          }
          const err = new ErrorHandler(
            `Raw material ran out while raising this job (${r.name || 'material'}) — nothing was deducted. Try again.`,
            409
          );
          err.code = 'INSUFFICIENT_STOCK_FOR_EXCESS';
          return next(err);
        }
        drawn.push({
          rawMaterial: r.rawMaterial,
          name: r.name || updated.name || '',
          quantity: qty,
          balance: updated.stock,
        });
      }
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
        excessLines:   excessRows.length,
        excessQuantity: excessRows.reduce((s, r) => s + r.excess, 0),
        excessReason:  excessReason || undefined,
        excessMaterialDrawn: drawn.map((d) => `${d.name} ${d.quantity}`),
      },
    });
    job.fingerprints.push(jobFp);
    await job.save();

    // ── Book the excess draw ────────────────────────────────────
    // The stock is already down (above); these are the records that
    // explain where it went. JOB_CONSUMPTION, not ORDER_APPROVAL: it
    // belongs to this job, and the order P&L already counts that type,
    // so excess yarn lands on the order's cost without further wiring.
    if (drawn.length > 0) {
      await MaterialOutward.create(drawn.map((d) => ({
        rawMaterial: d.rawMaterial,
        quantity:    d.quantity,
        job:         job._id,
        type:        'JOB_CONSUMPTION',
        outwardDate: new Date(),
        unitPrice:   priceById.get(String(d.rawMaterial)) ?? 0,
        remarks:     `Excess planning on J-${job.jobOrderNo} (order #${order.orderNo})`,
      })));
      for (const d of drawn) {
        await appendStockMovement(d.rawMaterial, {
          type: 'JOB_CONSUMPTION',
          refNo: job.jobOrderNo != null ? String(job.jobOrderNo) : '',
          quantity: -d.quantity,
          balance: d.balance,
        });
      }
    }

    // ── Record the excess on the order ──────────────────────────
    // Appended, never replaced: two jobs can each over-plan the same
    // elastic and both are worth seeing on the order detail page.
    for (const r of excessRows) {
      const forThisLine = r.needsReason ? excessReason : '';
      order.excessPlanning.push({
        elastic:         r.elastic,
        elasticName:     nameOf(r.elastic),
        job:             job._id,
        jobOrderNo:      job.jobOrderNo,
        orderedQuantity: r.ordered,
        plannedQuantity: r.totalPlanned,
        excessQuantity:  r.excess,
        excessPct:       Number.isFinite(r.excessPct) ? r.excessPct : 0,
        reason:          forThisLine,
        // The whole draw is attributed to the job, not split per line —
        // the requirement was computed from all the excess lines at once
        // and there is no honest way to divide a shared material back out.
        materialsDrawn:  drawn.map((d) => ({
          rawMaterial: d.rawMaterial, name: d.name, quantity: d.quantity,
        })),
        recordedBy:      req.user?._id || null,
        recordedAt:      new Date(),
      });
    }

    order.jobs.push({ job: job._id, no: job.jobOrderNo });
    // Pending = ordered − planned, recomputed from the order's live jobs
    // (now including the one just created) rather than decremented in
    // place, so every path agrees and a re-run can't double-count.
    await recomputePending(order);

    // "Recalculate materials required": the order's requirement was
    // computed for the ordered quantity. Now that more is being made,
    // it is restated for what is actually PLANNED, so the requirement
    // sheet and the yarn that left stock tell the same story.
    if (excessRows.length > 0) {
      const plannedLines = (order.elasticOrdered || []).map((l) => {
        const row = rows.find((r) => r.elastic === String(l.elastic));
        return {
          elastic: l.elastic,
          quantity: row ? Math.max(row.ordered, row.totalPlanned) : Number(l.quantity) || 0,
        };
      });
      order.rawMaterialRequired = await computeMaterialRequirement(plannedLines);
      order.updatedItemsAt = new Date();
    }
    // Approved → InProgress. A no-op when the order is already running,
    // and refused outright for anything terminal — raising a job must
    // not be a way to reopen a finished order.
    applyOrderStatus(order, 'InProgress', req.user?._id);

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
    if (Object.values(headElasticMap).some(v => !v))
      return next(new ErrorHandler('All machine heads must have an elastic assigned', 400));

    const job = await JobOrder.findById(jobId);
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
    const movingWhileRunning =
      job.status === 'weaving' &&
      job.machine &&
      job.machine.toString() !== String(machineId);
    const previousMachineId = job.machine ? job.machine.toString() : null;

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

    // preparatory → weaving is the one transition the state machine
    // cannot decide alone: the job only counts as prepared once BOTH
    // its warping and its covering are completed. If either is still
    // open the job keeps its status and the caller is told which one —
    // no partial move, no silent no-op.
    if (check.gate === 'weaving-readiness') {
      const readiness = await checkWeavingReadiness(job._id);
      if (!readiness.ready) {
        const err = new ErrorHandler(
          `Job cannot move to weaving yet — ${readiness.blockers.join('; ')}`,
          409
        );
        err.code = 'WEAVING_NOT_READY';
        err.details = { status: job.status, stages: readiness.stages, blockers: readiness.blockers };
        return next(err);
      }
    }

    // An outsourced job has no shift trail, so its vendor record IS the
    // production record — and `finishing` is where production and the
    // outsource toggle both close (utils/productionLock.js). A record
    // left blank at this moment stays blank for good, so the move is
    // refused until it reconciles. Same shape as the weaving gate above:
    // the job keeps its status and the caller is told what is missing.
    if (nextStatus === 'finishing' && job.productionMode === 'outsource') {
      const blockers = outsourcingBlockers(job.outsourcing);
      if (blockers.length > 0) {
        const err = new ErrorHandler(
          `Job cannot move to finishing yet — complete the vendor record: ${blockers.join('; ')}`,
          409
        );
        err.code = 'OUTSOURCING_INCOMPLETE';
        err.details = { status: job.status, vendor: job.outsourceVendor || '', blockers };
        return next(err);
      }
    }

    // Weaving is over, so the machine goes back in the pool.
    if (nextStatus === 'finishing') {
      await releaseMachinesForJob(job);
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
        // A cancelled or deleted order is not completed by its jobs
        // finishing — that used to resurrect it.
        if (order && applyOrderStatus(order, 'Completed', req.user?._id)) {
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
    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));
    if (job.status === 'cancelled') return next(new ErrorHandler('Job is already cancelled', 400));
    if (job.status === 'completed') return next(new ErrorHandler('A completed job cannot be cancelled', 400));

    // Whatever the job was standing on, it is not standing on it now.
    //
    // This used to run only for a job in WEAVING that pointed at a
    // machine. A machine can be claimed while the job is still
    // preparatory — the system offers that deliberately, to reserve
    // capacity — so cancelling such a job left its machine running
    // forever on a job that no longer exists to release it.
    await releaseMachinesForJob(job);
    job.machine = undefined;

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
      // Nothing is planned any more, so an order that was running goes
      // back to waiting. Only from InProgress: a completed or cancelled
      // order stays where it is.
      if (remainingJobs === 0) applyOrderStatus(order, 'Approved', req.user?._id);
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
      return {
        elasticId: e.elastic._id, elasticName: e.elastic.name,
        planned, produced, packed, wasted,
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

    // ── Let go of whatever this job was on ───────────────────────────
    //
    // The link lives on BOTH documents: `job.machine` and
    // `machine.orderRunning`. This used to release by `job.machine`
    // alone, which misses a machine that holds the job while the job
    // does not point back — and that state is reachable, because the
    // machine and the job below are two separate writes with no
    // transaction around them. A failure between them leaves a machine
    // running a job that has never heard of it, and no later assignment
    // would ever free it.
    //
    // Released by `orderRunning` instead, which is the machine's own
    // claim, so any machine standing on this job is let go regardless of
    // which side of the link survived. Scoped to THIS job, so a machine
    // running someone else's is untouched — and to `running`, so a
    // machine in maintenance is not put back in the picker while it is
    // in pieces on the floor.
    await Machine.updateMany(
      {
        _id: { $ne: machine._id },
        orderRunning: job._id,
        status: 'running',
      },
      { $set: { status: 'free', orderRunning: null, elastics: [] } }
    );

    // The mirror-image stray: the job points at a machine that no longer
    // claims it. Clearing by id is safe here precisely because the
    // machine is not running anything.
    if (job.machine && job.machine.toString() !== machineId.toString()) {
      await Machine.updateOne(
        // $eq and $ne on the one field: two `_id` keys in an object
        // literal is not a conjunction, the second silently replaces the
        // first.
        { _id: { $eq: job.machine, $ne: machine._id }, status: { $ne: 'maintenance' } },
        { $set: { status: 'free', orderRunning: null, elastics: [] } }
      );
    }

    machine.elastics     = elastics.map(e => ({ head: e.head, elastic: e.elastic ? new mongoose.Types.ObjectId(e.elastic) : null }));
    machine.status       = 'running';
    machine.orderRunning = job._id;
    await machine.save();

    // Assigning a machine reserves capacity; it does not make the job
    // prepared. The status only moves once warping and covering are
    // both completed — the same rule /update-status enforces — and the
    // job advances on its own the moment they are.
    let held = null;
    if (job.status === 'preparatory') {
      const readiness = await checkWeavingReadiness(job._id);
      held = readiness.ready ? null : readiness.blockers;

      if (readiness.ready) {
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
    }
    job.machine = machine._id;
    await job.save();

    const populatedMachine = await Machine.findById(machine._id).populate('elastics.elastic', 'name').lean();
    return res.status(200).json({
      success: true,
      message: held
        ? `Machine "${machine.ID}" assigned. The job stays in preparatory — ${held.join('; ')}.`
        : `Machine "${machine.ID}" assigned with ${machine.NoOfHead}-head plan.`,
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
        populate: {
          path: 'warpingPlan',
          populate: [
            { path: 'beams.sections.warpYarn', model: 'RawMaterial', select: 'name unit' },
            { path: 'beams.sections.yarnLot', model: 'YarnLot', select: 'lotNo shade status' },
          ],
        },
      })
      .populate({ path: 'covering', populate: { path: 'elasticPlanned.elastic', select: 'name' } })
      // shiftDetails is NOT populated here — see below. The array on the
      // job was never written to by anything, so populating it returned
      // an empty list for every job that has ever existed.
      .populate({ path: 'wastages', model: 'Wastage', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'employee', model: 'Employee', select: 'name' }] })
      .populate({ path: 'packingDetails', model: 'Packing', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'checkedBy', model: 'Employee', select: 'name' }, { path: 'packedBy', model: 'Employee', select: 'name' }] })
      .lean();

    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    // ── The shifts run on this job ───────────────────────────────────
    // Read by their `job` ref, not off `JobOrder.shiftDetails`. That
    // array is denormalised and no code has ever pushed to it, so
    // populating it returned an empty list for every job that has ever
    // existed — a fact-shaped empty, which reads as "no shifts yet"
    // rather than as a bug. Querying the shifts themselves also picks up
    // every shift recorded before this was noticed.
    const shiftDocs = await ShiftDetail.find({ job: job._id })
      .populate('machine',  'ID NoOfHead status')
      .populate('employee', 'name department')
      .populate('elastics.elastic', 'name weaveType')
      .sort({ date: 1, _id: 1 })
      .lean();

    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
    const mapElasticQty = arr => (arr || []).map(e => ({ elasticId: e.elastic?._id || null, elasticName: e.elastic?.name || 'Unknown', quantity: e.quantity || 0 }));
    const fpUser = u => u ? { name: u.name, role: u.role } : null;

    const w = job.warping; const wp = w?.warpingPlan;
    const warping = w ? {
      status: w.status || 'open', date: fmtDate(w.date), completedDate: fmtDate(w.completedDate),
      noOfBeams: wp?.noOfBeams || 0, remarks: wp?.remarks || '',
      beams: (wp?.beams || []).map(b => ({
        beamNo: b.beamNo,
        totalEnds: b.totalEnds,
        sections: (b.sections || []).map((s, i) => ({
          sectionNo: i + 1,
          yarnName: s.warpYarn?.name || 'Unknown',
          yarnUnit: s.warpYarn?.unit || '',
          ends: s.ends || 0,
          // Prefer the snapshot over the populated lot: it is what the
          // printed programme said, and it survives the lot record.
          lotNo: s.lotNo || s.yarnLot?.lotNo || '',
          shade: s.shade || s.yarnLot?.shade || '',
        })),
      })),
    } : null;

    const co = job.covering;
    const covering = co ? { status: co.status || 'open', date: fmtDate(co.date), completedDate: fmtDate(co.completedDate), remarks: co.remarks || '', elasticPlanned: mapElasticQty(co.elasticPlanned) } : null;

    const shiftDetails = shiftDocs.map(d => {
      // Until an admin verifies, the operator's numbers live in the
      // submitted* fields; the canonical ones are still 0. Reporting
      // those makes a shift that ran all night look idle, so
      // shiftFigures owns the fallback and `verified` says which it is.
      const { timer, meters } = shiftFigures(d);
      return {
        id: d._id, date: fmtDate(d.date), shift: d.shift, status: d.status,
        timer: timer || '00:00:00',
        productionMeters: meters,
        verified: d.status === 'closed',
        machineName: d.machine?.ID || '-', machineNoOfHead: d.machine?.NoOfHead || 0,
        operatorName: d.employee?.name || '-', operatorDept: d.employee?.department || '',
        elastics: (d.elastics || []).map(he => ({ head: he.head, elasticName: he.elastic?.name || '-' })),
        description: d.description || '', feedback: d.feedback || '',
      };
    });

    // ── What the shifts add up to ────────────────────────────────────
    // The list answers "which shifts", this answers "how much did they
    // make and how long did it take" without the reader adding up rows
    // by eye. Verified and merely-submitted are counted separately,
    // because a claim and a checked figure are not the same fact.
    const shiftSummary = shiftDocs.reduce((acc, d) => {
      const { timer, meters } = shiftFigures(d);
      acc.shifts += 1;
      acc.produced += meters;
      acc.workedMinutes += clockToMinutes(timer);
      if (d.shift === 'DAY' || d.shift === 'NIGHT') acc.byShift[d.shift] += meters;
      if (d.status === 'closed') acc.closed += 1;
      else if (d.status === 'pending_verification') acc.awaitingVerification += 1;
      else acc.open += 1;
      const at = d.date ? new Date(d.date) : null;
      if (at) {
        if (!acc.firstDate || at < acc.firstDate) acc.firstDate = at;
        if (!acc.lastDate  || at > acc.lastDate)  acc.lastDate  = at;
      }
      return acc;
    }, {
      shifts: 0, produced: 0, workedMinutes: 0,
      byShift: { DAY: 0, NIGHT: 0 },
      closed: 0, awaitingVerification: 0, open: 0,
      firstDate: null, lastDate: null,
    });
    // Both shifts run 12h, so this is output per hour actually worked —
    // not per hour rostered, which would flatter a machine that stood
    // idle for half of it.
    shiftSummary.metresPerHour = shiftSummary.workedMinutes > 0
      ? Math.round((shiftSummary.produced / (shiftSummary.workedMinutes / 60)) * 10) / 10
      : 0;
    shiftSummary.firstDateLabel = fmtDate(shiftSummary.firstDate);
    shiftSummary.lastDateLabel  = fmtDate(shiftSummary.lastDate);

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
        warping, covering, shiftDetails, shiftSummary, wastages, packingDetails,
        // An outsourced job is made by a vendor, so it has no shifts of its
        // own — the detail page shows the vendor in place of the (empty)
        // shift list rather than an "unrecorded" empty state.
        productionMode:  job.productionMode || 'in_house',
        outsourceVendor: job.outsourceVendor || '',
        // The vendor record, with the figures the planner reads rather
        // than types, and what still blocks the move to finishing.
        outsourcing: job.productionMode === 'outsource'
          ? {
              ...(job.outsourcing?.toObject?.() ?? job.outsourcing ?? {}),
              derived:  outsourcingDerived(job.outsourcing),
              blockers: outsourcingBlockers(job.outsourcing),
            }
          : null,
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

/**
 * This job's material requirement, net of what its order already drew.
 *
 * A job only exists under an approved order, and approving that order
 * took its material out of stock. Comparing the job's full requirement
 * against the balance left behind reported every job as short of the
 * yarn standing on the floor for it, and the shortfall panel then
 * offered to buy it a second time.
 *
 * @param job  lean job with `order` populated (orderNo + rawMaterialRequired)
 */
async function jobRequirement(job) {
  const materials = await computeMaterialRequirement(job.elastics || []);
  const orderId = job.order?._id || job.order;
  if (!orderId) return materials;

  const drawn = await issuedForOrder(orderId);
  if (drawn.size === 0) return materials;

  return computeMaterialRequirement(job.elastics || [], {
    allocated: shareForJob(drawn, job.order?.rawMaterialRequired || [], materials),
  });
}

// Assemble the plain MRP data object the JSON route and the PDF
// renderer both consume. Returns null if the job doesn't exist.
async function _buildMrpData(jobId) {
  const job = await JobOrder.findById(jobId)
    .populate("customer", "name")
    // po + supplyDate come along so the sheet can say which customer
    // order it serves and when that order is due — the two questions
    // asked of an MRP sheet that it could not previously answer.
    // rawMaterialRequired divides the order's draw across its jobs.
    .populate("order",    "orderNo po supplyDate rawMaterialRequired")
    .populate("elastics.elastic", "name")
    .lean();
  if (!job) return null;

  const materials = await jobRequirement(job);

  return {
    jobId:           String(job._id),
    jobOrderNo:      job.jobOrderNo,
    orderNo:         job.order?.orderNo ?? null,
    customerPo:      job.order?.po || "",
    supplyDateLabel: job.order?.supplyDate
      ? new Date(job.order.supplyDate).toLocaleDateString("en-IN",
          { day: "2-digit", month: "short", year: "numeric" })
      : "",
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

// ════════════════════════════════════════════════════════════════
//  PUT /:jobId/outsourcing — save the vendor job-work record.
//
//  Saved progressively: the consignment goes out, then comes back, and
//  the planner fills what they know as they know it. Completeness is not
//  required here — it is enforced at the finishing gate, so a half-filled
//  record can still be parked. Editing stays open after `finishing` on
//  purpose: spotting a typo in the efficiency you just entered should not
//  need a status rollback, and every write is fingerprinted.
// ════════════════════════════════════════════════════════════════
router.put('/:jobId/outsourcing', isAdmin('admin', 'production', 'accounts'), async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
    if (job.productionMode !== 'outsource') {
      return res.status(409).json({
        success: false,
        message: 'This job is produced in-house — set it to outsourced before recording vendor work.',
      });
    }

    const b = req.body || {};
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    const date = (v) => (v ? new Date(v) : null);

    const next = {
      qtySentMeters:      num(b.qtySentMeters),
      qtyReceivedMeters:  num(b.qtyReceivedMeters),
      efficiencyPct:      num(b.efficiencyPct),
      actualReturnDate:   date(b.actualReturnDate),
      notes:              typeof b.notes === 'string' ? b.notes.trim() : '',
      dispatchDate:       date(b.dispatchDate),
      expectedReturnDate: date(b.expectedReturnDate),
      rejectedMeters:     num(b.rejectedMeters),
      ratePerMeter:       num(b.ratePerMeter),
      outwardChallanNo:   typeof b.outwardChallanNo === 'string' ? b.outwardChallanNo.trim() : '',
      inwardChallanNo:    typeof b.inwardChallanNo === 'string' ? b.inwardChallanNo.trim() : '',
      recordedBy:         req.user?._id || null,
      recordedAt:         new Date(),
    };
    for (const [k, v] of Object.entries(next)) {
      if (Number.isNaN(v)) {
        return res.status(400).json({ success: false, message: `${k} must be a number.` });
      }
    }

    job.outsourcing = { ...(job.outsourcing?.toObject?.() ?? job.outsourcing ?? {}), ...next };
    job.fingerprints.push(buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
      entityId: job._id,
      actor: actorFromRequest(req),
      meta: {
        vendorRecordSaved: true,
        vendor:            job.outsourceVendor || '',
        efficiencyPct:     next.efficiencyPct,
        qtySentMeters:     next.qtySentMeters,
        qtyReceivedMeters: next.qtyReceivedMeters,
      },
    }));
    await job.save();

    const rec = job.outsourcing?.toObject?.() ?? job.outsourcing;
    return res.json({ success: true, data: {
      ...rec,
      derived:  outsourcingDerived(rec),
      blockers: outsourcingBlockers(rec),
    }});
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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

    // Once the job leaves the loom (finishing onward) how it was made is
    // history — flipping it to outsourced would rewrite the record of work
    // that is already done. Read the status BEFORE writing, so a locked
    // job is refused rather than updated and then complained about.
    const existing = await JobOrder.findById(jobId).select('jobOrderNo status');
    if (!existing) return res.status(404).json({ success: false, message: 'Job not found.' });
    if (isProductionLocked(existing.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot change production mode — J-${existing.jobOrderNo} has moved to ${existing.status}. ` +
                 `Production closes once a job leaves the loom.`,
      });
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

    // ── What the warping programme committed to ──────────────────────
    // A lot is chosen when the programme is written, which is days
    // before any batch is issued. Reading only the batches meant that
    // decision — already made, already printed on the sheet at the
    // machine — showed up nowhere at all until the yarn moved.
    const planned = await plannedLotsForJob(jobId);
    for (const p of planned.entries) {
      const g = groupFor(
        p.elasticId || 'unattributed',
        p.elasticName || 'Not attributed to an elastic'
      );
      g.lots.push({
        source: 'planned',
        planId: p.planId,
        batchId: null,
        batchNo: null,
        batchStatus: null,
        beamNos: p.beamNos,
        yarnLot: p.yarnLot,
        lotNo: p.lotNo,
        shade: p.shade,
        lotStatus: p.lotStatus,
        materialName: p.materialName,
        // Programming names the lot, it does not weigh it. A quantity
        // here would be invented; the section count is what was decided.
        quantity: null,
        sections: p.sections,
        sharedAcross: 1,
        issuedDate: null,
      });
    }

    for (const b of live) {
      const targets = (b.elastics || []).length
        ? b.elastics.map((e) => ({ key: String(e._id), name: e.name || 'Unknown' }))
        : [{ key: 'unattributed', name: 'Not attributed to an elastic' }];

      for (const t of targets) {
        const g = groupFor(t.key, t.name);
        for (const a of b.allocations || []) {
          g.lots.push({
            // Issued: the cones are off the rack. Never merged with the
            // planned row above — one can still change, the other cannot.
            source: 'issued',
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
    const lots = distinctLots(byElastic.flatMap((g) => g.lots));

    return res.json({
      success: true,
      data: {
        jobId: job._id,
        jobOrderNo: job.jobOrderNo,
        byElastic,
        lots,
        // Sections the programme has left open. Not a fault — an undyed
        // yarn has no lot, and a plan can be written before the lot is
        // decided — but it is the difference between "no lot chosen" and
        // "no programme", which a blank list cannot express.
        sections: planned.sections,
        openBeamNos: planned.openBeamNos,
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

// ════════════════════════════════════════════════════════════════
//  POST /:jobId/raise-po
//
//  Turn this job's material shortfalls into purchase orders.
//
//  The shortfall is already on the MRP; what was missing was any way to
//  act on it without re-keying the same numbers into the PO screen and
//  losing the connection to the job that needed them. The POs raised
//  here carry that link, so the purchase stays answerable.
//
//  One PO per supplier, because a purchase order is a document sent to
//  one supplier — splitting is not a design choice, it is what the
//  document is. Materials with no supplier set cannot be ordered and
//  are reported back rather than silently dropped.
//
//  Body: { materials?: [id], expectedDate?, notes? }
//    materials — restrict to these material ids; omitted means every
//                material currently short.
// ════════════════════════════════════════════════════════════════
router.post('/:jobId/raise-po', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId)
      .select('jobOrderNo order elastics')
      .populate('order', 'rawMaterialRequired')
      .lean();
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    const requirement = await jobRequirement(job);
    const { orderable, noSupplier, unresolved, anyShort, awaitingDelivery } =
      triageShortfall(requirement, req.body?.materials);

    if (!anyShort) {
      return res.status(400).json({
        success: false,
        message: awaitingDelivery.length
          ? `Already on order — ${awaitingDelivery
              .map((m) => m.name)
              .join(', ')} ${awaitingDelivery.length === 1 ? 'is' : 'are'} short but bought and awaiting delivery.`
          : 'Nothing is short on this job — no purchase order to raise.',
      });
    }
    if (orderable.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'None of the short materials has a supplier set — set one before raising a PO.',
        skipped: skipReasons(unresolved, noSupplier),
      });
    }

    const created = await createShortfallPos(
      orderable,
      // `order` is populated for the requirement split above, so take the
      // id off it — the PO's ref is an id, not the document.
      { forJob: job._id, forOrder: job.order?._id || job.order || undefined },
      {
        expectedDate: req.body?.expectedDate,
        notes: req.body?.notes,
        defaultNote: `Raised for job J-${job.jobOrderNo} material shortfall`,
      }
    );

    // Audit on the job: raising a PO commits money from this screen, and
    // the job is where someone looks for why.
    try {
      const jobDoc = await JobOrder.findById(jobId);
      if (jobDoc) {
        stampFingerprint(jobDoc, ACTION_CODES.PO_RAISED, {
          req,
          meta: {
            source: 'mrp-shortfall',
            purchaseOrders: created.map((c) => ({ poNo: c.poNo, supplier: c.supplierName })),
          },
        });
        await jobDoc.save();
      }
    } catch (fpErr) {
      // The POs exist either way; losing the audit line is not worth
      // failing the request and leaving the caller unsure what was made.
      console.warn('[raise-po] fingerprint failed:', fpErr.message);
    }

    return res.status(201).json({
      success: true,
      purchaseOrders: created,
      skipped: skipReasons(unresolved, noSupplier),
    });
  } catch (err) {
    console.error('[POST /jobs/:jobId/raise-po]', err);
    return res.status(500).json({ success: false, message: 'Failed to raise purchase orders' });
  }
});

// ════════════════════════════════════════════════════════════════
//  GET /:jobId/purchase-orders — what has been ordered for this job
// ════════════════════════════════════════════════════════════════
router.get('/:jobId/purchase-orders', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const pos = await PurchaseOrder.find({ forJob: jobId })
      .populate('supplier', 'name')
      .populate('items.rawMaterial', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, purchaseOrders: pos });
  } catch (err) {
    console.error('[GET /jobs/:jobId/purchase-orders]', err);
    return res.status(500).json({ success: false, message: 'Failed to load purchase orders' });
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

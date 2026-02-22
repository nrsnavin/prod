"use strict";

const express = require("express");
const router  = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const JobOrder    = require("../models/JobOrder");
const Order       = require("../models/Order");
const Warping     = require("../models/Warping");
const Covering    = require("../models/Covering");
const Wastage     = require("../models/Wastage");
const Machine     = require("../models/Machine");
const ShiftDetail = require("../models/ShiftDetail");

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────

const JOB_STATUSES = [
  "preparatory",
  "weaving",
  "finishing",
  "checking",
  "packing",
  "completed",
  "cancelled",
];

/** Only these forward transitions are legal */
const STATUS_TRANSITIONS = {
  weaving:   "finishing",
  finishing: "checking",
  checking:  "packing",
  packing:   "completed",
};

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Full populate spec reused by GET /detail.
 * Keeping it in one place means any future field addition
 * only needs to be updated here.
 */
function fullJobPopulate(query) {
  return query
    .populate("order",    "orderNo po status")
    .populate("customer", "name phone")
    .populate("machine",  "ID manufacturer NoOfHeads status")
    .populate("elastics.elastic",        "name")
    .populate("producedElastic.elastic", "name")
    .populate("packedElastic.elastic",   "name")
    .populate("wastageElastic.elastic",  "name")
    .populate({
      path: "warping",
      select: "status date completedDate elasticOrdered warpingPlan",
      populate: { path: "elasticOrdered.elastic", select: "name" },
    })
    .populate({
      path: "covering",
      select: "status date completedDate elasticPlanned",
      populate: { path: "elasticPlanned.elastic", select: "name" },
    })
    .populate({
      path: "shiftDetails",
      populate: { path: "employee", select: "name department" },
    })
    .populate({
      path: "wastages",
      populate: [
        { path: "elastic",  select: "name" },
        { path: "employee", select: "name" },
      ],
    })
    .populate({
      path: "packingDetails",
      populate: [
        { path: "elastic",   select: "name" },
        { path: "packedBy",  select: "name" },
        { path: "checkedBy", select: "name" },
      ],
    });
}

/**
 * Release a machine back to "free" state.
 * Safe to call even if machineId is null/undefined.
 */
async function releaseMachine(machineId) {
  if (!machineId) return;
  const machine = await Machine.findById(machineId);
  if (!machine) return;
  machine.status       = "free";
  machine.orderRunning = null;
  await machine.save();
}

// ─────────────────────────────────────────────────────────────
//  1.  CREATE JOB ORDER
//      POST /job/create
//
//  Creates a JobOrder, Warping programme, and Covering programme
//  in a single atomic sequence. Deducts from Order.pendingElastic
//  and advances Order.status → "InProgress".
// ─────────────────────────────────────────────────────────────
router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, date, elastics } = req.body;

    // ── Input validation ───────────────────────────────────
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));
    if (!date)    return next(new ErrorHandler("date is required", 400));
    if (!Array.isArray(elastics) || elastics.length === 0) {
      return next(new ErrorHandler("elastics array must not be empty", 400));
    }

    for (const e of elastics) {
      if (!e.elastic) {
        return next(new ErrorHandler("Each elastic entry must have an elastic ID", 400));
      }
      if (typeof e.quantity !== "number" || e.quantity <= 0) {
        return next(new ErrorHandler("Each elastic quantity must be a positive number", 400));
      }
    }

    // ── Fetch & validate Order ─────────────────────────────
    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (!["Open", "InProgress"].includes(order.status)) {
      return next(
        new ErrorHandler(
          `Cannot create job for an order with status "${order.status}"`,
          400
        )
      );
    }

    // ── Validate quantities against pending ────────────────
    for (const e of elastics) {
      const pending = order.pendingElastic.find(
        (p) => p.elastic.toString() === e.elastic.toString()
      );
      if (!pending) {
        return next(
          new ErrorHandler(
            `Elastic ${e.elastic} is not part of this order`,
            400
          )
        );
      }
      if (pending.quantity < e.quantity) {
        return next(
          new ErrorHandler(
            `Requested quantity (${e.quantity}) for elastic ${e.elastic} exceeds pending quantity (${pending.quantity})`,
            400
          )
        );
      }
    }

    // ── Create JobOrder ────────────────────────────────────
    const zeroed = elastics.map((e) => ({ elastic: e.elastic, quantity: 0 }));

    const job = await JobOrder.create({
      date:            new Date(date),
      order:           order._id,
      customer:        order.customer,
      status:          "preparatory",
      elastics,
      producedElastic: zeroed,
      packedElastic:   zeroed,
      wastageElastic:  zeroed,
    });

    // ── Create Warping & Covering programmes ───────────────
    const [warping, covering] = await Promise.all([
      Warping.create({
        date:          new Date(),
        job:           job._id,
        elasticOrdered: elastics,
      }),
      Covering.create({
        date:          new Date(),
        job:           job._id,
        elasticPlanned: elastics,
      }),
    ]);

    // ── Link programmes back to job ────────────────────────
    job.warping  = warping._id;
    job.covering = covering._id;
    await job.save();

    // ── Update Order ───────────────────────────────────────
    order.jobs.push({ job: job._id, no: job.jobOrderNo });

    for (const e of elastics) {
      const pending = order.pendingElastic.find(
        (p) => p.elastic.toString() === e.elastic.toString()
      );
      if (pending) pending.quantity -= e.quantity;
    }

    order.status = "InProgress";
    await order.save();

    console.log(`[job/create] JobOrder #${job.jobOrderNo} created for Order ${orderId}`);

    res.status(201).json({
      success: true,
      message: "Job Order created with Warping & Covering programmes",
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
//
//  Query params:
//    status  – filter by status (omit or "all" for no filter)
//    search  – numeric jobOrderNo substring search
//    page    – 1-based page (default 1)
//    limit   – items per page (default 10, max 50)
// ─────────────────────────────────────────────────────────────
router.get(
  "/jobs",
  catchAsyncErrors(async (req, res, next) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip  = (page - 1) * limit;

    const { status, search } = req.query;

    const filter = {};

    if (status && status !== "all") {
      if (!JOB_STATUSES.includes(status)) {
        return next(
          new ErrorHandler(
            `Invalid status "${status}". Valid values: ${JOB_STATUSES.join(", ")}`,
            400
          )
        );
      }
      filter.status = status;
    }

    if (search) {
      const n = Number(search);
      if (!isNaN(n) && Number.isInteger(n)) {
        filter.jobOrderNo = n;
      }
      // Non-numeric search is silently ignored (job numbers are ints)
    }

    const [jobs, total] = await Promise.all([
      JobOrder.find(filter)
        .populate("customer", "name")
        .populate("machine",  "ID status")
        .select("jobOrderNo status date customer machine createdAt")
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
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Job ID is required", 400));

    const job = await fullJobPopulate(JobOrder.findById(id));
    if (!job) return next(new ErrorHandler("Job not found", 404));

    res.json({ success: true, job });
  })
);


// ─────────────────────────────────────────────────────────────
//  4.  PLAN WEAVING
//      POST /job/plan-weaving
//
//  Assigns a free machine, records the head→elastic map on the
//  machine, and advances job status: preparatory → weaving.
// ─────────────────────────────────────────────────────────────
router.post(
  "/plan-weaving",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId, headElasticMap } = req.body;

    // ── Input validation ───────────────────────────────────
    if (!jobId)         return next(new ErrorHandler("jobId is required", 400));
    if (!machineId)     return next(new ErrorHandler("machineId is required", 400));
    if (!headElasticMap || typeof headElasticMap !== "object" ||
        Object.keys(headElasticMap).length === 0) {
      return next(new ErrorHandler("headElasticMap must be a non-empty object", 400));
    }

    // ── Validate head assignments are complete ─────────────
    const unassigned = Object.values(headElasticMap).filter((v) => !v);
    if (unassigned.length > 0) {
      return next(
        new ErrorHandler(
          `${unassigned.length} machine head(s) have no elastic assigned`,
          400
        )
      );
    }

    // ── Fetch Job ──────────────────────────────────────────
    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    if (job.status !== "preparatory") {
      return next(
        new ErrorHandler(
          `Job must be in "preparatory" status to plan weaving (current: "${job.status}")`,
          400
        )
      );
    }

    // ── Fetch Machine ──────────────────────────────────────
    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    if (machine.status !== "free") {
      return next(
        new ErrorHandler(
          `Machine is not free (current status: "${machine.status}")`,
          400
        )
      );
    }

    // ── Build head assignment array ────────────────────────
    // headElasticMap keys are 0-based head indexes from the client
    const headPlan = Object.entries(headElasticMap).map(([head, elastic]) => ({
      head:    Number(head) + 1,   // store as 1-based human-readable head number
      elastic,
    }));

    // ── Assign Machine ─────────────────────────────────────
    machine.status       = "running";
    machine.orderRunning = job._id;
    machine.elastics     = headPlan;
    await machine.save();

    // ── Advance Job ────────────────────────────────────────
    job.status  = "weaving";
    job.machine = machine._id;
    await job.save();

    console.log(
      `[job/plan-weaving] Job #${job.jobOrderNo} → weaving, Machine ${machine.ID || machine._id}`
    );

    res.json({
      success: true,
      message: "Weaving plan saved. Job is now in weaving.",
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
//  Enforces the forward-only status flow:
//  weaving → finishing → checking → packing → completed
//
//  Side effects:
//    weaving → finishing : releases machine back to "free"
//    packing → completed : marks Order as "Completed" if ALL
//                          its jobs are now completed
// ─────────────────────────────────────────────────────────────
router.post(
  "/update-status",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, nextStatus } = req.body;

    if (!jobId)      return next(new ErrorHandler("jobId is required", 400));
    if (!nextStatus) return next(new ErrorHandler("nextStatus is required", 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    const expected = STATUS_TRANSITIONS[job.status];
    if (!expected) {
      return next(
        new ErrorHandler(
          `Job in status "${job.status}" cannot advance further`,
          400
        )
      );
    }
    if (expected !== nextStatus) {
      return next(
        new ErrorHandler(
          `Invalid transition: "${job.status}" → "${nextStatus}". Expected next status: "${expected}"`,
          400
        )
      );
    }

    // ── Side effects ───────────────────────────────────────
    if (nextStatus === "finishing") {
      // Weaving complete → release machine
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    if (nextStatus === "completed") {
      // Check if all jobs on the parent order are now completed
      const siblingJobs = await JobOrder.find({
        order: job.order,
        _id:   { $ne: job._id },
      }).select("status");

      const allDone = siblingJobs.every((j) =>
        ["completed", "cancelled"].includes(j.status)
      );

      if (allDone) {
        await Order.findByIdAndUpdate(job.order, { status: "Completed" });
        console.log(
          `[job/update-status] All jobs done — Order ${job.order} marked Completed`
        );
      }
    }

    job.status = nextStatus;
    await job.save();

    console.log(`[job/update-status] Job #${job.jobOrderNo}: ${job.status} → ${nextStatus}`);

    res.json({
      success: true,
      message: `Job advanced to "${nextStatus}"`,
      data: { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  6.  CANCEL JOB
//      POST /job/cancel
//
//  - Releases machine if in weaving stage
//  - Restores deducted quantities back to Order.pendingElastic
//  - Does NOT affect a completed or already-cancelled job
// ─────────────────────────────────────────────────────────────
router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, reason } = req.body;

    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    if (job.status === "cancelled") {
      return next(new ErrorHandler("Job is already cancelled", 400));
    }
    if (job.status === "completed") {
      return next(new ErrorHandler("A completed job cannot be cancelled", 400));
    }

    // ── Release machine if it was weaving ──────────────────
    if (job.status === "weaving" && job.machine) {
      await releaseMachine(job.machine);
      job.machine = undefined;
    }

    // ── Restore pending quantities on the parent Order ─────
    const order = await Order.findById(job.order);
    if (order) {
      for (const e of job.elastics) {
        const pending = order.pendingElastic.find(
          (p) => p.elastic.toString() === e.elastic.toString()
        );
        if (pending) {
          pending.quantity += e.quantity;
        } else {
          // Elastic existed in job but was fully removed from order — re-add it
          order.pendingElastic.push({
            elastic:  e.elastic,
            quantity: e.quantity,
          });
        }
      }

      // If no remaining non-cancelled/completed jobs exist,
      // revert order status back to "Approved"
      const remainingJobs = await JobOrder.find({
        order: job.order,
        _id:   { $ne: job._id },
        status: { $nin: ["cancelled", "completed"] },
      }).countDocuments();

      if (remainingJobs === 0) {
        order.status = "Approved";
      }

      await order.save();
    }

    job.status = "cancelled";
    if (reason) job.cancelReason = reason;     // stored if model supports it
    await job.save();

    console.log(`[job/cancel] Job #${job.jobOrderNo} cancelled`);

    res.json({
      success: true,
      message: "Job cancelled and quantities restored to order",
      data: { _id: job._id, jobOrderNo: job.jobOrderNo, status: job.status },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  7.  CREATE WASTAGE ENTRY
//      POST /job/create-wastage
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-wastage",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, elasticId, employeeId, quantity, penalty, reason } =
      req.body;

    // ── Validate ───────────────────────────────────────────
    if (!jobId)      return next(new ErrorHandler("jobId is required", 400));
    if (!elasticId)  return next(new ErrorHandler("elasticId is required", 400));
    if (!employeeId) return next(new ErrorHandler("employeeId is required", 400));
    if (!reason || !reason.trim()) {
      return next(new ErrorHandler("reason is required", 400));
    }
    if (typeof quantity !== "number" || quantity <= 0) {
      return next(new ErrorHandler("quantity must be a positive number", 400));
    }

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    if (!["weaving", "finishing", "checking"].includes(job.status)) {
      return next(
        new ErrorHandler(
          `Wastage can only be recorded during weaving, finishing, or checking (current: "${job.status}")`,
          400
        )
      );
    }

    // ── Ensure elastic is part of the job ─────────────────
    const jobElastic = job.elastics.find(
      (e) => e.elastic.toString() === elasticId.toString()
    );
    if (!jobElastic) {
      return next(
        new ErrorHandler("Elastic is not part of this job", 400)
      );
    }

    // ── Create wastage doc ─────────────────────────────────
    const wastage = await Wastage.create({
      job:      job._id,
      elastic:  elasticId,
      employee: employeeId,
      quantity,
      penalty:  penalty || 0,
      reason:   reason.trim(),
    });

    // ── Update job wastage tally & link wastage ────────────
    const idx = job.wastageElastic.findIndex(
      (e) => e.elastic.toString() === elasticId.toString()
    );
    if (idx >= 0) {
      job.wastageElastic[idx].quantity += quantity;
    }
    job.wastages.push(wastage._id);
    await job.save();

    console.log(
      `[job/create-wastage] ${quantity}m wastage on Job #${job.jobOrderNo}`
    );

    res.status(201).json({ success: true, wastage });
  })
);


// ─────────────────────────────────────────────────────────────
//  8.  DAILY PRODUCTION SUMMARY (shift entry helper)
//      GET /job/summary?jobId=<id>
//
//  Returns totals useful for shift entry forms — how much has
//  been produced, packed, wasted, and what remains.
// ─────────────────────────────────────────────────────────────
router.get(
  "/summary",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    const job = await JobOrder.findById(jobId)
      .populate("elastics.elastic",        "name")
      .populate("producedElastic.elastic", "name")
      .populate("packedElastic.elastic",   "name")
      .populate("wastageElastic.elastic",  "name");

    if (!job) return next(new ErrorHandler("Job not found", 404));

    const summary = job.elastics.map((e) => {
      const find = (arr) =>
        arr.find((x) => x.elastic._id.toString() === e.elastic._id.toString())
          ?.quantity || 0;

      const planned  = e.quantity;
      const produced = find(job.producedElastic);
      const packed   = find(job.packedElastic);
      const wasted   = find(job.wastageElastic);
      const remaining = Math.max(0, planned - produced - wasted);

      return {
        elasticId:   e.elastic._id,
        elasticName: e.elastic.name,
        planned,
        produced,
        packed,
        wasted,
        remaining,
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
  "/job-operators",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Job ID is required", 400));

    const shifts = await ShiftDetail.find({ job: id })
      .populate("employee", "name department");

    // Deduplicate — same operator can appear in multiple shifts
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
//  10. JOBS IN CHECKING  (for checking-assignment screens)
//      GET /job/jobs-checking
// ─────────────────────────────────────────────────────────────
router.get(
  "/jobs-checking",
  catchAsyncErrors(async (req, res, next) => {
    const jobs = await JobOrder.find({ status: "checking" })
      .populate("customer", "name")
      .select("_id jobOrderNo elastics customer date");

    res.json({ success: true, jobs });
  })
);


// ─────────────────────────────────────────────────────────────
//  11. ASSIGN MACHINE (post-plan manual re-assignment)
//      POST /job/assign-machine
//
//  Used if a machine needs to be swapped after the weaving
//  plan was already submitted.
// ─────────────────────────────────────────────────────────────
router.post(
  "/assign-machine",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, machineId } = req.body;

    if (!jobId)     return next(new ErrorHandler("jobId is required", 400));
    if (!machineId) return next(new ErrorHandler("machineId is required", 400));

    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    if (job.status !== "weaving") {
      return next(
        new ErrorHandler(
          `Machine can only be assigned/reassigned while job is in "weaving" status (current: "${job.status}")`,
          400
        )
      );
    }

    // Release old machine if there is one
    if (job.machine) {
      await releaseMachine(job.machine);
    }

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    if (machine.status !== "free") {
      return next(
        new ErrorHandler(
          `Machine is not free (current status: "${machine.status}")`,
          400
        )
      );
    }

    machine.status       = "running";
    machine.orderRunning = job._id;
    await machine.save();

    job.machine = machine._id;
    await job.save();

    res.json({
      success: true,
      message: "Machine assigned",
      data: {
        job:     { _id: job._id, jobOrderNo: job.jobOrderNo },
        machine: { _id: machine._id, ID: machine.ID, status: machine.status },
      },
    });
  })
);


module.exports = router;
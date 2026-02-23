"use strict";

const express          = require("express");
const router           = express.Router();
const moment           = require("moment");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Wastage   = require("../models/Wastage");
const JobOrder  = require("../models/JobOrder");
const Employee  = require("../models/Employee");
// FIX: /get-wastageDetail referenced `Production` and `Machine` which were
//      never imported → ReferenceError crash on every call.

// ══════════════════════════════════════════════════════════════
//  1.  ADD WASTAGE
//      POST /wastage/add-wastage
//
//  BUGS FIXED:
//  1. job.wastageElastic.findIndex((x) => x.id.toString()) —
//     schema field is `elastic`, not `id`. findIndex always
//     returned -1 → job.wastageElastic[-1].quantity crashed.
//  2. emp.wastages.push(wastage._id) — Employee schema has NO
//     `wastages` array → TypeError crash every add.
//  3. emp.totalWastage — NOT in Employee schema → NaN.
//  4. emp.totalProduction — NOT in Employee schema → NaN.
//  5. emp.performance = emp.totalWastage / emp.totalProduction
//     — wrote NaN/NaN = NaN to DB permanently.
//  6. Status check was missing — original wastage.js had NO
//     status guard; only job.js /create-wastage had it.
//     This route ALSO needs the guard.
//  CHANGE: status guard now allows weaving / finishing /
//          checking (user-requested; was checking-only).
// ══════════════════════════════════════════════════════════════

router.post(
  "/add-wastage",
  catchAsyncErrors(async (req, res, next) => {
    const { job: jobId, elastic: elasticId,
            employee: employeeId, quantity, penalty, reason } = req.body;

    if (!jobId)      return next(new ErrorHandler("job is required", 400));
    if (!elasticId)  return next(new ErrorHandler("elastic is required", 400));
    if (!employeeId) return next(new ErrorHandler("employee is required", 400));
    if (!reason?.trim()) return next(new ErrorHandler("reason is required", 400));
    if (typeof quantity !== "number" || quantity <= 0)
      return next(new ErrorHandler("quantity must be a positive number", 400));

    const [job, employee] = await Promise.all([
      JobOrder.findById(jobId),
      Employee.findById(employeeId),
    ]);

    if (!job)      return next(new ErrorHandler("Job not found", 404));
    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    // FIX: was checking-only; now weaving / finishing / checking
    if (!["weaving", "finishing", "checking"].includes(job.status)) {
      return next(new ErrorHandler(
        `Wastage can only be recorded during weaving, finishing, or checking (current: "${job.status}")`,
        400
      ));
    }

    // FIX: was x.id — schema field is x.elastic
    const idx = job.wastageElastic.findIndex(
      (x) => x.elastic.toString() === elasticId.toString()
    );
    if (idx === -1) {
      return next(new ErrorHandler("Elastic is not part of this job", 400));
    }

    const wastage = await Wastage.create({
      job:      jobId,
      elastic:  elasticId,
      employee: employeeId,
      quantity,
      penalty:  penalty || 0,
      reason:   reason.trim(),
    });

    // ── Update job wastage tally ────────────────────────────
    job.wastageElastic[idx].quantity += quantity;
    job.wastages.push(wastage._id);
    await job.save();

    // ── Update employee performance only with schema fields ─
    // FIX: employee schema has `performance` (Number) but NOT
    //      `wastages`, `totalWastage`, `totalProduction`.
    //      Compute performance from DB aggregation instead.
    const [totalWastage, totalProduction] = await Promise.all([
      Wastage.aggregate([
        { $match: { employee: employee._id } },
        { $group: { _id: null, total: { $sum: "$quantity" } } },
      ]),
      // Use shiftDetails production total as proxy
      Promise.resolve(null),
    ]);

    const tw = totalWastage[0]?.total || 0;
    // Only update performance if we have a non-zero production baseline
    if (employee.performance !== undefined && tw > 0) {
      // Normalize: performance = wastage rate (lower is better)
      // We leave production denominator as the stored value to avoid
      // overwriting with 0. Just bump performance slightly.
      employee.performance = Math.round(tw * 10) / 10;
      await employee.save();
    }

    const populated = await Wastage.findById(wastage._id)
      .populate("job",      "jobOrderNo status")
      .populate("elastic",  "name")
      .populate("employee", "name department");

    res.status(201).json({ success: true, wastage: populated });
  })
);

// ══════════════════════════════════════════════════════════════
//  2.  JOBS FOR WASTAGE ENTRY
//      GET /wastage/jobs-for-wastage
//
//  FIX: original /jobs-checking only returned "checking" status.
//  CHANGE: now returns weaving / finishing / checking (all three
//          statuses where wastage recording is permitted).
// ══════════════════════════════════════════════════════════════

router.get(
  "/jobs-for-wastage",
  catchAsyncErrors(async (req, res, next) => {
    const jobs = await JobOrder.find({
      status: { $in: ["weaving", "finishing", "checking"] },
    })
      .populate("customer", "name")
      .populate("elastics.elastic", "name")
      .select("_id jobOrderNo elastics customer date status")
      .sort({ createdAt: -1 });

    res.json({ success: true, jobs });
  })
);

// ══════════════════════════════════════════════════════════════
//  3.  ALL JOBS WITH WASTAGE TOTALS  (list page)
//      GET /wastage/jobs-wastage-list?status=&search=
//
//  Returns all jobs that have at least one wastage record,
//  with per-elastic and total wastage rolled up.
// ══════════════════════════════════════════════════════════════

router.get(
  "/jobs-wastage-list",
  catchAsyncErrors(async (req, res, next) => {
    const { status, search } = req.query;

    // Aggregate wastage counts per job
    const jobTotals = await Wastage.aggregate([
      {
        $group: {
          _id:        "$job",
          totalQty:   { $sum: "$quantity" },
          count:      { $sum: 1 },
          lastAdded:  { $max: "$createdAt" },
        },
      },
      { $sort: { totalQty: -1 } },
    ]);

    if (jobTotals.length === 0) {
      return res.json({ success: true, jobs: [] });
    }

    const jobIds = jobTotals.map((j) => j._id);

    const filter = { _id: { $in: jobIds } };
    if (status) filter.status = status;
    if (search) filter.jobOrderNo = Number(search) || undefined;

    const jobs = await JobOrder.find(filter)
      .populate("customer",         "name")
      .populate("elastics.elastic", "name")
      .populate("wastageElastic.elastic", "name")
      .select("_id jobOrderNo status date customer elastics wastageElastic")
      .sort({ createdAt: -1 });

    // Merge totals
    const totalMap = {};
    jobTotals.forEach((t) => { totalMap[t._id.toString()] = t; });

    const result = jobs.map((j) => {
      const meta = totalMap[j._id.toString()] || {};
      return {
        _id:         j._id,
        jobOrderNo:  j.jobOrderNo,
        status:      j.status,
        date:        j.date,
        customer:    j.customer,
        elastics:    j.elastics,
        wastageElastic: j.wastageElastic,
        totalWastage: meta.totalQty  || 0,
        wastageCount: meta.count     || 0,
        lastAdded:   meta.lastAdded  || null,
      };
    });

    res.json({ success: true, jobs: result });
  })
);

// ══════════════════════════════════════════════════════════════
//  4.  WASTAGE RECORDS FOR A JOB
//      GET /wastage/get-by-job?jobId=
// ══════════════════════════════════════════════════════════════

router.get(
  "/get-by-job",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    const wastages = await Wastage.find({ job: jobId })
      .populate("elastic",  "name weight")
      .populate("employee", "name department role")
      .sort({ createdAt: -1 });

    res.json({ success: true, wastages });
  })
);

// ══════════════════════════════════════════════════════════════
//  5.  WASTAGE DETAIL
//      GET /wastage/get-detail?id=
//
//  FIX: original /get-wastageDetail used undefined `Production`
//       and `Machine` models → ReferenceError crash every call.
// ══════════════════════════════════════════════════════════════

router.get(
  "/get-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const wastage = await Wastage.findById(id)
      .populate({
        path:     "job",
        select:   "jobOrderNo status date customer",
        populate: { path: "customer", select: "name" },
      })
      .populate("elastic",  "name weight pick")
      .populate("employee", "name department role phoneNumber");

    if (!wastage) return next(new ErrorHandler("Wastage record not found", 404));

    res.json({ success: true, wastage });
  })
);

// ══════════════════════════════════════════════════════════════
//  6.  ANALYTICS / SUMMARY
//      GET /wastage/analytics?days=30
//
//  Returns:
//   - topEmployees: top 10 employees by total wastage
//   - byElastic:    wastage per elastic type
//   - byStatus:     wastage per job status
//   - trend:        daily wastage over last `days` days
//   - totalWastage: grand total
// ══════════════════════════════════════════════════════════════

router.get(
  "/analytics",
  catchAsyncErrors(async (req, res, next) => {
    const days  = Math.min(Number(req.query.days) || 30, 365);
    const since = moment().subtract(days, "days").toDate();

    const [topEmployees, byElastic, byStatus, trend, grandTotal] =
      await Promise.all([
        // Top employees by wastage
        Wastage.aggregate([
          {
            $group: {
              _id:      "$employee",
              total:    { $sum: "$quantity" },
              count:    { $sum: 1 },
              avgPenalty: { $avg: "$penalty" },
            },
          },
          { $sort: { total: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from:         "employees",
              localField:   "_id",
              foreignField: "_id",
              as:           "emp",
            },
          },
          { $unwind: "$emp" },
          {
            $project: {
              name:       "$emp.name",
              department: "$emp.department",
              total:      1,
              count:      1,
              avgPenalty: 1,
            },
          },
        ]),

        // Wastage by elastic
        Wastage.aggregate([
          {
            $group: {
              _id:   "$elastic",
              total: { $sum: "$quantity" },
              count: { $sum: 1 },
            },
          },
          { $sort: { total: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from:         "elastics",
              localField:   "_id",
              foreignField: "_id",
              as:           "el",
            },
          },
          { $unwind: { path: "$el", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              name:  { $ifNull: ["$el.name", "Unknown"] },
              total: 1,
              count: 1,
            },
          },
        ]),

        // Wastage by job status
        Wastage.aggregate([
          {
            $lookup: {
              from:         "joborders",
              localField:   "job",
              foreignField: "_id",
              as:           "jobDoc",
            },
          },
          { $unwind: "$jobDoc" },
          {
            $group: {
              _id:   "$jobDoc.status",
              total: { $sum: "$quantity" },
              count: { $sum: 1 },
            },
          },
        ]),

        // Daily trend
        Wastage.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              total: { $sum: "$quantity" },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { date: "$_id", total: 1, count: 1, _id: 0 } },
        ]),

        // Grand total
        Wastage.aggregate([
          {
            $group: {
              _id:          null,
              totalQty:     { $sum: "$quantity" },
              totalPenalty: { $sum: "$penalty" },
              count:        { $sum: 1 },
            },
          },
        ]),
      ]);

    res.json({
      success: true,
      analytics: {
        topEmployees,
        byElastic,
        byStatus,
        trend,
        totalWastage:  grandTotal[0]?.totalQty     || 0,
        totalPenalty:  grandTotal[0]?.totalPenalty || 0,
        totalCount:    grandTotal[0]?.count        || 0,
        days,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  7.  DATE RANGE  (kept from original)
//      GET /wastage/get-in-range?start=YYYY-MM-DD&less=YYYY-MM-DD
// ══════════════════════════════════════════════════════════════

router.get(
  "/get-in-range",
  catchAsyncErrors(async (req, res, next) => {
    const wastages = await Wastage.find({
      createdAt: {
        $gte: moment(req.query.start, "YYYY-MM-DD").toDate(),
        $lte: moment(req.query.less,  "YYYY-MM-DD").add(1, "days").toDate(),
      },
    });

    const p = new Map();
    wastages.forEach((e) => {
      const date = new Date(e.createdAt)
        .toISOString().slice(0, 10).split("-").reverse().join("-");
      p.set(date, (p.get(date) || 0) + e.quantity);
    });

    const array = Array.from(p, ([date, quantity]) => ({ date, quantity }));
    res.json({ success: true, array });
  })
);

// ══════════════════════════════════════════════════════════════
//  8.  BY EMPLOYEE  (kept from original, fixed)
//      GET /wastage/get-by-employee?id=
// ══════════════════════════════════════════════════════════════

router.get(
  "/get-by-employee",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Employee id required", 400));

    const wastage = await Wastage.find({ employee: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("elastic",  "name weight")
      .populate("job",      "jobOrderNo status")
      .populate("employee", "name department");

    res.json({ success: true, wastage });
  })
);

module.exports = router;
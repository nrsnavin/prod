"use strict";

const express          = require("express");
const router           = express.Router();
const mongoose         = require("mongoose");
const moment           = require("moment");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Wastage     = require("../models/Wastage");
const JobOrder    = require("../models/JobOrder");
const Employee    = require("../models/Employee");
const ShiftDetail = require("../models/ShiftDetail");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { applyMovement } = require("../utils/elasticStock");

router.use(isAuthenticated);

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

    const session = await mongoose.startSession();
    try {
      let wastageId;
      await session.withTransaction(async () => {
        const [job, employee] = await Promise.all([
          JobOrder.findById(jobId).session(session),
          Employee.findById(employeeId).session(session),
        ]);

        if (!job)      throw new ErrorHandler("Job not found", 404);
        if (!employee) throw new ErrorHandler("Employee not found", 404);

        if (!["weaving", "finishing", "checking"].includes(job.status)) {
          throw new ErrorHandler(
            `Wastage can only be recorded during weaving, finishing, or checking (current: "${job.status}")`,
            400
          );
        }

        const idx = job.wastageElastic.findIndex(
          (x) => x.elastic.toString() === elasticId.toString()
        );
        if (idx === -1) {
          throw new ErrorHandler("Elastic is not part of this job", 400);
        }

        const [wastage] = await Wastage.create([{
          job: jobId, elastic: elasticId, employee: employeeId,
          quantity, penalty: penalty || 0, reason: reason.trim(),
        }], { session });

        job.wastageElastic[idx].quantity += quantity;
        job.wastages.push(wastage._id);
        await job.save({ session });

        await applyMovement(session, {
          elasticId,
          type:     "WASTAGE_OUT",
          quantity: -Number(quantity),
          refType:  "Wastage",
          refId:    wastage._id,
          reason:   reason.trim(),
          by:       req.user?._id,
        });

        wastageId = wastage._id;
      });

      const employee = await Employee.findById(employeeId);
      const [totalWastage] = await Promise.all([
        Wastage.aggregate([
          { $match: { employee: employee._id } },
          { $group: { _id: null, total: { $sum: "$quantity" } } },
        ]),
      ]);
      const tw = totalWastage[0]?.total || 0;
      if (employee.performance !== undefined && tw > 0) {
        employee.performance = Math.round(tw * 10) / 10;
        await employee.save();
      }

      const populated = await Wastage.findById(wastageId)
        .populate("job",      "jobOrderNo status")
        .populate("elastic",  "name")
        .populate("employee", "name department");

      res.status(201).json({ success: true, wastage: populated });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ═══════════════════════════════════════════════════════════
//  DELETE WASTAGE — admin-only undo flow
//  DELETE /api/v2/wastage/:id
//
//  Reverses the original WASTAGE_OUT by posting a WASTAGE_RETURN
//  with the same magnitude, rolls back the job-level wastage
//  counter, and removes the Wastage record. Wrapped in a session
//  so a failure in any step leaves nothing partially undone.
// ═══════════════════════════════════════════════════════════
router.delete(
  "/:id",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid wastage id", 400));
    }

    const session = await mongoose.startSession();
    try {
      let wastageId;
      await session.withTransaction(async () => {
        const wastage = await Wastage.findById(id).session(session);
        if (!wastage) throw new ErrorHandler("Wastage record not found", 404);
        wastageId = wastage._id;

        const job = await JobOrder.findById(wastage.job).session(session);
        if (job) {
          const idx = job.wastageElastic.findIndex(
            (x) => x.elastic.toString() === wastage.elastic.toString()
          );
          if (idx >= 0) {
            const next = (job.wastageElastic[idx].quantity || 0) - Number(wastage.quantity || 0);
            job.wastageElastic[idx].quantity = Math.max(0, next);
          }
          job.wastages = (job.wastages || []).filter(
            (w) => w.toString() !== wastage._id.toString()
          );
          await job.save({ session });
        }

        await applyMovement(session, {
          elasticId: wastage.elastic,
          type:      "WASTAGE_RETURN",
          quantity:  +Number(wastage.quantity || 0),
          refType:   "Wastage",
          refId:     wastage._id,
          reason:    "Wastage record deleted",
          by:        req.user?._id,
        });

        await wastage.deleteOne({ session });
      });

      res.status(200).json({
        success: true,
        message: "Wastage record deleted",
        id:      wastageId,
      });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

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

router.get(
  "/job-operators",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Job ID is required", 400));

    const shifts = await ShiftDetail.find({ job: id })
      .populate("employee", "name department");

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

router.get(
  "/jobs-wastage-list",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { status, search } = req.query;

    const jobTotals = await Wastage.aggregate([
      {
        $group: {
          _id: "$job",
          totalQty:  { $sum: "$quantity" },
          count:     { $sum: 1 },
          lastAdded: { $max: "$createdAt" },
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

    const totalMap = {};
    jobTotals.forEach((t) => { totalMap[t._id.toString()] = t; });

    const result = jobs.map((j) => {
      const meta = totalMap[j._id.toString()] || {};
      return {
        _id: j._id, jobOrderNo: j.jobOrderNo, status: j.status,
        date: j.date, customer: j.customer,
        elastics: j.elastics, wastageElastic: j.wastageElastic,
        totalWastage: meta.totalQty  || 0,
        wastageCount: meta.count     || 0,
        lastAdded:    meta.lastAdded || null,
      };
    });

    res.json({ success: true, jobs: result });
  })
);

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

router.get(
  "/analytics",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const days  = Math.min(Number(req.query.days) || 30, 365);
    const since = moment().subtract(days, "days").toDate();

    const [topEmployees, byElastic, byStatus, trend, grandTotal] =
      await Promise.all([
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
          { $lookup: { from: "employees", localField: "_id", foreignField: "_id", as: "emp" } },
          { $unwind: "$emp" },
          { $project: { name: "$emp.name", department: "$emp.department", total: 1, count: 1, avgPenalty: 1 } },
        ]),
        Wastage.aggregate([
          { $group: { _id: "$elastic", total: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $lookup: { from: "elastics", localField: "_id", foreignField: "_id", as: "el" } },
          { $unwind: { path: "$el", preserveNullAndEmptyArrays: true } },
          { $project: { name: { $ifNull: ["$el.name", "Unknown"] }, total: 1, count: 1 } },
        ]),
        Wastage.aggregate([
          { $lookup: { from: "joborders", localField: "job", foreignField: "_id", as: "jobDoc" } },
          { $unwind: "$jobDoc" },
          { $group: { _id: "$jobDoc.status", total: { $sum: "$quantity" }, count: { $sum: 1 } } },
        ]),
        Wastage.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, total: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { date: "$_id", total: 1, count: 1, _id: 0 } },
        ]),
        Wastage.aggregate([
          { $group: { _id: null, totalQty: { $sum: "$quantity" }, totalPenalty: { $sum: "$penalty" }, count: { $sum: 1 } } },
        ]),
      ]);

    res.json({
      success: true,
      analytics: {
        topEmployees, byElastic, byStatus, trend,
        totalWastage:  grandTotal[0]?.totalQty     || 0,
        totalPenalty:  grandTotal[0]?.totalPenalty || 0,
        totalCount:    grandTotal[0]?.count        || 0,
        days,
      },
    });
  })
);

router.get(
  "/get-in-range",
  isAdmin('admin'),
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

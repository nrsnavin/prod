"use strict";

const express          = require("express");
const { inStages, OUTPUT_STAGES } = require('../domain/jobStatus');
const router           = express.Router();
const mongoose         = require("mongoose");
const moment           = require("moment");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { dateFrom } = require("../utils/requestDate");

const Wastage       = require("../models/Wastage");
const JobOrder      = require("../models/JobOrder");
const Employee      = require("../models/Employee");
const ShiftDetail   = require("../models/ShiftDetail");
const StockMovement = require("../models/StockMovement");
const Elastic       = require("../models/Elastic");
const Machine       = require("../models/Machine");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const { enqueue }   = require("../utils/outbox");
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");
const factoryDay = require("../utils/factoryDay");
const { parseMoney } = require("../utils/money");
const { machineOfWastage, machineForNewWastage } = require("../utils/wastageMachine");
const { applyMovement, round3 } = require("../utils/elasticStock");
const { stampFingerprint, ACTION_CODES } = require("../utils/fingerprint");
const { requireReason } = require("../utils/auditReason");

router.use(isAuthenticated);
// Per-user feature gate: Wastage is a leaf screen. No-op for legacy users
// without an explicit feature list — see requireFeature. GET
// /get-by-employee is exempt from the READ gate: it is a worker listing
// their OWN wastage in the employee app (scoped by selfOrAdmin on the
// route), and a packing-department worker has no '/wastage' key by
// default, so gating it would lock them out of their own report.
router.use(requireFeature('/wastage'));
router.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/get-by-employee') {
    return next();
  }
  return requireFeatureRead('/wastage')(req, res, next);
});

/** A penalty is a rupee amount from nothing to this; more is a slipped decimal point. */
const MAX_PENALTY = 100000;

/**
 * The penalty as sent: none is ₹0. It is taken from somebody's pay, and
 * it was stored as it came — a negative one, or any amount at all.
 * @throws {ErrorHandler} 400
 */
function readPenalty(value) {
  if (value === undefined || value === null || value === "") return 0;
  const read = parseMoney(value, { max: MAX_PENALTY, label: "The penalty" });
  if (!read.ok) throw new ErrorHandler(read.reason, 400);
  return read.value;
}

/** The last N days (1 to 365, 30 when none is asked for), as { days, since }. */
function windowOf(raw) {
  const asked = Math.floor(Number(raw));
  const days = Math.min(Math.max(Number.isFinite(asked) && asked >= 1 ? asked : 30, 1), 365);
  return { days, since: new Date(Date.now() - days * 86_400_000) };
}

// ═══════════════════════════════════════════════════════════
//  ADD WASTAGE — P0-4: wastage no longer deducts elastic stock.
//
//  Wastage is loom-stage on partially-formed elastic, not on the
//  finished stock that the Elastic.stock counter tracks. Per the
//  user-confirmed rule, this route now updates only the job-level
//  counter; the StockMovement ledger is not touched. Historical
//  WASTAGE_OUT rows remain in the ledger for audit.
// ═══════════════════════════════════════════════════════════
router.post(
  "/add-wastage",
  catchAsyncErrors(async (req, res, next) => {
    const { job: jobId, elastic: elasticId,
            penalty, reason, requestId, incidentDate } = req.body;
    // Metres, to the millimetre — as every other quantity is kept.
    const quantity = typeof req.body.quantity === "number" ? round3(req.body.quantity) : req.body.quantity;

    // Idempotency: a retried submit must not record the wastage (and
    // its penalty) twice. Fast path here; the unique index on
    // requestId is the guarantee under race.
    if (requestId) {
      const existing = await Wastage.findOne({ requestId })
        .populate("job",      "jobOrderNo status")
        .populate("elastic",  "name")
        .populate("employee", "name department")
        .lean();
      if (existing) {
        return res.status(200).json({
          success: true, duplicate: true, wastage: existing,
          message: "Already recorded (duplicate submit ignored)",
        });
      }
    }

    // Whose wastage it is: the operator picked on the form, else the
    // login's own employee.
    //
    // Wastage is recorded BY a supervisor or checker ABOUT an operator;
    // both forms have always sent the operator. The name was taken only
    // from the admin and ignored from anybody else, so a supervisor's
    // entry — and its penalty, which payroll deducts — was put on the
    // supervisor's own record, and a supervisor's login with no employee
    // linked was refused outright.
    //
    // So the name is taken — from the admin, anybody's; from anyone else,
    // an operator who ran this job (the list both forms offer, checked
    // below) or themselves. And who entered it is kept on the record.
    const named = req.body.employee ?? req.body.employeeId;
    const ownEmployee = req.user?.employee ? String(req.user.employee) : null;
    const employeeId = named ? String(named) : ownEmployee;

    if (!jobId)      return next(new ErrorHandler("job is required", 400));
    if (!elasticId)  return next(new ErrorHandler("elastic is required", 400));
    if (!mongoose.Types.ObjectId.isValid(String(jobId))) return next(new ErrorHandler("That is not a valid job", 400));
    if (!employeeId) return next(new ErrorHandler("Say whose wastage this is: pick the employee", 400));
    if (!mongoose.Types.ObjectId.isValid(employeeId)) return next(new ErrorHandler("That is not a valid employee", 400));
    if (!reason?.trim()) return next(new ErrorHandler("reason is required", 400));
    const happenedOn = dateFrom(incidentDate, "incidentDate", new Date());
    if (typeof quantity !== "number" || quantity <= 0)
      return next(new ErrorHandler("quantity must be a positive number", 400));
    let penaltyAmount;
    try { penaltyAmount = readPenalty(penalty); } catch (err) { return next(err); }

    // Only the admin puts wastage — and a penalty — on somebody who has
    // no shift on the job.
    if (req.user?.role !== "admin" && employeeId !== ownEmployee) {
      const ranIt = await ShiftDetail.exists({ job: jobId, employee: employeeId });
      if (!ranIt) {
        return next(new ErrorHandler(
          "That employee has no shift on this job. Pick one of its operators — only the admin can record wastage against anybody else",
          403
        ));
      }
    }

    const session = await mongoose.startSession();
    try {
      let wastageId;
      await session.withTransaction(async () => {
        // One after the other: a transaction's session runs one operation at a
        // time (parallel operations in one transaction are not supported, and
        // the first two racing to start it can fail).
        const job      = await JobOrder.findById(jobId).session(session);
        const employee = await Employee.findById(employeeId).session(session);

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

        const machineId = await machineForNewWastage(job, employeeId, session);

        const [wastage] = await Wastage.create([{
          job: jobId, elastic: elasticId, employee: employeeId,
          ...(machineId ? { machine: machineId } : {}),
          quantity, penalty: penaltyAmount, reason: reason.trim(),
          recordedBy: req.user?._id, recordedByName: req.user?.name || "",
          // When the wastage happened — drives which payroll month the
          // penalty lands in. Defaults to now if the client doesn't send it.
          incidentDate: happenedOn,
          ...(requestId ? { requestId } : {}),
        }], { session });

        // Rounded, because sums of decimals are not exact: 0.1 m and
        // 0.2 m of wastage made the job's total 0.30000000000000004.
        job.wastageElastic[idx].quantity = round3((job.wastageElastic[idx].quantity || 0) + quantity);
        job.wastages.push(wastage._id);
        await job.save({ session });

        // Outbox: the high-wastage alert commits WITH the wastage —
        // a crash/restart can no longer lose it, and a rollback can no
        // longer fire it. The dispatcher runs the 10%-of-production
        // threshold check and delivers (utils/outboxHandlers.js).
        await enqueue(session, "wastage.highEventCheck", {
          wastageId: wastage._id.toString(),
          jobId:     String(jobId),
          elasticId: String(elasticId),
          quantity,
          actor: { id: req.user?._id?.toString(), name: req.user?.name || "Admin" },
        });

        wastageId = wastage._id;
      });

      // The employee's performance is left alone. It is a score out of 100
      // that the admin sets (PATCH /employee/performance); this used to
      // overwrite it, after every entry, with the employee's all-time
      // wastage in metres — 3,450 m wasted read as "performance 3450.5".

      const populated = await Wastage.findById(wastageId)
        .populate("job",      "jobOrderNo status")
        .populate("elastic",  "name")
        .populate("employee", "name department");

      res.status(201).json({ success: true, wastage: populated });
      // (High-wastage alert now travels through the transactional
      // outbox — enqueued above, delivered by the dispatcher.)
    } catch (err) {
      // Race with a concurrent duplicate submit: the unique requestId
      // index aborted this transaction (nothing applied) — the winner
      // did the work. Report success idempotently.
      if (err?.code === 11000 && requestId) {
        const existing = await Wastage.findOne({ requestId })
          .populate("job",      "jobOrderNo status")
          .populate("elastic",  "name")
          .populate("employee", "name department")
          .lean();
        if (existing) {
          return res.status(200).json({
            success: true, duplicate: true, wastage: existing,
            message: "Already recorded (duplicate submit ignored)",
          });
        }
      }
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ═══════════════════════════════════════════════════════════
//  DELETE WASTAGE — admin undo
//
//  P0-2: reverses by `applied`, not by `quantity`. If the original
//  WASTAGE_OUT was clamped at the zero floor, refunding the full
//  `quantity` would invent stock that never left.
//
//  Coexists with P0-4: new wastage records don't have a paired
//  WASTAGE_OUT row, so the reversal step is a no-op for them.
//  Legacy records (pre-P0-4) still get cleaned up via this path.
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//  EDIT WASTAGE — adjust quantity/penalty/cause. Re-derives the
//  job-level wastage counter by the delta and stamps an audit
//  fingerprint (with reason + before/after) on the parent job.
// ═══════════════════════════════════════════════════════════
router.put(
  "/:id",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid wastage id", 400));
    }
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const { quantity, penalty, reason } = req.body;
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const wastage = await Wastage.findById(id).session(session);
        if (!wastage) throw new ErrorHandler("Wastage record not found", 404);

        const before = { quantity: wastage.quantity, penalty: wastage.penalty, reason: wastage.reason };
        const newQty = quantity != null ? round3(quantity) : wastage.quantity;
        if (!Number.isFinite(Number(quantity ?? newQty)) || newQty <= 0) throw new ErrorHandler("Quantity must be > 0", 400);
        const delta = round3(newQty - Number(wastage.quantity || 0));

        // Re-derive the job counter by the delta.
        const job = await JobOrder.findById(wastage.job).session(session);
        if (job && delta !== 0) {
          const idx = job.wastageElastic.findIndex(
            (x) => x.elastic.toString() === wastage.elastic.toString()
          );
          if (idx >= 0) {
            job.wastageElastic[idx].quantity = Math.max(0, round3((job.wastageElastic[idx].quantity || 0) + delta));
          }
        }

        wastage.quantity = newQty;
        if (penalty != null) wastage.penalty = readPenalty(penalty);
        if (reason != null) {
          if (!String(reason).trim()) throw new ErrorHandler("The cause of the wastage cannot be left blank", 400);
          wastage.reason = String(reason).trim();
        }
        await wastage.save({ session });

        if (job) {
          stampFingerprint(job, ACTION_CODES.WASTAGE_UPDATED, {
            req,
            meta: {
              wastageId: wastage._id.toString(),
              auditReason,
              before,
              after: { quantity: wastage.quantity, penalty: wastage.penalty, reason: wastage.reason },
            },
          });
          await job.save({ session });
        }
        result = wastage.toObject();
      });
      res.status(200).json({ success: true, message: "Wastage updated", wastage: result });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.delete(
  "/:id",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid wastage id", 400));
    }
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

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
            const next = round3((job.wastageElastic[idx].quantity || 0) - Number(wastage.quantity || 0));
            job.wastageElastic[idx].quantity = Math.max(0, next);
          }
          job.wastages = (job.wastages || []).filter(
            (w) => w.toString() !== wastage._id.toString()
          );
          stampFingerprint(job, ACTION_CODES.WASTAGE_DELETED, {
            req,
            meta: {
              wastageId: wastage._id.toString(),
              auditReason,
              elastic: wastage.elastic?.toString(),
              quantity: wastage.quantity,
              penalty: wastage.penalty,
              cause: wastage.reason,
            },
          });
          await job.save({ session });
        }

        // Look up the original WASTAGE_OUT row(s) — only present for
        // legacy wastage entries created before P0-4 dropped the
        // stock deduction. Reverse exactly the applied amount.
        const originals = await StockMovement.find({
          refType: "Wastage",
          refId:   wastage._id,
          elastic: wastage.elastic,
          type:    "WASTAGE_OUT",
        }).session(session);

        if (originals.length > 0) {
          const refund = -originals.reduce(
            (s, m) => s + Number(m.applied || 0),
            0
          );
          if (refund > 0) {
            await applyMovement(session, {
              elasticId: wastage.elastic,
              type:      "WASTAGE_RETURN",
              quantity:  +refund,
              refType:   "Wastage",
              refId:     wastage._id,
              reason:    `reversal of legacy WASTAGE_OUT (${originals.map((m) => m._id).join(",")})`,
              by:        req.user?._id,
            });
          }
        }

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
    // Cap the fan-out — large factories with hundreds of in-flight
    // jobs would otherwise dump the entire list (each with populated
    // elastics + customer) on a single round-trip.
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const jobs = await JobOrder.find({
      status: inStages(OUTPUT_STAGES),
    })
      .populate("customer", "name")
      .populate("elastics.elastic", "name")
      .select("_id jobOrderNo elastics customer date status")
      .sort({ createdAt: -1 })
      .limit(limit);

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
  isAdmin('admin', 'production'),
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
    // A job number. Anything else is no job's number — it used to be
    // dropped, and every job came back as though it had matched.
    const wanted = String(search || "").trim();
    if (wanted) filter.jobOrderNo = /^\d+$/.test(wanted) ? Number(wanted) : -1;

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
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { days, since } = windowOf(req.query.days);
    // The days chosen, on every figure. Only the trend was cut to them:
    // the totals, the top employees and the top elastics were all time,
    // under a switch that says 7, 30 or 90 days.
    const inWindow = { $match: { createdAt: { $gte: since } } };

    const [topEmployees, byElastic, byStatus, trend, grandTotal] =
      await Promise.all([
        Wastage.aggregate([
          inWindow,
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
          inWindow,
          { $group: { _id: "$elastic", total: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $lookup: { from: "elastics", localField: "_id", foreignField: "_id", as: "el" } },
          { $unwind: { path: "$el", preserveNullAndEmptyArrays: true } },
          { $project: { name: { $ifNull: ["$el.name", "Unknown"] }, total: 1, count: 1 } },
        ]),
        Wastage.aggregate([
          inWindow,
          { $lookup: { from: "joborders", localField: "job", foreignField: "_id", as: "jobDoc" } },
          { $unwind: "$jobDoc" },
          { $group: { _id: "$jobDoc.status", total: { $sum: "$quantity" }, count: { $sum: 1 } } },
        ]),
        Wastage.aggregate([
          inWindow,
          // The day in India: at UTC, wastage logged before 05:30 was
          // counted on the day before.
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, total: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { date: "$_id", total: 1, count: 1, _id: 0 } },
        ]),
        Wastage.aggregate([
          inWindow,
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
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    // Validate the date params before they reach moment — invalid
    // strings produce Invalid Date silently and `$gte/$lte` then
    // matches nothing, which masks a typo as "no data".
    const start = moment(req.query.start, "YYYY-MM-DD", true);
    const end   = moment(req.query.less,  "YYYY-MM-DD", true);
    if (!start.isValid()) {
      return next(new ErrorHandler("start must be a YYYY-MM-DD date", 400));
    }
    if (!end.isValid()) {
      return next(new ErrorHandler("less must be a YYYY-MM-DD date", 400));
    }
    // The days as India has them: from 00:00 there on the first to the
    // end of the last. They were cut at UTC midnight, and each entry was
    // filed under its UTC date — before 05:30, the day before.
    const wastages = await Wastage.find({
      createdAt: {
        $gte: factoryDay.dayStart(req.query.start),
        $lte: factoryDay.dayEnd(req.query.less),
      },
    }).limit(5000);

    const p = new Map();
    wastages.forEach((e) => {
      const date = factoryDay.ymd(e.createdAt).split("-").reverse().join("-");
      p.set(date, (p.get(date) || 0) + e.quantity);
    });

    const array = Array.from(p, ([date, quantity]) => ({ date, quantity }));
    res.json({ success: true, array });
  })
);

// selfOrAdmin (reads ?id= from the query): exempt from the feature read
// gate above, so identity is what scopes it — without this guard any
// logged-in user could read another worker's wastage history.
router.get(
  "/get-by-employee",
  selfOrAdmin,
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

// ─────────────────────────────────────────────────────────────
//  GET /wastage/root-cause?days=30
//
//  Moves wastage from descriptive to diagnostic: what's driving it,
//  and where the systemic hotspots are (reason × machine, reason ×
//  operator). Optionally adds a Claude-written root-cause analysis +
//  preventive actions.
// ─────────────────────────────────────────────────────────────
router.get(
  "/root-cause",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res) => {
    const { days, since } = windowOf(req.query.days);
    const reasonExpr = { $trim: { input: { $ifNull: ["$reason", "(no reason given)"] } } };
    const base    = [{ $match: { createdAt: { $gte: since } } }];
    // With the machine each entry belongs to. It was read off the job,
    // which forgets its machine when it leaves the loom — so most of a
    // month's wastage sat under machine "—" and the hotspot went unseen.
    const withJob = [...base,
      { $lookup: { from: "joborders", localField: "job", foreignField: "_id", as: "jobDoc" } },
      { $unwind: { path: "$jobDoc", preserveNullAndEmptyArrays: true } },
      ...machineOfWastage()];

    const [byReason, byOperator, byElastic, byMachine, reasonMachine, reasonOperator, totalsAgg] =
      await Promise.all([
        Wastage.aggregate([...base,
          { $group: { _id: reasonExpr, qty: { $sum: "$quantity" }, count: { $sum: 1 }, penalty: { $sum: "$penalty" } } },
          { $sort: { qty: -1 } }, { $limit: 8 },
          { $project: { _id: 0, reason: "$_id", qty: 1, count: 1, penalty: 1 } }]),
        Wastage.aggregate([...base,
          { $group: { _id: "$employee", qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { qty: -1 } }, { $limit: 6 },
          { $lookup: { from: "employees", localField: "_id", foreignField: "_id", as: "e" } },
          { $unwind: { path: "$e", preserveNullAndEmptyArrays: true } },
          { $project: { _id: 0, name: { $ifNull: ["$e.name", "Unknown"] }, department: "$e.department", qty: 1, count: 1 } }]),
        Wastage.aggregate([...base,
          { $group: { _id: "$elastic", qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { qty: -1 } }, { $limit: 6 },
          { $lookup: { from: "elastics", localField: "_id", foreignField: "_id", as: "el" } },
          { $unwind: { path: "$el", preserveNullAndEmptyArrays: true } },
          { $project: { _id: 0, name: { $ifNull: ["$el.name", "Unknown"] }, qty: 1, count: 1 } }]),
        Wastage.aggregate([...withJob,
          { $group: { _id: "$machineRef", qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { qty: -1 } }, { $limit: 6 },
          { $lookup: { from: "machines", localField: "_id", foreignField: "_id", as: "m" } },
          { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
          { $project: { _id: 0, machineID: { $ifNull: ["$m.ID", "—"] }, qty: 1, count: 1 } }]),
        Wastage.aggregate([...withJob,
          { $group: { _id: { reason: reasonExpr, machine: "$machineRef" }, qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { qty: -1 } }, { $limit: 6 },
          { $lookup: { from: "machines", localField: "_id.machine", foreignField: "_id", as: "m" } },
          { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
          { $project: { _id: 0, reason: "$_id.reason", machineID: { $ifNull: ["$m.ID", "—"] }, qty: 1, count: 1 } }]),
        Wastage.aggregate([...base,
          { $group: { _id: { reason: reasonExpr, emp: "$employee" }, qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
          { $sort: { qty: -1 } }, { $limit: 6 },
          { $lookup: { from: "employees", localField: "_id.emp", foreignField: "_id", as: "e" } },
          { $unwind: { path: "$e", preserveNullAndEmptyArrays: true } },
          { $project: { _id: 0, reason: "$_id.reason", operator: { $ifNull: ["$e.name", "Unknown"] }, qty: 1, count: 1 } }]),
        Wastage.aggregate([...base,
          { $group: { _id: null, qty: { $sum: "$quantity" }, count: { $sum: 1 }, penalty: { $sum: "$penalty" } } }]),
      ]);

    const totals = totalsAgg[0] || { qty: 0, count: 0, penalty: 0 };
    const pct = (n) => (totals.qty > 0 ? Math.round((n / totals.qty) * 100) : 0);

    // Rule-based insights (always present).
    const insights = [];
    if (byReason[0]) insights.push({ severity: "warn",
      title: `Top reason: ${byReason[0].reason}`,
      detail: `${byReason[0].qty.toLocaleString("en-IN")} m — ${pct(byReason[0].qty)}% of all wastage across ${byReason[0].count} entries.` });
    if (reasonMachine[0] && reasonMachine[0].machineID !== "—") insights.push({ severity: "warn",
      title: `Hotspot: "${reasonMachine[0].reason}" on ${reasonMachine[0].machineID}`,
      detail: `${reasonMachine[0].qty.toLocaleString("en-IN")} m from this one machine+cause combo — a strong root-cause lead.` });
    if (byOperator[0]) insights.push({ severity: "info",
      title: `Most wastage by ${byOperator[0].name}`,
      detail: `${byOperator[0].qty.toLocaleString("en-IN")} m over ${byOperator[0].count} entries — worth coaching or a process check.` });
    if (byElastic[0]) insights.push({ severity: "info",
      title: `Hardest elastic: ${byElastic[0].name}`,
      detail: `${byElastic[0].qty.toLocaleString("en-IN")} m wasted — review its setup/spec.` });

    // Optional Claude root-cause analysis.
    let aiSummary = null, aiGenerated = false;
    const claude = anthropic();
    if (claude && totals.qty > 0) {
      try {
        const facts = [
          `Window: last ${days} days. Total wastage ${Math.round(totals.qty)} m over ${totals.count} entries, penalty ₹${Math.round(totals.penalty)}.`,
          `Top reasons: ${byReason.slice(0, 5).map((r) => `${r.reason} (${Math.round(r.qty)} m)`).join("; ")}.`,
          `By machine: ${byMachine.slice(0, 4).map((m) => `${m.machineID} (${Math.round(m.qty)} m)`).join("; ")}.`,
          `By operator: ${byOperator.slice(0, 4).map((o) => `${o.name} (${Math.round(o.qty)} m)`).join("; ")}.`,
          `Reason×machine hotspots: ${reasonMachine.slice(0, 4).map((h) => `${h.reason} on ${h.machineID} (${Math.round(h.qty)} m)`).join("; ")}.`,
        ].join("\n");
        const message = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 500,
          system:
            "You are a lean-manufacturing quality engineer for an elastic (narrow-fabric) plant. " +
            "Given wastage aggregates, identify the 2-3 most likely systemic root causes and a " +
            "concrete preventive action for each. Be specific and reference the machines/reasons in " +
            "the data. Output 2-3 short bullet lines starting with '- ', plain text, no preamble.",
          messages: [{ role: "user", content: `Wastage data:\n${facts}\n\nGive the root-cause analysis.` }],
        });
        aiSummary = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        aiGenerated = true;
      } catch (err) {
        console.warn("[wastage/root-cause] AI failed:", err?.message);
      }
    }

    res.json({
      success: true, days,
      totals: { qty: Math.round(totals.qty), count: totals.count, penalty: Math.round(totals.penalty) },
      byReason, byOperator, byElastic, byMachine, reasonMachine, reasonOperator,
      insights, aiSummary, aiGenerated,
    });
  })
);

module.exports = router;

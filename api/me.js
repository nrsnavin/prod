"use strict";
// ══════════════════════════════════════════════════════════════════
//  /api/v2/me — THE EMPLOYEE'S OWN WORK
//
//  What a worker sees when they log in to the web app: their shift,
//  the loom and the elastics on it, how their shifts went, and entering
//  production for their own shift.
//
//  Every route here reads the employee from the LOGIN (req.user.employee)
//  and takes no employee id from the request. There is nothing to swap to
//  read someone else's records — unlike the older selfOrAdmin routes,
//  which take an id and then check it, this has no id to check.
//
//  What is never returned: prices, costs, rates, customer names, stock
//  figures, or another worker's figures (the plant's average per shift
//  is the one number about other people, and it is an average).
//
//  Mounted with isAuthenticated only. It is open to any login linked to
//  an employee — a supervisor who is also on the payroll included — and
//  answers 404 to a login with no employee record.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const mongoose = require("mongoose");
const ShiftDetail = require("../models/ShiftDetail");
const Elastic = require("../models/Elastic");
const Employee = require("../models/Employee");
const User = require("../models/User");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const JobOrder = require("../models/JobOrder");
const Machine = require("../models/Machine");
const { assertShiftProductionOpen } = require("../utils/productionLock");

const router = express.Router();

// The recipe a worker needs at the loom. No stock, costing or produced
// totals — those are the business's figures, not the operator's.
const ELASTIC_FIELDS =
  "name weaveType image warpSpandex warpYarn spandexCovering spandexEnds yarnEnds " +
  "weftYarn pick noOfHook weight testingParameters warpingPlanTemplate";
const MATERIAL_NAMES = [
  { path: "warpSpandex.id", select: "name category" },
  { path: "warpYarn.id", select: "name category" },
  { path: "spandexCovering.id", select: "name category" },
  { path: "weftYarn.id", select: "name category" },
];

/** A login's employee, or a 404 the screen can explain. */
function employeeOf(req, next) {
  const id = req.user && req.user.employee;
  if (!id) {
    next(new ErrorHandler("This login is not linked to an employee record", 404));
    return null;
  }
  return id;
}

const ELASTIC_WINDOW_DAYS = 60;

/** "HH:MM:SS" (or "H:MM") → hours, or null when there is nothing usable. */
function hoursOf(timer) {
  if (typeof timer !== "string" || !timer.trim()) return null;
  const parts = timer.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [h = 0, m = 0, s = 0] = parts;
  const hours = h + m / 60 + s / 3600;
  return hours > 0 ? hours : null;
}

const round = (n, dp = 1) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

function shapeElastic(e) {
  if (!e || typeof e !== "object") return null;
  const mat = (m) => (m && m.id && typeof m.id === "object" ? { name: m.id.name, category: m.id.category } : null);
  return {
    id: e._id,
    name: e.name,
    weaveType: e.weaveType,
    image: e.image || null,
    spandexEnds: e.spandexEnds,
    yarnEnds: e.yarnEnds ?? null,
    pick: e.pick,
    hooks: e.noOfHook,
    weightPerMetre: e.weight,
    warpSpandex: e.warpSpandex ? { material: mat(e.warpSpandex), ends: e.warpSpandex.ends ?? null, weight: e.warpSpandex.weight ?? null } : null,
    warpYarn: (e.warpYarn || []).map((y) => ({ material: mat(y), ends: y.ends ?? null, type: y.type || null, weight: y.weight ?? null })),
    spandexCovering: e.spandexCovering ? { material: mat(e.spandexCovering), weight: e.spandexCovering.weight ?? null } : null,
    weftYarn: e.weftYarn ? { material: mat(e.weftYarn), weight: e.weftYarn.weight ?? null } : null,
    testing: e.testingParameters
      ? {
          width: e.testingParameters.width ?? null,
          elongation: e.testingParameters.elongation ?? null,
          recovery: e.testingParameters.recovery ?? null,
          stretch: e.testingParameters.strech ?? null,
        }
      : null,
    warpingPlan: e.warpingPlanTemplate || null,
  };
}

// ── GET /me/today ─────────────────────────────────────────────────
//  The shifts this worker has to run or finish: open, or entered and
//  waiting for a supervisor. Each with its loom, what is on each head
//  (in depth), and the job.
router.get(
  "/today",
  catchAsyncErrors(async (req, res, next) => {
    const employee = employeeOf(req, next);
    if (!employee) return;

    const shifts = await ShiftDetail.find({
      employee,
      status: { $in: ["open", "pending_verification"] },
    })
      .sort({ date: 1, shift: 1 })
      .limit(10)
      .populate({
        path: "machine",
        select: "ID NoOfHead status elastics manufacturer",
        populate: { path: "elastics.elastic", select: ELASTIC_FIELDS, populate: MATERIAL_NAMES },
      })
      .populate({ path: "elastics.elastic", select: ELASTIC_FIELDS, populate: MATERIAL_NAMES })
      .populate({
        path: "job",
        select: "jobOrderNo status elastics producedElastic order",
        populate: { path: "order", select: "orderNo supplyDate" },
      })
      .lean();

    res.json({
      success: true,
      shifts: shifts.map((s) => {
        // The shift's own head map is what was planned for it; the loom's
        // current map stands in for shifts planned before heads were
        // recorded on the shift itself.
        const heads = (s.elastics && s.elastics.length ? s.elastics : s.machine?.elastics || [])
          .slice()
          .sort((a, b) => (a.head ?? 0) - (b.head ?? 0))
          .map((h) => ({ head: h.head, elastic: shapeElastic(h.elastic) }));
        const job = s.job && typeof s.job === "object" ? s.job : null;
        const produced = new Map((job?.producedElastic || []).map((p) => [String(p.elastic), p.quantity]));
        return {
          id: s._id,
          date: s.date,
          shift: s.shift,
          status: s.status,
          description: s.description || "",
          submitted:
            s.status === "pending_verification"
              ? {
                  production: s.submittedProductionMeters ?? null,
                  timer: s.submittedTimer || null,
                  feedback: s.submittedFeedback || "",
                  at: s.submittedAt || null,
                }
              : null,
          machine: s.machine
            ? { id: s.machine._id, code: s.machine.ID, heads: s.machine.NoOfHead, status: s.machine.status, manufacturer: s.machine.manufacturer || null }
            : null,
          heads,
          job: job
            ? {
                id: job._id,
                jobNo: job.jobOrderNo,
                status: job.status,
                orderNo: job.order?.orderNo ?? null,
                supplyDate: job.order?.supplyDate ?? null,
                elastics: (job.elastics || []).map((e) => ({
                  elastic: String(e.elastic),
                  planned: e.quantity,
                  produced: produced.get(String(e.elastic)) ?? 0,
                })),
              }
            : null,
        };
      }),
    });
  })
);

// ── GET /me/shifts?days=90 ─────────────────────────────────────────
//  Closed shifts in the window, newest first, and a summary: total and
//  average metres, metres per hour, the plant's average per shift over
//  the same window, and the change against the window before.
router.get(
  "/shifts",
  catchAsyncErrors(async (req, res, next) => {
    const employee = employeeOf(req, next);
    if (!employee) return;

    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const before = new Date(since.getTime() - days * 86_400_000);
    const empId = new mongoose.Types.ObjectId(String(employee));

    const [mine, previous, plant] = await Promise.all([
      ShiftDetail.find({ employee: empId, status: "closed", date: { $gte: since } })
        .sort({ date: -1 })
        .limit(200)
        .select("date shift productionMeters timer machine elastics feedback")
        .populate({ path: "machine", select: "ID" })
        .populate({ path: "elastics.elastic", select: "name" })
        .lean(),
      ShiftDetail.aggregate([
        { $match: { employee: empId, status: "closed", date: { $gte: before, $lt: since } } },
        { $group: { _id: null, metres: { $sum: "$productionMeters" }, n: { $sum: 1 } } },
      ]),
      ShiftDetail.aggregate([
        { $match: { status: "closed", date: { $gte: since } } },
        { $group: { _id: null, metres: { $sum: "$productionMeters" }, n: { $sum: 1 } } },
      ]),
    ]);

    let hours = 0;
    let metresTimed = 0;
    const rows = mine.map((s) => {
      const h = hoursOf(s.timer);
      if (h) {
        hours += h;
        metresTimed += s.productionMeters || 0;
      }
      const names = [...new Set((s.elastics || []).map((e) => e.elastic?.name).filter(Boolean))];
      return {
        id: s._id,
        date: s.date,
        shift: s.shift,
        machine: s.machine?.ID ?? null,
        elastics: names,
        metres: s.productionMeters || 0,
        runHours: round(h, 2),
        metresPerHour: h ? round((s.productionMeters || 0) / h) : null,
      };
    });

    const total = rows.reduce((t, r) => t + r.metres, 0);
    const avg = rows.length ? total / rows.length : null;
    const prev = previous[0];
    const prevAvg = prev && prev.n ? prev.metres / prev.n : null;
    const plantAvg = plant[0] && plant[0].n ? plant[0].metres / plant[0].n : null;

    res.json({
      success: true,
      days,
      summary: {
        shifts: rows.length,
        totalMetres: total,
        avgPerShift: round(avg),
        metresPerHour: hours ? round(metresTimed / hours) : null,
        plantAvgPerShift: round(plantAvg),
        previousAvgPerShift: round(prevAvg),
        changePct: avg != null && prevAvg ? Math.round(((avg - prevAvg) / prevAvg) * 100) : null,
      },
      shifts: rows,
    });
  })
);

// ── GET /me/elastic/:id ────────────────────────────────────────────
//  An elastic in depth — only one that is on this worker's loom: on a
//  head of one of their shifts that is open, or from the last 60 days,
//  or on the loom of a shift they still have open.
router.get(
  "/elastic/:id",
  catchAsyncErrors(async (req, res, next) => {
    const employee = employeeOf(req, next);
    if (!employee) return;
    if (!mongoose.isValidObjectId(req.params.id)) return next(new ErrorHandler("Elastic not found", 404));
    const elasticId = new mongoose.Types.ObjectId(req.params.id);
    const since = new Date(Date.now() - ELASTIC_WINDOW_DAYS * 86_400_000);

    const onMyShift = await ShiftDetail.exists({
      employee,
      "elastics.elastic": elasticId,
      $or: [{ status: { $in: ["open", "pending_verification"] } }, { date: { $gte: since } }],
    });
    let allowed = !!onMyShift;
    if (!allowed) {
      const open = await ShiftDetail.find({ employee, status: { $in: ["open", "pending_verification"] } })
        .select("machine")
        .populate({ path: "machine", select: "elastics.elastic" })
        .lean();
      allowed = open.some((s) => (s.machine?.elastics || []).some((h) => String(h.elastic) === String(elasticId)));
    }
    // Same answer as a missing elastic: whether it exists is not this
    // worker's business either.
    if (!allowed) return next(new ErrorHandler("Elastic not found", 404));

    const elastic = await Elastic.findById(elasticId).select(ELASTIC_FIELDS).populate(MATERIAL_NAMES).lean();
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));
    res.json({ success: true, elastic: shapeElastic(elastic) });
  })
);

// ── POST /me/shifts/:id/production ─────────────────────────────────
//  The worker's own entry for their own shift. Same rules as the
//  supervisor-side /shift/update: only while open or waiting, and the
//  entry still waits for a supervisor to verify it.
const TIMER = /^\d{1,2}:[0-5]\d(:[0-5]\d)?$/;
router.post(
  "/shifts/:id/production",
  catchAsyncErrors(async (req, res, next) => {
    const employee = employeeOf(req, next);
    if (!employee) return;
    if (!mongoose.isValidObjectId(req.params.id)) return next(new ErrorHandler("Shift not found", 404));

    const { production, timer, feedback } = req.body || {};
    const metres = Number(production);
    if (production == null || production === "" || !Number.isFinite(metres) || metres < 0)
      return next(new ErrorHandler("Enter the metres produced as a number of 0 or more", 400));
    if (timer != null && timer !== "" && !TIMER.test(String(timer)))
      return next(new ErrorHandler("Run time must look like 7:30 or 07:30:00", 400));
    if (feedback != null && String(feedback).length > 500)
      return next(new ErrorHandler("Keep the note under 500 characters", 400));

    // Scoped by employee in the query itself: someone else's shift is
    // "not found", exactly like a shift that does not exist.
    const shift = await ShiftDetail.findOne({ _id: req.params.id, employee });
    if (!shift) return next(new ErrorHandler("Shift not found", 404));
    if (!["open", "pending_verification"].includes(shift.status))
      return next(new ErrorHandler("This shift has already been verified and closed", 409));
    // The same lock the supervisor-side entry obeys: once the job has
    // moved past weaving, its production figures are settled.
    await assertShiftProductionOpen(shift, { JobOrder, Machine }, "enter production");

    shift.submittedProductionMeters = metres;
    shift.submittedTimer = timer ? String(timer) : shift.submittedTimer || "00:00:00";
    if (feedback != null) shift.submittedFeedback = String(feedback).trim();
    shift.submittedAt = new Date();
    shift.submittedBy = req.user._id;
    shift.status = "pending_verification";
    await shift.save();

    res.json({ success: true, shift: { id: shift._id, status: shift.status, submittedAt: shift.submittedAt } });
  })
);

// ── GET /me/profile ────────────────────────────────────────────────
router.get(
  "/profile",
  catchAsyncErrors(async (req, res, next) => {
    const employee = employeeOf(req, next);
    if (!employee) return;
    const [emp, user] = await Promise.all([
      Employee.findById(employee).select("name department role skill phoneNumber skillProfile.yearsOfExperience skillProfile.machineType createdAt").lean(),
      User.findById(req.user._id).select("email").lean(),
    ]);
    if (!emp) return next(new ErrorHandler("Employee record not found", 404));
    res.json({
      success: true,
      profile: {
        employeeId: emp._id,
        name: emp.name,
        department: emp.department || null,
        role: emp.role || null,
        skill: emp.skill ?? null,
        yearsOfExperience: emp.skillProfile?.yearsOfExperience ?? null,
        machineType: emp.skillProfile?.machineType || null,
        phoneNumber: emp.phoneNumber || null,
        email: user?.email || null,
        since: emp.createdAt || null,
      },
    });
  })
);

module.exports = router;
module.exports._hoursOf = hoursOf; // for the tests

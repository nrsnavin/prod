"use strict";

const express  = require("express");
const router   = express.Router();
const moment   = require("moment");
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Employee    = require("../models/Employee");
const Machine     = require("../models/Machine");
const Order       = require("../models/Order");
const ShiftDetail = require("../models/ShiftDetail");
const ShiftPlan   = require("../models/ShiftPlan");
const JobOrder    = require("../models/JobOrder");
const Attendance  = require("../models/Attendence.js");
const { ACTION_CODES } = require("../utils/fingerprint");
const { requireReason } = require("../utils/auditReason");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
// Production cascade + anomaly detection live in their own service
// (Phase 4 god-file split). The verify route calls applyProductionCascade;
// it is re-exported on the router below for the characterization test.
const {
  applyProductionCascade,
  _rederiveShiftProduction,
} = require("../services/shiftCascadeService.js");
const multer = require("multer");
const { buildShiftSheetPdf, shortCode } = require("../utils/shiftSheetPdf");
const { extractShiftRows } = require("../utils/shiftSheetOcr");

// Scanned 200-machine sheets run ~19 pages; allow up to 25 MB in memory.
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(isAuthenticated);

function normDate(raw) {
  return new Date(new Date(raw).setHours(0, 0, 0, 0));
}

// applyProductionCascade + _checkLowOutputShift + _checkMachineAnomaly
// moved to services/shiftCascadeService.js (Phase 4 god-file split).
// Imported at the top of this file; re-exported as router.applyProductionCascade
// below for the characterization test and any external caller.

router.get(
  "/today",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const today    = normDate(new Date());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const plans = await ShiftPlan.find({
      date: { $gte: today, $lt: tomorrow },
    })
      .populate({
        path: "plan",
        populate: [
          { path: "machine"  },
          { path: "employee" },
        ],
      })
      .lean();

    const buildShiftData = (shiftType) => {
      const shift = plans.find((p) => p.shift === shiftType) || null;

      if (!shift) {
        return {
          id: null, shift: shiftType,
          production: 0, machinesRunning: 0, operatorCount: 0,
          status: "not_created", plan: [],
        };
      }

      const production = shift.plan.reduce(
        (sum, d) => sum + (d.production || 0), 0
      );
      const uniqueOperators = new Set(
        shift.plan.filter((d) => d.employee).map((d) => d.employee._id.toString())
      );

      return {
        ...shift,
        production,
        machinesRunning: shift.plan.length,
        operatorCount:   uniqueOperators.size,
      };
    };

    res.json({
      success: true,
      data: {
        dayShift:   buildShiftData("DAY"),
        nightShift: buildShiftData("NIGHT"),
      },
    });
  })
);

router.get(
  "/shiftPlanToday",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { date } = req.query;
    if (!date) return next(new ErrorHandler("date is required", 400));

    const start = normDate(date);
    const end   = new Date(start);
    end.setDate(end.getDate() + 1);

    const shifts = await ShiftPlan.find({
      date: { $gte: start, $lt: end },
    })
      .populate({
        path: "plan",
        populate: [
          { path: "employee", model: "Employee" },
          { path: "machine",  model: "Machine"  },
        ],
      })
      .exec();

    res.json({ success: true, shifts });
  })
);

router.get(
  "/shiftPlanById",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shiftPlan = await ShiftPlan.findById(id).populate({
      path: "plan",
      populate: [
        { path: "machine",  model: "Machine"  },
        { path: "employee", model: "Employee" },
      ],
    });

    if (!shiftPlan) return next(new ErrorHandler("Shift Plan not found", 404));

    let totalProduction = 0;

    const machines = await Promise.all(
      shiftPlan.plan.map(async (detail) => {
        totalProduction += detail.productionMeters || 0;

        const machine = await Machine.findById(detail.machine._id).populate(
          "orderRunning"
        );

        let jobOrderNo = "";
        if (machine?.orderRunning) {
          const job = await JobOrder.findById(machine.orderRunning);
          if (job) jobOrderNo = job.jobOrderNo.toString();
        }

        return {
          machineId: detail.machine._id,
          machineName: detail.machine.ID ||
            `${detail.machine.manufacturer ?? ""} ${detail.machine.ID ?? ""}`.trim(),
          jobOrderNo,
          operatorName: detail.employee?.name ?? "—",
          production:   detail.productionMeters || 0,
          timer:        detail.timer,
          status:       detail.status,
          id:           detail._id,
        };
      })
    );

    res.json({
      success: true,
      data: {
        _id:             shiftPlan._id,
        date:            shiftPlan.date,
        shift:           shiftPlan.shift,
        description:     shiftPlan.description,
        totalProduction,
        status:          shiftPlan.status ?? 'confirmed',
        operatorCount:   shiftPlan.plan.length,
        machines,
      },
    });
  })
);

// ────────────────────────────────────────────────────────────────
//  BULK ENTER PRODUCTION (worker bulk path)
//
//  Now sets each shift to 'pending_verification' with submitted*
//  values only — admin must verify each row before the totals
//  cascade into JobOrder / Order / ShiftPlan.
// ────────────────────────────────────────────────────────────────
router.post('/bulk-enter-production', async (req, res) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ success: false, message: 'entries must be a non-empty array.' });
    }
    // Cap the batch — each entry drives multiple DB round-trips, so an
    // unbounded array is a DoS lever for any authenticated worker.
    if (entries.length > 200) {
      return res.status(400).json({ success: false, message: 'entries exceeds the 200-item limit per request.' });
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];

      if (!e.id || !/^[a-f\d]{24}$/i.test(e.id)) {
        return res.status(400).json({ success: false, message: `entries[${i}].id is missing or invalid.` });
      }

      const prod = Number(e.production);
      if (!Number.isInteger(prod) || prod < 0) {
        return res.status(400).json({ success: false, message: `entries[${i}].production must be a non-negative integer.` });
      }
    }

    const saved   = [];
    const skipped = [];

    for (const entry of entries) {
      const { id, production, timer = '00:00:00', feedback = '' } = entry;
      const prodNum = Number(production);

      const sd = await ShiftDetail.findById(id).select('_id status shiftPlan').lean();

      if (!sd) { skipped.push({ id, reason: 'ShiftDetail not found' }); continue; }
      if (sd.status === 'closed') { skipped.push({ id, reason: 'Already closed' }); continue; }

      await ShiftDetail.findByIdAndUpdate(id, {
        $set: {
          submittedProductionMeters: prodNum,
          submittedTimer:            timer,
          submittedFeedback:         feedback,
          submittedAt:               new Date(),
          submittedBy:               req.user?._id,
          status:                    'pending_verification',
        },
      });

      saved.push({ id, production: prodNum, status: 'pending_verification' });
    }

    return res.json({
      success: true, saved: saved.length, skipped: skipped.length,
      results: saved, skipped,
    });

  } catch (err) {
    console.error('[POST /shift/bulk-enter-production]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get(
  "/shiftPLan",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shift = await ShiftPlan.findById(id)
      .populate({
        path: "plan",
        populate: [
          { path: "employee", model: "Employee" },
          { path: "machine",  model: "Machine"  },
        ],
      })
      .exec();

    if (!shift) return next(new ErrorHandler("Shift Plan not found", 404));

    res.json({ success: true, shift });
  })
);

router.get(
  "/get-in-range",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { start, less } = req.query;
    if (!start || !less) {
      return next(new ErrorHandler("start and less date params are required", 400));
    }

    const shifts = await ShiftPlan.find({
      date: {
        $gte: moment(start, "YYYY-MM-DD").toDate(),
        $lte: moment(less,  "YYYY-MM-DD").toDate(),
      },
    }).lean();

    const productionByDate = new Map();

    shifts.forEach((s) => {
      const dateKey = moment(s.date).format("DD-MM-YYYY");
      const existing = productionByDate.get(dateKey) || 0;
      productionByDate.set(dateKey, existing + (s.totalProduction || 0));
    });

    const array = Array.from(productionByDate, ([date, production]) => ({ date, production }));

    res.json({ success: true, array });
  })
);

// ────────────────────────────────────────────────────────────────
//  WORKER SUBMIT (verification gated)
//
//  Worker submits production. We capture the values in submitted*
//  fields and flip status to 'pending_verification'. Nothing
//  cascades yet — that happens in /verify-production when an
//  admin reviews and types the final number.
// ────────────────────────────────────────────────────────────────
router.post(
  "/enter-shift-production",
  catchAsyncErrors(async (req, res, next) => {
    const { id, production, timer, feedback } = req.body;

    if (!id)                 return next(new ErrorHandler("id is required", 400));
    if (production == null)  return next(new ErrorHandler("production is required", 400));

    const prodValue = Number(production);
    if (isNaN(prodValue) || prodValue < 0) {
      return next(new ErrorHandler("production must be a non-negative number", 400));
    }

    const shift = await ShiftDetail.findById(id);
    if (!shift) return next(new ErrorHandler("Shift detail not found", 404));
    if (shift.status === "closed") {
      return next(new ErrorHandler("Shift is already closed", 400));
    }

    shift.submittedProductionMeters = prodValue;
    shift.submittedTimer            = timer    || "00:00:00";
    shift.submittedFeedback         = feedback || "";
    shift.submittedAt               = new Date();
    shift.submittedBy               = req.user?._id;
    shift.status                    = "pending_verification";
    await shift.save();

    res.json({ success: true, shift });
  })
);

// ────────────────────────────────────────────────────────────────
//  WORKER UPDATE (verification gated)
//
//  Allowed when status is 'open' or 'pending_verification'.
//  Behaves like /enter-shift-production: lands values in
//  submitted* fields, sets status to pending_verification, does
//  NOT cascade.
// ────────────────────────────────────────────────────────────────
router.post(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const { shiftId, production, timer, feedback } = req.body;
    if (!shiftId) return next(new ErrorHandler("shiftId is required", 400));

    const shift = await ShiftDetail.findById(shiftId);
    if (!shift) return next(new ErrorHandler("Shift not found", 404));
    if (!["open", "pending_verification"].includes(shift.status)) {
      return next(new ErrorHandler(
        `Shift cannot be updated in status '${shift.status}'`, 400
      ));
    }

    if (production != null) {
      const prodValue = Number(production);
      if (isNaN(prodValue) || prodValue < 0) {
        return next(new ErrorHandler("production must be a non-negative number", 400));
      }
      shift.submittedProductionMeters = prodValue;
    }
    if (timer    !== undefined) shift.submittedTimer    = timer;
    if (feedback !== undefined) shift.submittedFeedback = feedback;
    shift.submittedAt = new Date();
    shift.submittedBy = req.user?._id;
    shift.status      = "pending_verification";

    await shift.save();
    res.json({ success: true, shift });
  })
);

// ────────────────────────────────────────────────────────────────
//  ADMIN — list shifts awaiting verification
// ────────────────────────────────────────────────────────────────
router.get(
  "/pending-verification",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const shifts = await ShiftDetail.find({ status: "pending_verification" })
      .populate("employee", "name department role")
      .populate({
        path: "machine",
        populate: { path: "orderRunning", model: "JobOrder",
          populate: [
            { path: "customer", select: "name" },
            { path: "order",    select: "po orderNo" },
          ],
        },
      })
      .populate("shiftPlan", "date shift")
      .populate({
        path: "job",
        populate: [
          { path: "customer", select: "name" },
          { path: "order",    select: "po orderNo" },
        ],
      })
      .sort({ submittedAt: 1 });

    res.json({ success: true, count: shifts.length, shifts });
  })
);

// ────────────────────────────────────────────────────────────────
//  ADMIN — verify a worker's submitted shift production
//
//  Body: { shiftId, productionMeters, timer?, feedback?, note? }
//
//  Sets the canonical productionMeters / timer / feedback to the
//  admin's values (which may differ from what the worker typed),
//  flips status to 'closed', records verifiedAt/By, then runs
//  applyProductionCascade so JobOrder/Order/ShiftPlan all reflect
//  the admin-blessed numbers.
// ────────────────────────────────────────────────────────────────
router.post(
  "/verify-production",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftId, productionMeters, timer, feedback, note } = req.body;

    if (!shiftId)                  return next(new ErrorHandler("shiftId is required", 400));
    if (productionMeters == null)  return next(new ErrorHandler("productionMeters is required", 400));

    const prodValue = Number(productionMeters);
    if (isNaN(prodValue) || prodValue < 0) {
      return next(new ErrorHandler("productionMeters must be a non-negative number", 400));
    }

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const shift = await ShiftDetail.findById(shiftId)
          .populate({ path: "machine", populate: { path: "orderRunning" } })
          .session(session);

        if (!shift) throw new ErrorHandler("Shift detail not found", 404);
        if (shift.status === "closed") {
          throw new ErrorHandler("Shift is already closed", 400);
        }

        const machine = await Machine.findById(shift.machine).session(session);

        // Canonical (admin-blessed) values overwrite whatever the
        // worker had typed.
        const finalTimer    = timer    != null ? timer    : (shift.submittedTimer    || "00:00:00");
        const finalFeedback = feedback != null ? feedback : (shift.submittedFeedback || "");

        shift.productionMeters = prodValue * (machine?.NoOfHead || 1);
        shift.timer            = finalTimer;
        shift.feedback         = finalFeedback;
        shift.status           = "closed";
        shift.verifiedAt       = new Date();
        shift.verifiedBy       = req.user?._id;
        if (note) shift.description = note;
        await shift.save({ session });

        const { fingerprint } = await applyProductionCascade(session, {
          shift,
          machine,
          productionMeters: prodValue,
          timer:            finalTimer,
          feedback:         finalFeedback,
          req,
        });

        // Auto-mark attendance for this operator on this date if
        // there isn't already a row. Manual marks win — we only
        // fill the gap. Skipped when production is zero (treat that
        // as "verify-but-no-work-done", admin should mark manually).
        let attendanceAutoMarked = false;
        if (prodValue > 0 && shift.employee) {
          const dayStart = new Date(shift.date);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(dayStart.getTime() + 86_400_000);
          const existing = await Attendance.findOne({
            employee: shift.employee,
            date:     { $gte: dayStart, $lt: dayEnd },
            shift:    shift.shift,
          }).session(session);

          if (!existing) {
            // new + save (not insertOne) so the pre('save') hook
            // computes shiftHours / hoursWorked correctly.
            const att = new Attendance({
              employee: shift.employee,
              date:     dayStart,
              shift:    shift.shift,
              status:   'present',
              markedBy: 'auto_shift_verify',
            });
            await att.save({ session });
            attendanceAutoMarked = true;
          }
        }

        resp = { shift, fingerprint, attendanceAutoMarked };
      });
      res.json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.get(
  "/shiftDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
     console.log(id);
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shift = await ShiftDetail.findById(id)
      .populate("employee")
      .populate({ path: "elastics", populate: { path: "elastic" } })
      .populate({
        path: "machine",
        populate: { path: "orderRunning",populate: { path: "jobOrderNo" } },
      })
      .exec();

    console.log(shift);

    if (!shift) return next(new ErrorHandler("Shift detail not found", 404));

    res.json({ success: true, shift });
  })
);

router.get(
  "/all-open-shifts",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const shifts = await ShiftDetail.find({ status: "open" })
      .populate("employee")
      .populate("machine")
      .populate("job")
      .exec();

    res.json({ success: true, shifts });
  })
);

router.get(
  "/open",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const shifts = await ShiftDetail.find({ status: "open" })
      .populate("employee")
      .populate({ path: "machine", populate: { path: "orderRunning" } })
      .sort({ date: -1 });

    res.json({ success: true, shifts });
  })
);

router.get(
  "/employee-open-shifts",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shifts = await ShiftDetail.find({
      status: { $in: ["open", "pending_verification"] },
      employee: id,
    })
      .populate("employee")
      .populate("machine")
      .populate("job")
      .exec();

    res.json({ success: true, shifts });
  })
);

router.get(
  "/employee-closed-shifts",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shifts = await ShiftDetail.find({ status: "closed", employee: id })
      .sort({ createdAt: -1 })
      .limit(30)
      .populate("employee")
      .populate("machine")
      .populate("job")
      .exec();

    res.json({ success: true, shifts });
  })
);

router.get(
  "/active-jobs/:empId",
  catchAsyncErrors(async (req, res, next) => {
    const { empId } = req.params;
    if (!empId) return next(new ErrorHandler("empId is required", 400));

    const ELASTIC_FIELDS =
      "name weaveType image " +
      "warpSpandex warpYarn spandexCovering " +
      "spandexEnds yarnEnds weftYarn " +
      "pick noOfHook weight " +
      "testingParameters quantityProduced stock " +
      "warpingPlanTemplate createdAt updatedAt";

    const elasticPopulate = [
      { path: "warpSpandex.id",     model: "RawMaterial", select: "name category" },
      { path: "warpYarn.id",        model: "RawMaterial", select: "name category" },
      { path: "spandexCovering.id", model: "RawMaterial", select: "name category" },
      { path: "weftYarn.id",        model: "RawMaterial", select: "name category" },
    ];

    const shifts = await ShiftDetail.find({ status: "open", employee: empId })
      .sort({ createdAt: 1 })
      .populate("employee", "name department role")
      .populate({
        path: "machine",
        populate: [
          { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
          { path: "orderRunning", model: "JobOrder",
            populate: [
              { path: "order",    model: "Order", select: "po orderNo description supplyDate" },
              { path: "customer", model: "Customer", select: "name" },
              { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
            ],
          },
        ],
      })
      .populate({
        path: "job",
        populate: [
          { path: "customer", model: "Customer", select: "name" },
          { path: "order",    model: "Order", select: "po orderNo description supplyDate" },
          { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
        ],
      })
      .populate({ path: "elastics.elastic", select: ELASTIC_FIELDS, populate: elasticPopulate })
      .lean();

    res.json({ success: true, count: shifts.length, shifts });
  })
);

router.get(
  "/active-job/:empId",
  catchAsyncErrors(async (req, res, next) => {
    const { empId } = req.params;
    if (!empId) return next(new ErrorHandler("empId is required", 400));

    const ELASTIC_FIELDS =
      "name weaveType image " +
      "warpSpandex warpYarn spandexCovering " +
      "spandexEnds yarnEnds weftYarn " +
      "pick noOfHook weight " +
      "testingParameters quantityProduced stock " +
      "warpingPlanTemplate createdAt updatedAt";
    const elasticPopulate = [
      { path: "warpSpandex.id",     model: "RawMaterial", select: "name category" },
      { path: "warpYarn.id",        model: "RawMaterial", select: "name category" },
      { path: "spandexCovering.id", model: "RawMaterial", select: "name category" },
      { path: "weftYarn.id",        model: "RawMaterial", select: "name category" },
    ];

    const shift = await ShiftDetail.findOne({ status: "open", employee: empId })
      .sort({ createdAt: 1 })
      .populate("employee", "name department role")
      .populate({
        path: "machine",
        populate: [
          { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
          { path: "orderRunning", model: "JobOrder",
            populate: [
              { path: "order",    model: "Order", select: "po orderNo description supplyDate" },
              { path: "customer", model: "Customer", select: "name" },
              { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
            ]},
        ],
      })
      .populate({
        path: "job",
        populate: [
          { path: "customer", model: "Customer", select: "name" },
          { path: "order",    model: "Order", select: "po orderNo description supplyDate" },
          { path: "elastics.elastic", model: "Elastic", select: ELASTIC_FIELDS, populate: elasticPopulate },
        ],
      })
      .populate({ path: "elastics.elastic", select: ELASTIC_FIELDS, populate: elasticPopulate })
      .lean();

    res.json({ success: true, shift: shift || null });
  })
);

router.get(
  "/shiftPlanOnDate",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { date } = req.query;
    if (!date) return next(new ErrorHandler("date is required", 400));

    const start = moment(date, "DD-MM-YYYY").startOf("day").toDate();
    const end   = moment(date, "DD-MM-YYYY").endOf("day").toDate();

    const shift = await ShiftPlan.find({
      date: { $gte: start, $lt: end },
    })
      .populate({
        path: "plan",
        populate: [
          { path: "employee", model: "Employee" },
          { path: "machine",  model: "Machine"  },
        ],
      })
      .exec();

    res.json({ success: true, shift });
  })
);

router.delete(
  "/deletePlan",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const sp = await ShiftPlan.findById(id);
    if (!sp) return next(new ErrorHandler("Shift Plan not found", 404));

    await Promise.all(
      sp.plan.map(async (shiftDetailId) => {
        const sd = await ShiftDetail.findById(shiftDetailId);
        if (!sd) return;

        const [machine, emp] = await Promise.all([
          Machine.findById(sd.machine),
          Employee.findById(sd.employee),
        ]);

        if (machine) {
          machine.shifts = machine.shifts.filter(
            (sid) => sid.toString() !== sd._id.toString()
          );
          await machine.save();
        }
        if (emp) {
          emp.shifts = emp.shifts.filter(
            (sid) => sid.toString() !== sd._id.toString()
          );
          await emp.save();
        }

        await ShiftDetail.findByIdAndDelete(shiftDetailId);
      })
    );

    await ShiftPlan.findByIdAndDelete(id);

    res.json({ success: true, message: "Shift Plan deleted successfully" });
  })
);

router.post('/create-shift-plan', isAdmin('admin', 'production'), async (req, res) => {
  try {
    const { date, shiftType, description = '', machines = [] } = req.body;

    if (!date || !shiftType) {
      return res.status(400).json({ success: false, message: 'date and shiftType are required.' });
    }

    if (!Array.isArray(machines) || machines.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one machine must be assigned.' });
    }

    const planDate = new Date(date);
    planDate.setUTCHours(0, 0, 0, 0);

    const shiftPlan = await ShiftPlan.create({
      date: planDate, shift: shiftType,
      description: description.trim(), status: 'draft',
    });

    const detailIds = [];
    for (const m of machines) {
      if (!m.machine || !m.operator) continue;

      const machineDoc = await require('../models/Machine')
        .findById(m.machine)
        .populate('elastics.elastic')
        .lean();

      const elastics = (machineDoc?.elastics || []).map((e) => ({
        head: e.head, elastic: e.elastic?._id ?? e.elastic,
      }));

      const detail = await ShiftDetail.create({
        date: planDate, shift: shiftType,
        job: machineDoc?.orderRunning ?? m.machine,
        machine: m.machine, employee: m.operator,
        shiftPlan: shiftPlan._id, elastics,
        status: 'open', timer: '00:00:00',
      });

      detailIds.push(detail._id);
    }

    await ShiftPlan.findByIdAndUpdate(shiftPlan._id, { $push: { plan: { $each: detailIds } } });

    for (const m of machines) {
      if (m.operator) {
        await Employee.findByIdAndUpdate(m.operator, { $push: { shifts: { $each: detailIds } } });
      }
    }

    return res.status(201).json({
      success: true, shiftPlanId: shiftPlan._id, status: 'draft',
      message: `Shift plan saved as draft (${detailIds.length} machine(s) included).`,
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A shift plan already exists for this date and shift type.' });
    }
    console.error('[POST /create-shift-plan]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/confirm-shift-plan', isAdmin('admin', 'production'), async (req, res) => {
  try {
    const { id } = req.body;

    if (!id || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ success: false, message: 'A valid shiftPlan id is required.' });
    }

    const plan = await ShiftPlan.findById(id).select('status shift date');

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Shift plan not found.' });
    }

    if (plan.status === 'confirmed') {
      return res.status(400).json({ success: false, message: 'This shift plan is already confirmed.' });
    }

    await ShiftPlan.findByIdAndUpdate(id, { $set: { status: 'confirmed' } });

    return res.json({
      success: true, shiftPlanId: id, status: 'confirmed',
      message: 'Shift plan confirmed successfully.',
    });

  } catch (err) {
    console.error('[POST /confirm-shift-plan]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /production-anomalies?dropPct=30&minShifts=5
//  Per-machine production drop vs the trailing 30-day average.
//  A machine is "dropping" when:
//    - it has at least `minShifts` closed shifts in the last 30 days
//    - today's productionMeters < (1 - dropPct/100) × the avg
//  Powers the AIAdvisor "production drop" card.
// ══════════════════════════════════════════════════════════════
router.get("/production-anomalies", isAdmin('admin', 'production'), async (req, res) => {
  try {
    const dropPct   = Math.max(1, parseFloat(req.query.dropPct)   || 30);
    const minShifts = Math.max(1, parseInt(req.query.minShifts, 10) || 5);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const monthAgo = new Date(today.getTime() - 30 * 86_400_000);

    const shifts = await ShiftDetail.find({
      status: "closed",
      date:   { $gte: monthAgo, $lt: tomorrow },
    })
      .select("machine date productionMeters")
      .lean();

    // Bucket per machine into { today: meters, trailing: [meters...] }
    const buckets = new Map();
    for (const s of shifts) {
      if (!s.machine) continue;
      const key = String(s.machine);
      if (!buckets.has(key)) buckets.set(key, { today: 0, trailing: [] });
      const b = buckets.get(key);
      if (new Date(s.date) >= today) {
        b.today += s.productionMeters || 0;
      } else {
        b.trailing.push(s.productionMeters || 0);
      }
    }

    const anomalyIds = [];
    const meta       = new Map();
    for (const [mid, { today: t, trailing }] of buckets) {
      if (trailing.length < minShifts) continue;
      const avg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
      if (avg <= 0) continue;
      const drop = ((avg - t) / avg) * 100;
      if (drop > dropPct) {
        anomalyIds.push(mid);
        meta.set(mid, {
          today:       Math.round(t),
          avg:         parseFloat(avg.toFixed(1)),
          dropPct:     parseFloat(drop.toFixed(1)),
          sampleSize:  trailing.length,
        });
      }
    }

    if (anomalyIds.length === 0) {
      return res.json({ success: true, machines: [], count: 0 });
    }

    const machines = await Machine.find({
      _id: { $in: anomalyIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select("ID manufacturer").lean();

    const out = machines
      .map((m) => ({
        machineId:   m._id,
        machineCode: m.ID,
        manufacturer: m.manufacturer,
        ...meta.get(String(m._id)),
      }))
      .sort((a, b) => b.dropPct - a.dropPct);

    return res.json({ success: true, machines: out, count: out.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /attendance-mismatch?days=7
//  Closed shifts in the last `days` whose operator has no
//  attendance row for the shift's date. The exact (employee,
//  date, shift) tuple isn't required because attendance is
//  recorded per day not per shift type — a missing day for an
//  operator who worked is what we want to surface.
//
//  Powers the AIAdvisor "shift ↔ attendance mismatch" card.
// ══════════════════════════════════════════════════════════════
router.get("/attendance-mismatch", isAdmin('admin', 'production'), async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 7);
    const since = new Date(Date.now() - days * 86_400_000);
    since.setHours(0, 0, 0, 0);

    const shifts = await ShiftDetail.find({
      status: "closed",
      date:   { $gte: since },
    })
      .select("employee date shift")
      .populate("employee", "name")
      .lean();

    if (shifts.length === 0) {
      return res.json({ success: true, windowDays: days, mismatches: [], count: 0 });
    }

    const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

    // Build the (employee, day) set we need to check, then a single
    // attendance find covers all of them at once.
    const empIds  = [...new Set(shifts.map((s) => String(s.employee?._id ?? s.employee)))];
    const dates   = [...new Set(shifts.map((s) => dayKey(s.date)))];
    const minDate = new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
    const maxDate = new Date(Math.max(...dates.map((d) => new Date(d).getTime())));
    maxDate.setHours(23, 59, 59, 999);

    const att = await Attendance.find({
      employee: { $in: empIds },
      date:     { $gte: minDate, $lte: maxDate },
    }).select("employee date").lean();

    const marked = new Set(
      att.map((a) => `${String(a.employee)}|${dayKey(a.date)}`)
    );

    const mismatches = shifts
      .filter((s) => {
        const empId = String(s.employee?._id ?? s.employee);
        return !marked.has(`${empId}|${dayKey(s.date)}`);
      })
      .map((s) => ({
        shiftId:      s._id,
        date:         s.date,
        shiftType:    s.shift,
        employeeId:   s.employee?._id ?? s.employee,
        employeeName: s.employee?.name ?? "—",
      }));

    return res.json({
      success:   true,
      windowDays: days,
      mismatches,
      count:     mismatches.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Exported for characterization/unit tests (Phase B0.3) — this is the
// core production cascade the /verify-production route delegates to.
router.applyProductionCascade = applyProductionCascade;

// ═════════════════════════════════════════════════════════════════
//  GET /shift/:shiftPlanId/production-sheet.pdf
//
//  Downloads the printable production sheet for a plan — one row per
//  assigned machine, prefilled, with empty Production / Timer /
//  Remarks columns for the floor to fill by hand.
// ═════════════════════════════════════════════════════════════════
router.get(
  "/:shiftPlanId/production-sheet.pdf",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftPlanId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(shiftPlanId)) return next(new ErrorHandler("Invalid shiftPlanId", 400));

    const sp = await ShiftPlan.findById(shiftPlanId)
      .populate({
        path: "plan",
        model: "ShiftDetail",
        populate: [
          { path: "machine", model: "Machine", select: "ID" },
          { path: "employee", model: "Employee", select: "name" },
          { path: "job", model: "JobOrder", select: "jobOrderNo" },
        ],
      })
      .lean();
    if (!sp) return next(new ErrorHandler("Shift plan not found", 404));

    const rows = (sp.plan || []).map((d) => ({
      sdId: d._id,
      machine: d.machine?.ID || "—",
      operator: d.employee?.name || "—",
      job: d.job?.jobOrderNo != null ? `J-${d.job.jobOrderNo}` : "—",
    }));

    const dateLabel = moment(sp.date).format("DD-MMM-YYYY");
    const pdf = await buildShiftSheetPdf({
      dateLabel,
      shift: sp.shift,
      planNo: `SP-${moment(sp.date).format("YYYYMMDD")}-${sp.shift === "NIGHT" ? "N" : "D"}`,
      rows,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="production-sheet-${moment(sp.date).format("YYYY-MM-DD")}-${sp.shift}.pdf"`
    );
    return res.send(pdf);
  })
);

// ═════════════════════════════════════════════════════════════════
//  POST /shift/:shiftPlanId/ingest-sheet   (multipart 'file')
//
//  Reads a filled + scanned production sheet with Claude vision and
//  maps each hand-written Production / Timer / Remarks back to its
//  ShiftDetail by the printed Code. READ-ONLY: it returns a review
//  payload; the admin confirms in the UI, which then stages the
//  values through the existing /bulk-enter-production route.
// ═════════════════════════════════════════════════════════════════
router.post(
  "/:shiftPlanId/ingest-sheet",
  isAdmin("admin"),
  sheetUpload.single("file"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftPlanId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(shiftPlanId)) return next(new ErrorHandler("Invalid shiftPlanId", 400));
    if (!req.file) return next(new ErrorHandler('No file uploaded (field name must be "file").', 400));
    if (req.file.mimetype !== "application/pdf") {
      return next(new ErrorHandler("Upload must be a PDF of the filled sheet.", 400));
    }

    const sp = await ShiftPlan.findById(shiftPlanId)
      .populate({
        path: "plan",
        model: "ShiftDetail",
        populate: [
          { path: "machine", model: "Machine", select: "ID" },
          { path: "employee", model: "Employee", select: "name" },
          { path: "job", model: "JobOrder", select: "jobOrderNo" },
        ],
      })
      .lean();
    if (!sp) return next(new ErrorHandler("Shift plan not found", 404));

    // Map printed Code -> shift detail(s). Suffix collisions inside one
    // plan are vanishingly unlikely but resolved by machine ID if they
    // ever happen.
    const codeMap = new Map();
    for (const d of sp.plan || []) {
      const code = shortCode(d._id);
      const meta = {
        shiftDetailId: String(d._id),
        machineID: d.machine?.ID || null,
        operator: d.employee?.name || null,
        jobNo: d.job?.jobOrderNo != null ? `J-${d.job.jobOrderNo}` : null,
        status: d.status,
      };
      if (!codeMap.has(code)) codeMap.set(code, []);
      codeMap.get(code).push(meta);
    }

    let ocr;
    try {
      ocr = await extractShiftRows(req.file.buffer);
    } catch (err) {
      if (err.code === "ANTHROPIC_KEY_MISSING") {
        return res.status(503).json({ success: false, reason: "ANTHROPIC_KEY_MISSING", message: err.message });
      }
      console.error("[ingest-sheet] OCR error:", err.message);
      return res.status(502).json({ success: false, reason: "OCR_FAILED", message: err.message });
    }

    const matched = [];
    const unmatched = [];
    const seen = new Set();

    for (const r of ocr.rows) {
      const code = String(r.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
      const norm = code.startsWith("SD-") ? code : `SD-${code.replace(/^SD/, "").slice(-6)}`;
      let candidates = codeMap.get(norm);
      // Tolerate a missing/garbled "SD-" prefix by matching on the 6-char suffix.
      if (!candidates) {
        const suffix = code.replace(/[^A-Z0-9]/g, "").slice(-6);
        candidates = codeMap.get(`SD-${suffix}`);
      }
      if (!candidates || candidates.length === 0) {
        unmatched.push({ code: r.code, production: r.production, timer: r.timer, remarks: r.remarks });
        continue;
      }
      // Resolve collisions by machine ID when the OCR row carries one.
      const pick = candidates.length === 1
        ? candidates[0]
        : candidates.find((c) => c.machineID) || candidates[0];

      if (seen.has(pick.shiftDetailId)) continue;
      seen.add(pick.shiftDetailId);

      matched.push({
        shiftDetailId: pick.shiftDetailId,
        machineID: pick.machineID,
        operator: pick.operator,
        jobNo: pick.jobNo,
        status: pick.status,
        alreadyClosed: pick.status === "closed",
        production: r.production,
        timer: r.timer,
        remarks: r.remarks,
        confidence: r.confidence,
      });
    }

    // Plan rows that the OCR never produced a value for.
    const missing = [];
    for (const [code, metas] of codeMap.entries()) {
      for (const m of metas) {
        if (!seen.has(m.shiftDetailId)) {
          missing.push({ code, shiftDetailId: m.shiftDetailId, machineID: m.machineID, operator: m.operator, jobNo: m.jobNo });
        }
      }
    }

    return res.json({
      success: true,
      shiftPlanId,
      model: ocr.model,
      pages: ocr.pages,
      batches: ocr.batches,
      summary: {
        planRows: (sp.plan || []).length,
        matched: matched.length,
        unmatched: unmatched.length,
        missing: missing.length,
        lowConfidence: matched.filter((m) => m.confidence < 0.6).length,
      },
      matched,
      unmatched,
      missing,
    });
  })
);

// ════════════════════════════════════════════════════════════════
//  CORRECT / DELETE a VERIFIED production entry
//
//  Editing a closed shift's meters re-derives the linked job/order/
//  plan totals by the delta, fanned across the shift's own head→elastic
//  snapshot (robust to later machine re-config). The parent order's
//  produced rollup is recomputed from the SUM of its jobs (clean, avoids
//  double counting), and pending is recomputed from ordered − produced.
//  Per the agreed scope, the Bayesian rate posterior is NOT rewritten —
//  it self-corrects on future shifts.
// ════════════════════════════════════════════════════════════════
// _rederiveShiftProduction (the delta correction path) moved to
// services/shiftCascadeService.js — imported at the top of this file.

router.put(
  "/production-entry/:shiftId",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(shiftId)) return next(new ErrorHandler("Invalid shift id", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const newTotal = Number(req.body.productionMeters);
    if (!Number.isFinite(newTotal) || newTotal < 0) return next(new ErrorHandler("productionMeters must be ≥ 0", 400));

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const shift = await ShiftDetail.findById(shiftId).session(session);
        if (!shift) throw new ErrorHandler("Shift not found", 404);
        if (shift.status !== "closed") throw new ErrorHandler("Only verified (closed) production entries can be corrected", 400);

        await _rederiveShiftProduction(session, {
          shift, newTotalMeters: newTotal, req, auditReason, code: ACTION_CODES.SHIFT_PRODUCTION_EDITED,
        });
        shift.productionMeters = newTotal;
        await shift.save({ session });
        result = { id: shift._id, productionMeters: shift.productionMeters };
      });
      res.json({ success: true, message: "Production entry corrected", ...result });
    } catch (err) { return next(err); } finally { session.endSession(); }
  })
);

router.delete(
  "/production-entry/:shiftId",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(shiftId)) return next(new ErrorHandler("Invalid shift id", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const shift = await ShiftDetail.findById(shiftId).session(session);
        if (!shift) throw new ErrorHandler("Shift not found", 404);
        if (shift.status !== "closed") throw new ErrorHandler("Only verified (closed) production entries can be deleted", 400);

        // Reverse the full contribution, then un-verify so it can be re-entered.
        await _rederiveShiftProduction(session, {
          shift, newTotalMeters: 0, req, auditReason, code: ACTION_CODES.SHIFT_PRODUCTION_DELETED,
        });
        shift.productionMeters = 0;
        shift.status = "pending_verification";
        shift.verifiedAt = undefined;
        shift.verifiedBy = undefined;
        await shift.save({ session });
        result = { id: shift._id };
      });
      res.json({ success: true, message: "Production entry deleted (reversed and un-verified)", ...result });
    } catch (err) { return next(err); } finally { session.endSession(); }
  })
);

module.exports = router;

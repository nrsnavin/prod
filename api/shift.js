"use strict";

const express  = require("express");
const { renderPdf } = require("../utils/renderPdf");
const router   = express.Router();
const moment   = require("moment");
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { rangeProblem } = require("../utils/listLimit");
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
const { assertShiftProductionOpen } = require("../utils/productionLock");
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");
// Production cascade + anomaly detection live in their own service
// (Phase 4 god-file split). The verify route calls applyProductionCascade;
// it is re-exported on the router below for the characterization test.
const {
  applyProductionCascade,
  _rederiveShiftProduction,
} = require("../services/shiftCascadeService.js");
const multer = require("multer");
// multer finishes from a stream event, which loses the request's
// AsyncLocalStorage stores — the database it routes to and the user
// it audits as. See middleware/userContext.js.
const { keepRequestContext } = require("../middleware/userContext.js");
const { shortCode } = require("../utils/shiftSheetPdf");
const { floorSheetNo } = require("../utils/floorSheetPdf");
const { headsInUse } = require("../utils/machineHeads");
const { pinFor, rotatePin, shapePin } = require("../services/floorEntry");

/** A shift whose machine was being loaded: nothing to enter or verify. */
const LOADING_SHIFT = "This machine was being loaded this shift — there is no production to enter. Mark the machine running and production counts from then.";
const { getPdfBranding } = require("../services/documentSettings.js");
const { extractShiftRows } = require("../utils/shiftSheetOcr");
const { submitProduction } = require("../services/shiftSubmit");
const { createShiftPlan } = require("../services/shiftPlanCreate");
const { VISION_MODEL } = require("../utils/anthropicClient");
const { promptVersion } = require("../utils/aiPrompts");
const ledger = require("../services/aiLedger");
const { totalMeters } = require("../utils/shiftFigures");

// Scanned 200-machine sheets run ~19 pages; allow up to 25 MB in memory.
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(isAuthenticated);

// Per-user feature gate. The two employee self-service reads are exempt:
// a worker listing their OWN shifts answers to their identity (selfOrAdmin
// on those routes) rather than to whether the admin ticked a Shift Plans /
// Verification / Production box. Without the carve-out a packing-department
// worker — whose defaults carry none of those three keys — would be locked
// out of their own shift history and the production-entry screen in the
// employee app, which are the only callers of these two routes.
const SHIFT_FEATURE_KEYS = ['/shift-plans', '/shift-verification', '/production'];
const SELF_SHIFT_READS = new Set(['/employee-open-shifts', '/employee-closed-shifts']);
router.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (SELF_SHIFT_READS.has(req.path) || req.path.startsWith('/active-jobs/'))) {
    return next();
  }
  requireFeature(...SHIFT_FEATURE_KEYS)(req, res, (err) => {
    if (err) return next(err);
    requireFeatureRead(...SHIFT_FEATURE_KEYS)(req, res, next);
  });
});

function normDate(raw) {
  return new Date(new Date(raw).setHours(0, 0, 0, 0));
}

// applyProductionCascade + _checkLowOutputShift + _checkMachineAnomaly
// moved to services/shiftCascadeService.js (Phase 4 god-file split).
// Imported at the top of this file; re-exported as router.applyProductionCascade
// below for the characterization test and any external caller.

// Summary of the day and night plan for a date. `?date=` makes this work
// for any day (the shift-plans page browses past and future dates with it);
// with no date it means today, which is what every existing caller does.
router.get(
  "/today",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const raw = req.query.date;
    if (raw && Number.isNaN(new Date(raw).getTime())) {
      return next(new ErrorHandler("date is not a valid date", 400));
    }
    const today    = normDate(raw ? new Date(raw) : new Date());
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

      // `d.production` is not a field on ShiftDetail — it is
      // `productionMeters` — so this used to sum a column of undefined and
      // report 0 metres for every shift, however busy. See
      // utils/shiftFigures.js, which the machine detail page shares.
      const production = totalMeters(shift.plan);
      const uniqueOperators = new Set(
        shift.plan.filter((d) => d.employee).map((d) => d.employee._id.toString())
      );

      return {
        ...shift,
        // `.lean()` returns the raw document, so there is no `id`
        // virtual — only `_id`. The shift-plans page reads `id` both to
        // decide the shift exists and to open it, so without this the
        // card said "not created" for a date that plainly had a plan.
        // Stated explicitly rather than by dropping .lean(), so the
        // contract does not depend on a mongoose default.
        id: String(shift._id),
        production,
        machinesRunning: shift.plan.length,
        operatorCount:   uniqueOperators.size,
      };
    };

    res.json({
      success: true,
      data: {
        date:       today,
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
    let draftedProduction = 0;
    let pendingCount = 0;
    let verifiedCount = 0;

    const machines = await Promise.all(
      shiftPlan.plan.map(async (detail) => {
        totalProduction += detail.productionMeters || 0;

        const machine = await Machine.findById(detail.machine._id).populate(
          "orderRunning"
        );

        let jobOrderNo = "";
        // Carry the job's production mode onto the row so the shift plan
        // can mark an outsourced job — the floor needs to see at a glance
        // that a machine's job is being made by a vendor, not here.
        let productionMode = "";
        let outsourceVendor = "";
        // The job's own status drives the production lock: once it reaches
        // finishing the machine is released and entry is refused, so the
        // row carries it and the UI stops offering the button.
        let jobStatus = "";
        if (machine?.orderRunning) {
          const job = await JobOrder.findById(machine.orderRunning);
          if (job) {
            jobOrderNo = job.jobOrderNo.toString();
            productionMode = job.productionMode || "in_house";
            outsourceVendor = job.outsourceVendor || "";
            jobStatus = job.status || "";
          }
        }

        // Entered (on the floor, by the operator, or off a slip) but not
        // verified yet: the figures live in the submitted* fields until an
        // admin verifies them, and the plan page shows them as a draft.
        // `submitted.production` is PER HEAD, as entered; `draftProduction`
        // is that across the heads running, the way the verified
        // `production` is stored (see /verify-production).
        const pending = detail.status === "pending_verification";
        const headsRun = pending ? (headsInUse(machine) || 1) : (detail.headsRun || 0);
        const submitted = pending ? {
          production: detail.submittedProductionMeters ?? null,
          timer:      detail.submittedTimer || null,
          feedback:   detail.submittedFeedback || "",
          at:         detail.submittedAt || null,
          byName:     detail.submittedByName || "",
        } : null;
        const draftProduction = pending && submitted.production != null
          ? Math.round(submitted.production * headsRun * 100) / 100
          : 0;
        draftedProduction += draftProduction;
        if (pending) pendingCount += 1;
        if (detail.status === "closed") verifiedCount += 1;

        return {
          machineId: detail.machine._id,
          machineName: detail.machine.ID ||
            `${detail.machine.manufacturer ?? ""} ${detail.machine.ID ?? ""}`.trim(),
          jobOrderNo,
          productionMode,
          outsourceVendor,
          jobStatus,
          operatorName: detail.employee?.name ?? "—",
          production:   detail.productionMeters || 0,
          timer:        detail.timer,
          status:       detail.status,
          headsRun,
          submitted,
          draftProduction,
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
        // Entered but not verified: what the total will be once it is.
        draftedProduction: Math.round(draftedProduction * 100) / 100,
        pendingCount,
        verifiedCount,
        status:          shiftPlan.status,
        finalized:       !!shiftPlan.finalized,
        // Whose plan it is, and — made from the floor — when every running
        // loom was entered and which looms stood free (see models/ShiftPlan.js).
        source:          shiftPlan.source || "office",
        floor:           shiftPlan.floor?.completedAt ? {
          completedAt:  shiftPlan.floor.completedAt,
          completedBy:  shiftPlan.floor.completedBy || "",
          freeMachines: (shiftPlan.floor.freeMachines || []).map((f) => ({ id: String(f.machine), ID: f.ID, why: f.why || "" })),
          loadingMachines: (shiftPlan.floor.loadingMachines || []).map((f) => ({ id: String(f.machine), ID: f.ID, operatorName: f.operatorName || "" })),
        } : null,
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
    const { entries, aiSuggestionId } = req.body;

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

    const { saved, skipped } = await submitProduction(entries, {
      userId: req.user?._id,
      aiSuggestionId,
      surface: 'shift-sheet-ocr',
    });

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
    const tooWide = rangeProblem(moment(start, "YYYY-MM-DD").toDate(), moment(less, "YYYY-MM-DD").toDate());
    if (tooWide) return next(new ErrorHandler(tooWide, 400));

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
    if (shift.status === "loading") return next(new ErrorHandler(LOADING_SHIFT, 409));
    await assertShiftProductionOpen(shift, { JobOrder, Machine }, "enter production");

    // Written only while the shift is still not closed, in one step: see
    // submitWhileOpen. A verification that lands first wins.
    const updated = await submitWhileOpen(shift._id, { $nin: ["closed", "loading"] }, {
      submittedProductionMeters: prodValue,
      submittedTimer:            timer    || "00:00:00",
      submittedFeedback:         feedback || "",
      submittedAt:               new Date(),
      submittedBy:               req.user?._id,
    });
    if (!updated) return next(new ErrorHandler("Shift is already closed", 400));

    res.json({ success: true, shift: updated });
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
    if (shift.status === "loading") return next(new ErrorHandler(LOADING_SHIFT, 409));
    if (!["open", "pending_verification"].includes(shift.status)) {
      return next(new ErrorHandler(
        `Shift cannot be updated in status '${shift.status}'`, 400
      ));
    }
    await assertShiftProductionOpen(shift, { JobOrder, Machine }, "update production");

    const changes = {};
    if (production != null) {
      const prodValue = Number(production);
      if (isNaN(prodValue) || prodValue < 0) {
        return next(new ErrorHandler("production must be a non-negative number", 400));
      }
      changes.submittedProductionMeters = prodValue;
    }
    if (timer    !== undefined) changes.submittedTimer    = timer;
    if (feedback !== undefined) changes.submittedFeedback = feedback;
    changes.submittedAt = new Date();
    changes.submittedBy = req.user?._id;

    const updated = await submitWhileOpen(shift._id, { $in: ["open", "pending_verification"] }, changes);
    if (!updated) {
      return next(new ErrorHandler("Shift cannot be updated: it was verified and closed meanwhile", 400));
    }
    res.json({ success: true, shift: updated });
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
        if (shift.status === "loading") throw new ErrorHandler(LOADING_SHIFT, 409);
        await assertPlanNotFinalized(shift, session);
        await assertShiftProductionOpen(shift, { JobOrder, Machine }, "verify production");

        const machine = await Machine.findById(shift.machine).session(session);

        // Canonical (admin-blessed) values overwrite whatever the
        // worker had typed.
        const finalTimer    = timer    != null ? timer    : (shift.submittedTimer    || "00:00:00");
        const finalFeedback = feedback != null ? feedback : (shift.submittedFeedback || "");

        // Per head × the heads that ran — the job's head plan, which may
        // use fewer heads than the loom has (utils/machineHeads.js). The
        // snapshot is brought up to that plan too, so a later correction
        // (_rederiveShiftProduction) divides by the same heads.
        const runningHeads = (machine?.elastics || []).filter((h) => h && h.elastic);
        if (runningHeads.length) {
          shift.elastics = runningHeads.map((h) => ({ head: h.head, elastic: h.elastic }));
        }
        shift.headsRun         = headsInUse(machine);
        shift.productionMeters = prodValue * shift.headsRun;
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

// selfOrAdmin (reads ?id= from the query): this route is exempt from the
// feature gate above, so identity is what scopes it — without this guard
// any logged-in user could read another worker's shifts, and the exemption
// would be a way around the gate rather than a carve-out of it.
router.get(
  "/employee-open-shifts",
  selfOrAdmin,
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

// selfOrAdmin for the same reason as /employee-open-shifts above.
router.get(
  "/employee-closed-shifts",
  selfOrAdmin,
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

// selfOrAdmin: it returned any employee's loom and job to any production
// login that changed the id. The employee app is its only caller and
// asks for its own worker.
router.get(
  "/active-jobs/:empId",
  selfOrAdmin,
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
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return next(new ErrorHandler("id is not a valid Shift Plan id", 400));
    }

    // One transaction for the plan, its details and every reference to
    // them. This used to walk the details one by one, load each machine
    // and employee, filter its array and save() it back — outside any
    // transaction, and as a read-modify-write, so a save landing in
    // between was silently undone and a failure part-way left a plan
    // with some of its references gone. It also never touched the job's
    // own list of shifts, which was left pointing at deleted details.
    const session = await mongoose.startSession();
    let found = true;
    try {
      await session.withTransaction(async () => {
        found = true;
        const sp = await ShiftPlan.findById(id).select("plan").session(session);
        if (!sp) { found = false; return; }

        const detailIds = sp.plan || [];
        if (detailIds.length) {
          const details = await ShiftDetail.find({ _id: { $in: detailIds } })
            .select("machine employee").session(session).lean();
          const machines = [...new Set(details.map((d) => String(d.machine)).filter(Boolean))];
          const employees = [...new Set(details.map((d) => String(d.employee)).filter(Boolean))];
          const pull = { $pull: { shifts: { $in: detailIds } } };

          if (machines.length) await Machine.updateMany({ _id: { $in: machines } }, pull, { session });
          if (employees.length) await Employee.updateMany({ _id: { $in: employees } }, pull, { session });
          await JobOrder.updateMany(
            { shiftDetails: { $in: detailIds } },
            { $pull: { shiftDetails: { $in: detailIds } } },
            { session }
          );
          await ShiftDetail.deleteMany({ _id: { $in: detailIds } }, { session });
        }
        await ShiftPlan.deleteOne({ _id: id }, { session });
      });
    } finally {
      await session.endSession();
    }

    if (!found) return next(new ErrorHandler("Shift Plan not found", 404));
    res.json({ success: true, message: "Shift Plan deleted successfully" });
  })
);

// ════════════════════════════════════════════════════════════════
//  CREATE A SHIFT PLAN — whole, or not at all
//
//  One transaction: the ShiftPlan, a ShiftDetail per machine and the
//  running jobs' lists of shifts. See services/shiftPlanCreate.js, which
//  a floor sheet read from a photo uses too.
// ════════════════════════════════════════════════════════════════
router.post('/create-shift-plan', isAdmin('admin', 'production'), async (req, res) => {
  const { date, shiftType, description = '', machines = [] } = req.body;
  try {
    const { shiftPlan, detailCount } = await createShiftPlan({ date, shiftType, description, machines });
    return res.status(201).json({
      success: true, shiftPlanId: shiftPlan._id, status: 'draft',
      message: `Shift plan saved as draft (${detailCount} machine(s) included).`,
    });
  } catch (err) {
    if (err.statusCode) {
      // EMPLOYEE_OFFBOARDED carries who, so the form can point at them.
      return res.status(err.statusCode).json({
        success: false, message: err.message,
        ...(typeof err.code === 'string' ? { code: err.code, details: err.details } : {}),
      });
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
//  THE FLOOR PIN
//    GET  /shift/floor-pin?date&shift      the PIN (made the first time), who opened with it
//    POST /shift/floor-pin/rotate { date, shift }   a new PIN; old sessions end
//
//  What a supervisor types on the floor tablet to open this shift's
//  entry screen (services/floorEntry.js).
// ═════════════════════════════════════════════════════════════════
router.get(
  "/floor-pin",
  isAdmin("admin", "production"),
  catchAsyncErrors(async (req, res) => {
    const doc = await pinFor(String(req.query.date || ""), String(req.query.shift || "").toUpperCase(), { createdBy: req.user?._id });
    res.json({ success: true, ...shapePin(doc) });
  })
);
router.post(
  "/floor-pin/rotate",
  isAdmin("admin", "production"),
  catchAsyncErrors(async (req, res) => {
    const doc = await rotatePin(String(req.body.date || ""), String(req.body.shift || "").toUpperCase(), { by: req.user?._id });
    res.json({ success: true, message: "New PIN made. Anyone on the floor with the old one has to enter this one.", ...shapePin(doc) });
  })
);

// ═════════════════════════════════════════════════════════════════
//  GET /shift/floor-sheet.pdf?date=YYYY-MM-DD&shift=DAY|NIGHT
//
//  A production sheet for a shift that has no plan yet: every machine,
//  the job it is running or FREE, and blank Operator / Timer /
//  Production / Supervisor-signature columns with a QR per row. A photo
//  of it filled in can create the plan (Production Slips).
// ═════════════════════════════════════════════════════════════════
router.get(
  "/floor-sheet.pdf",
  isAdmin("admin", "production"),
  catchAsyncErrors(async (req, res, next) => {
    const dateKey = String(req.query.date || moment().format("YYYY-MM-DD"));
    const shift = String(req.query.shift || "DAY").toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !moment(dateKey, "YYYY-MM-DD", true).isValid()) {
      return next(new ErrorHandler("date must look like 2026-10-21", 400));
    }
    if (!["DAY", "NIGHT"].includes(shift)) return next(new ErrorHandler("shift must be DAY or NIGHT", 400));

    const machines = await Machine.find()
      .select("ID status orderRunning elastics loading")
      .populate({ path: "orderRunning", model: "JobOrder", select: "jobOrderNo status" })
      .populate({ path: "elastics.elastic", model: "Elastic", select: "name" })
      .lean();
    machines.sort((a, b) => String(a.ID).localeCompare(String(b.ID), undefined, { numeric: true, sensitivity: "base" }));

    const rows = machines.map((m) => {
      const job = m.orderRunning;
      const names = [...new Set((m.elastics || []).map((e) => e?.elastic?.name).filter(Boolean))];
      return {
        machineId: String(m._id),
        machine: m.ID,
        job: job ? (job.jobOrderNo != null ? `J-${job.jobOrderNo}` : "Job") : null,
        // Still being loaded for the job: said on the sheet, so nobody
        // writes metres against a loom that was not weaving.
        loading: !!job && m.status === "running" && !!m.loading,
        detail: job && names.length ? (names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")) : "",
        status: m.status,
      };
    });

    const sheetNo = floorSheetNo(dateKey, shift);
    const pdf = await renderPdf("floorSheet", {
      sheetNo,
      dateLabel: moment(dateKey, "YYYY-MM-DD").format("DD-MMM-YYYY"),
      shift,
      rows,
      branding: await getPdfBranding(),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="floor-sheet-${dateKey}-${shift}.pdf"`);
    return res.send(pdf);
  })
);

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
          { path: "machine", model: "Machine", select: "ID status loading" },
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
      // A loading shift, or a loom still loading now: nothing to enter.
      loading: d.status === "loading" || (d.machine?.status === "running" && !!d.machine?.loading),
    }));

    const dateLabel = moment(sp.date).format("DD-MMM-YYYY");
    const branding = await getPdfBranding();
    const pdf = await renderPdf('shiftSheet', {
      dateLabel,
      shift: sp.shift,
      planNo: `SP-${moment(sp.date).format("YYYYMMDD")}-${sp.shift === "NIGHT" ? "N" : "D"}`,
      rows,
      branding,
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
  keepRequestContext(sheetUpload.single("file")),
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
    const ocrStartedAt = Date.now();
    try {
      ocr = await extractShiftRows(req.file.buffer);
    } catch (err) {
      if (err.code === "ANTHROPIC_KEY_MISSING") {
        return res.status(503).json({ success: false, reason: "ANTHROPIC_KEY_MISSING", message: err.message });
      }
      console.error("[ingest-sheet] OCR error:", err.message);
      // A failed read is a data point about the surface too — a model
      // that fails one upload in five is not "working", and without
      // this row nothing outside the server log would ever say so.
      await ledger.record({
        surface: "shift-sheet-ocr",
        model: VISION_MODEL,
        promptVersion: promptVersion("shift-sheet-ocr"),
        refType: "ShiftPlan",
        refId: shiftPlanId,
        latencyMs: Date.now() - ocrStartedAt,
        error: err.message,
      });
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

    // What the OCR read, keyed by the ShiftDetail it was matched to, so
    // that /bulk-enter-production can settle the row against what the
    // operator actually saved. Keying by id rather than position is what
    // makes the comparison survive the operator reordering, skipping or
    // part-filling the verification screen.
    const aiSuggestionId = await ledger.record({
      surface: "shift-sheet-ocr",
      model: ocr.model,
      promptVersion: promptVersion("shift-sheet-ocr"),
      refType: "ShiftPlan",
      refId: shiftPlanId,
      proposed: {
        rows: Object.fromEntries(matched.map((m) => [
          m.shiftDetailId,
          { production: m.production, timer: m.timer, remarks: m.remarks },
        ])),
      },
      latencyMs: Date.now() - ocrStartedAt,
    });

    return res.json({
      success: true,
      shiftPlanId,
      model: ocr.model,
      pages: ocr.pages,
      batches: ocr.batches,
      aiSuggestionId: aiSuggestionId ? String(aiSuggestionId) : null,
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

// ════════════════════════════════════════════════════════════════
//  FINALISE / UNFINALISE a shift plan (post-verification lock)
//
//  POST /finalize-plan/:shiftPlanId    — allowed only when every
//  production entry in the plan is verified (closed). From then on
//  corrections, deletions, new entries and re-verification are all
//  rejected: the day's numbers are frozen for payroll and reports.
//  POST /unfinalize-plan/:shiftPlanId  — admin-only undo.
// ════════════════════════════════════════════════════════════════
router.post(
  "/finalize-plan/:shiftPlanId",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftPlanId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(shiftPlanId)) return next(new ErrorHandler("Invalid shift plan id", 400));

    const plan = await ShiftPlan.findById(shiftPlanId).populate("plan", "status");
    if (!plan) return next(new ErrorHandler("Shift plan not found", 404));
    if (plan.finalized) return next(new ErrorHandler("Shift is already finalised", 400));

    const details = plan.plan || [];
    if (details.length === 0) return next(new ErrorHandler("Nothing to finalise — the shift has no production entries", 400));
    // A loading shift has nothing to verify: it is done as it stands.
    const unverified = details.filter((d) => !["closed", "loading"].includes(d.status)).length;
    if (unverified > 0) {
      return next(new ErrorHandler(
        `Cannot finalise — ${unverified} entr${unverified > 1 ? "ies are" : "y is"} not verified yet. Verify every entry first.`,
        400
      ));
    }

    plan.finalized   = true;
    plan.finalizedAt = new Date();
    plan.finalizedBy = req.user?.name || "admin";
    await plan.save();

    res.json({
      success: true,
      message: "Shift finalised — production entries are now locked",
      finalized: true, finalizedAt: plan.finalizedAt, finalizedBy: plan.finalizedBy,
    });
  })
);

router.post(
  "/unfinalize-plan/:shiftPlanId",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { shiftPlanId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(shiftPlanId)) return next(new ErrorHandler("Invalid shift plan id", 400));
    const plan = await ShiftPlan.findById(shiftPlanId);
    if (!plan) return next(new ErrorHandler("Shift plan not found", 404));
    if (!plan.finalized) return next(new ErrorHandler("Shift is not finalised", 400));
    plan.finalized = false;
    plan.finalizedAt = undefined;
    plan.finalizedBy = undefined;
    await plan.save();
    res.json({ success: true, message: "Shift reopened — entries can be corrected again", finalized: false });
  })
);

// Throws when the given ShiftDetail belongs to a finalised plan — used
// by every route that would change a locked shift's numbers.
/**
 * A production entry, written only while the shift's status still
 * matches `allowed`: the check and the write in ONE operation.
 *
 * Read-then-save let a verification land in between: the save then
 * wrote status back to "pending_verification" on a shift that was
 * already closed, and verifying it again added its metres to the job
 * and order a second time. Returns the updated shift, or null when it
 * was closed meanwhile.
 */
function submitWhileOpen(shiftId, allowed, changes) {
  return ShiftDetail.findOneAndUpdate(
    { _id: shiftId, status: allowed },
    { $set: { ...changes, status: "pending_verification" } },
    { new: true }
  );
}

async function assertPlanNotFinalized(shift, session) {
  if (!shift?.shiftPlan) return;
  const q = ShiftPlan.findById(shift.shiftPlan).select("finalized");
  const plan = session ? await q.session(session) : await q;
  if (plan?.finalized) {
    throw new ErrorHandler("This shift is finalised — its production entries are locked. An admin must reopen (unfinalise) it first.", 400);
  }
}

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
        await assertPlanNotFinalized(shift, session);
        await assertShiftProductionOpen(shift, { JobOrder, Machine }, "correct production");

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
        await assertPlanNotFinalized(shift, session);
        await assertShiftProductionOpen(shift, { JobOrder, Machine }, "delete production");

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

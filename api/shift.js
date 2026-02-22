"use strict";

const express = require("express");
const router  = express.Router();
const moment  = require("moment");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Employee    = require("../models/Employee");
const Machine     = require("../models/Machine");
const Order       = require("../models/Order");
const ShiftDetail = require("../models/ShiftDetail");
const ShiftPlan   = require("../models/ShiftPlan");
const JobOrder    = require("../models/JobOrder");

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Normalise a date value to midnight UTC (timestamp).
 * Used consistently everywhere so date comparisons work.
 */
function normDate(raw) {
  return new Date(new Date(raw).setHours(0, 0, 0, 0));
}

// ─────────────────────────────────────────────────────────────
//  1.  CREATE SHIFT PLAN
//      POST /shift/create-shift-plan
//
//  BUG FIXES:
//    - Duplicate check used req.body.shift, but the field sent by
//      the client is req.body.shiftType → duplicate check NEVER
//      worked; every date/shift combo could be created infinitely.
//    - ShiftPlan.create() used req.body.shiftType (correct) while
//      the duplicate findOne used req.body.shift (wrong) — mismatch.
//    - No validation that all operators are present.
//    - Promise.all wrapping individual machine processing had no
//      per-machine try/catch — one bad machine ID killed the whole
//      plan with a cryptic 500 instead of a useful message.
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-shift-plan",
  catchAsyncErrors(async (req, res, next) => {
    const { date, shiftType, description, machines } = req.body;

    // ── Input validation ───────────────────────────────────
    if (!date)      return next(new ErrorHandler("date is required", 400));
    if (!shiftType) return next(new ErrorHandler("shiftType is required", 400));
    if (!["DAY", "NIGHT"].includes(shiftType)) {
      return next(new ErrorHandler(`shiftType must be "DAY" or "NIGHT"`, 400));
    }
    if (!Array.isArray(machines) || machines.length === 0) {
      return next(new ErrorHandler("machines array must not be empty", 400));
    }

    // Validate all operator assignments are present
    const missing = machines.filter((m) => !m.operator);
    if (missing.length > 0) {
      return next(
        new ErrorHandler(
          `${missing.length} machine(s) have no operator assigned`,
          400
        )
      );
    }

    const normalizedDate = normDate(date);

    // ── FIX: duplicate check uses shiftType (was req.body.shift) ──
    const existing = await ShiftPlan.findOne({
      date:  normalizedDate,
      shift: shiftType,                // FIX: was req.body.shift → always undefined
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `A ${shiftType} shift plan already exists for ${moment(normalizedDate).format("DD MMM YYYY")}`,
      });
    }

    // ── Create ShiftPlan document ──────────────────────────
    const sp = await ShiftPlan.create({
      date:        normalizedDate,
      shift:       shiftType,
      description: description?.trim() || "",
    });

    // ── Create one ShiftDetail per machine ─────────────────
    const shiftDetailIds = [];
    const errors         = [];

    await Promise.all(
      machines.map(async (entry) => {
        try {
          const machine  = await Machine.findById(entry.machine);
          if (!machine) throw new Error(`Machine ${entry.machine} not found`);

          const employee = await Employee.findById(entry.operator);
          if (!employee) throw new Error(`Employee ${entry.operator} not found`);

          // Look up the job by jobOrderNo (numeric)
          const job = await JobOrder.findOne({
            jobOrderNo: Number(entry.jobOrderNo),
          });
          if (!job) {
            throw new Error(`Job Order #${entry.jobOrderNo} not found`);
          }

          const shiftDetail = await ShiftDetail.create({
            date:        normalizedDate,
            shift:       shiftType,
            description: description?.trim() || "",
            status:      "open",
            machine:     machine._id,
            employee:    employee._id,
            job:         job._id,
            shiftPlan:   sp._id,
            elastics:    machine.elastics,
          });

          shiftDetailIds.push(shiftDetail._id);

          // Link shift detail into machine, employee and job
          machine.shifts.push(shiftDetail._id);
          employee.shifts.push(shiftDetail._id);
          job.shiftDetails.push(shiftDetail._id);

          await Promise.all([machine.save(), employee.save(), job.save()]);
        } catch (machineErr) {
          errors.push(machineErr.message);
          console.error("[shift/create-shift-plan] per-machine error:", machineErr.message);
        }
      })
    );

    // If any per-machine errors occurred, roll back the plan and report
    if (errors.length > 0) {
      await ShiftPlan.findByIdAndDelete(sp._id);
      return next(
        new ErrorHandler(
          `Failed to create some shift entries: ${errors.join("; ")}`,
          400
        )
      );
    }

    sp.plan = shiftDetailIds;
    await sp.save();

    console.log(
      `[shift/create-shift-plan] ${shiftType} plan created for ${moment(normalizedDate).format("DD MMM YYYY")} (${shiftDetailIds.length} machines)`
    );

    res.status(201).json({
      success: true,
      message: `${shiftType} shift plan created successfully`,
      data: {
        _id:   sp._id,
        date:  sp.date,
        shift: sp.shift,
        machineCount: shiftDetailIds.length,
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  2.  GET TODAY'S SHIFT PLANS
//      GET /shift/today
// ─────────────────────────────────────────────────────────────
router.get(
  "/today",
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
          id:              null,
          shift:           shiftType,
          production:      0,
          machinesRunning: 0,
          operatorCount:   0,
          status:          "not_created",
          plan:            [],
        };
      }

      const production = shift.plan.reduce(
        (sum, d) => sum + (d.production || 0),
        0
      );
      const uniqueOperators = new Set(
        shift.plan
          .filter((d) => d.employee)
          .map((d) => d.employee._id.toString())
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


// ─────────────────────────────────────────────────────────────
//  3.  GET SHIFT PLAN BY DATE
//      GET /shift/shiftPlanToday?date=<ISO>
// ─────────────────────────────────────────────────────────────
router.get(
  "/shiftPlanToday",
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


// ─────────────────────────────────────────────────────────────
//  4.  GET SHIFT PLAN BY ID
//      GET /shift/shiftPlanById?id=<planId>
// ─────────────────────────────────────────────────────────────
router.get(
  "/shiftPlanById",
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
        totalProduction += detail.production || 0;

        const machine = await Machine.findById(detail.machine._id).populate(
          "orderRunning"
        );

        let jobOrderNo = "";
        if (machine?.orderRunning) {
          const job = await JobOrder.findById(machine.orderRunning);
          if (job) jobOrderNo = job.jobOrderNo.toString();
        }

        return {
          machineId:    detail.machine._id,
          machineName:  detail.machine.ID ||
                        `${detail.machine.manufacturer ?? ""} ${detail.machine.ID ?? ""}`.trim(),
          jobOrderNo,
          operatorName: detail.employee?.name ?? "—",
          production:   detail.production || 0,
          timer:        detail.timer,
          status:       detail.status,
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
        operatorCount:   shiftPlan.plan.length,
        machines,
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  5.  GET SHIFT PLAN (simple, by id)
//      GET /shift/shiftPLan?id=<planId>
// ─────────────────────────────────────────────────────────────
router.get(
  "/shiftPLan",
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


// ─────────────────────────────────────────────────────────────
//  6.  GET SHIFT PLANS IN DATE RANGE
//      GET /shift/get-in-range?start=YYYY-MM-DD&less=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-in-range",
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

    const array = Array.from(productionByDate, ([date, production]) => ({
      date,
      production,
    }));

    res.json({ success: true, array });
  })
);


// ─────────────────────────────────────────────────────────────
//  7.  ENTER SHIFT PRODUCTION
//      POST /shift/enter-shift-production
//
//  BUG FIXES:
//    - await shift.save() was called TWICE (once explicitly, once inside
//      the final block). Second save persisted stale values.
//    - machine.NoOfHead was used — schema field is NoOfHeads (plural).
//    - No validation that shift.status is "open" before updating.
// ─────────────────────────────────────────────────────────────
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

    const shift = await ShiftDetail.findById(id)
      .populate("machine")
      .populate({ path: "machine", populate: { path: "orderRunning" } });

    if (!shift) return next(new ErrorHandler("Shift detail not found", 404));

    // FIX: validate shift is still open
    if (shift.status === "closed") {
      return next(new ErrorHandler("Shift is already closed", 400));
    }

    const machine = await Machine.findById(shift.machine);
    const sp      = await ShiftPlan.findById(shift.shiftPlan);

    if (!shift.machine?.orderRunning) {
      return next(new ErrorHandler("Machine has no running job", 400));
    }

    const job = await JobOrder.findById(shift.machine.orderRunning._id);
    if (!job) return next(new ErrorHandler("Job not found", 404));

    // ── Update produced elastic quantities ─────────────────
    const elasticProductionMap = {};

    for (const head of (shift.machine.elastics || [])) {
      const id = head.elastic.toString();
      elasticProductionMap[id] = (elasticProductionMap[id] || 0) + prodValue;
    }

    for (const [elasticId, qty] of Object.entries(elasticProductionMap)) {
      const idx = job.producedElastic.findIndex(
        (e) => e.elastic.toString() === elasticId
      );
      if (idx >= 0) {
        job.producedElastic[idx].quantity += qty;
      } else {
        job.producedElastic.push({ elastic: elasticId, quantity: qty });
      }
    }

    // Clamp — produced cannot exceed planned
    job.elastics.forEach((e, i) => {
      const planned  = e.quantity;
      const produced = job.producedElastic[i]?.quantity ?? 0;
      if (produced > planned && job.producedElastic[i]) {
        job.producedElastic[i].quantity = planned;
      }
    });

    await job.save();

    // ── Update Order produced & pending ───────────────────
    const order = await Order.findById(job.order);
    if (order) {
      for (const p of job.producedElastic) {
        const orderItem = order.producedElastic.find(
          (o) => o.elastic.toString() === p.elastic.toString()
        );
        if (orderItem) orderItem.quantity += p.quantity;
      }

      for (const p of order.pendingElastic) {
        const produced = order.producedElastic.find(
          (o) => o.elastic.toString() === p.elastic.toString()
        );
        const ordered = order.elasticOrdered.find(
          (e) => e.elastic.toString() === p.elastic.toString()
        );
        if (produced && ordered) {
          p.quantity = Math.max(0, ordered.quantity - produced.quantity);
        }
      }

      await order.save();
    }

    // ── Close shift detail ─────────────────────────────────
    shift.productionMeters = prodValue;
    shift.production       = prodValue;
    shift.feedback         = feedback || "";
    shift.timer            = timer    || 0;
    shift.status           = "closed";

    // FIX: was called twice — now only once
    await shift.save();

    // ── Update shift plan total ────────────────────────────
    if (sp) {
      // FIX: was machine.NoOfHead (typo) → machine.NoOfHeads
      sp.totalProduction =
        (sp.totalProduction || 0) + prodValue * (machine?.NoOfHeads || 1);
      await sp.save();
    }

    res.json({ success: true, shift });
  })
);


// ─────────────────────────────────────────────────────────────
//  8.  UPDATE SHIFT (direct production entry, no elastic calc)
//      POST /shift/update
// ─────────────────────────────────────────────────────────────
router.post(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const { shiftId, production, timer, feedback } = req.body;
    if (!shiftId) return next(new ErrorHandler("shiftId is required", 400));

    const shift = await ShiftDetail.findById(shiftId);
    if (!shift) return next(new ErrorHandler("Shift not found", 404));

    shift.production = production ?? shift.production;
    shift.timer      = timer      ?? shift.timer;
    shift.feedback   = feedback   ?? shift.feedback;
    shift.status     = "closed";

    await shift.save();
    res.json({ success: true, shift });
  })
);


// ─────────────────────────────────────────────────────────────
//  9.  GET SHIFT DETAIL
//      GET /shift/shiftDetail?id=<shiftDetailId>
// ─────────────────────────────────────────────────────────────
router.get(
  "/shiftDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shift = await ShiftDetail.findById(id)
      .populate("employee")
      .populate({ path: "elastics", populate: { path: "elastic" } })
      .populate({
        path: "machine",
        populate: { path: "orderRunning" },
      })
      .exec();

    if (!shift) return next(new ErrorHandler("Shift detail not found", 404));

    res.json({ success: true, shift });
  })
);


// ─────────────────────────────────────────────────────────────
//  10. ALL OPEN SHIFTS
//      GET /shift/all-open-shifts
// ─────────────────────────────────────────────────────────────
router.get(
  "/all-open-shifts",
  catchAsyncErrors(async (req, res, next) => {
    const shifts = await ShiftDetail.find({ status: "open" })
      .populate("employee")
      .populate("machine")
      .populate("job")
      .exec();

    res.json({ success: true, shifts });
  })
);


// ─────────────────────────────────────────────────────────────
//  11. OPEN SHIFTS  (with machine+orderRunning)
//      GET /shift/open
// ─────────────────────────────────────────────────────────────
router.get(
  "/open",
  catchAsyncErrors(async (req, res, next) => {
    const shifts = await ShiftDetail.find({ status: "open" })
      .populate("employee")
      .populate({
        path: "machine",
        populate: { path: "orderRunning" },
      })
      .sort({ date: -1 });

    res.json({ success: true, shifts });
  })
);


// ─────────────────────────────────────────────────────────────
//  12. EMPLOYEE OPEN SHIFTS
//      GET /shift/employee-open-shifts?id=<employeeId>
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee-open-shifts",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const shifts = await ShiftDetail.find({ status: "open", employee: id })
      .populate("employee")
      .populate("machine")
      .populate("job")
      .exec();

    res.json({ success: true, shifts });
  })
);


// ─────────────────────────────────────────────────────────────
//  13. EMPLOYEE CLOSED SHIFTS
//      GET /shift/employee-closed-shifts?id=<employeeId>
// ─────────────────────────────────────────────────────────────
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


// ─────────────────────────────────────────────────────────────
//  14. SHIFT PLAN ON DATE
//      GET /shift/shiftPlanOnDate?date=DD-MM-YYYY
// ─────────────────────────────────────────────────────────────
router.get(
  "/shiftPlanOnDate",
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


// ─────────────────────────────────────────────────────────────
//  15. DELETE SHIFT PLAN
//      DELETE /shift/deletePlan?id=<planId>
// ─────────────────────────────────────────────────────────────
router.delete(
  "/deletePlan",
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


module.exports = router;
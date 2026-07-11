"use strict";

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Employee         = require("../models/Employee");
const ShiftDetail      = require("../models/ShiftDetail");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { assertVersion } = require("../utils/versioning");

// All employee management routes are admin-only.
router.use(isAuthenticated, isAdmin('admin'));

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

function clockToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const parts   = timeStr.split(":").map(Number);
  const hours   = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minutes = Number.isFinite(parts[1]) ? parts[1] : 0;
  return hours * 60 + minutes;
}

router.post(
  "/create-employee",
  catchAsyncErrors(async (req, res, next) => {
    const { name, phoneNumber, role, department, aadhar } = req.body;

    if (!name?.trim()) {
      return next(new ErrorHandler("name is required", 400));
    }
    if (!department?.trim()) {
      return next(new ErrorHandler("department is required", 400));
    }

    if (phoneNumber && !/^\d{10}$/.test(phoneNumber)) {
      return next(new ErrorHandler("phoneNumber must be 10 digits", 400));
    }

    if (phoneNumber) {
      const existing = await Employee.findOne({ phoneNumber });
      if (existing) {
        return next(
          new ErrorHandler(
            `An employee with phone number ${phoneNumber} already exists`,
            409
          )
        );
      }
    }

    const employee = await Employee.create({
      name:        name.trim(),
      phoneNumber: phoneNumber?.trim() || undefined,
      role:        role?.trim()        || undefined,
      department:  department.trim(),
      aadhar:      aadhar?.trim()      || undefined,
    });

    console.log(`[employee/create] ${employee.name} registered`);

    res.status(201).json({ success: true, employee });
  })
);

router.get(
  "/get-employees",
  catchAsyncErrors(async (req, res, next) => {
    const { department } = req.query;

    const filter = {};
    if (department && department !== "all") {
      filter.department = department;
    }

    const employees = await Employee.find(filter)
      .select("name phoneNumber role department performance skill")
      .sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

router.get(
  "/get-employee-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    const employee = await Employee.findById(id)
      .populate({
        path: "shifts",
        populate: [
          { path: "machine", model: "Machine", select: "ID" },
        ],
      })
      .exec();

    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    const latestShifts = [...employee.shifts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    const result = latestShifts.map((shift) => {
      const runtimeMinutes = clockToMinutes(shift.timer);
      const efficiency     = runtimeMinutes > 0
        ? Math.min(100, (runtimeMinutes / 720) * 100)
        : 0;

      return {
        id:             shift._id,
        date:           shift.date,
        shift:          shift.shift,
        description:    shift.description || "",
        feedback:       shift.feedback    || "",
        machine:        shift.machine?.ID ?? "—",
        runtimeMinutes,
        outputMeters:   shift.productionMeters || 0,
        efficiency:     parseFloat(efficiency.toFixed(2)),
      };
    });

    res.status(200).json({
      success: true,
      employee: {
        id:          employee._id,
        name:        employee.name,
        phoneNumber: employee.phoneNumber || "—",
        department:  employee.department,
        role:        employee.role        || "—",
        aadhar:      employee.aadhar      || "Not Provided",
        performance: employee.performance || 0,
        skill:       employee.skill       || 0,
        totalShifts: employee.shifts.length,
        result,
      },
    });
  })
);

router.get(
  "/get-employee-weave",
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({ department: "weaving" })
      .select("name phoneNumber role department")
      .sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

router.put(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    const employee = await Employee.findById(id);
    if (!employee) return next(new ErrorHandler("Employee not found", 404));
    // Optimistic lock: reject the edit if another user saved since this
    // client loaded the employee (409 → client reloads).
    assertVersion(employee, req);

    const allowed = ["name", "phoneNumber", "role", "department", "aadhar", "skill"];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        employee[field] = req.body[field];
      }
    }

    employee.increment(); // bump __v so concurrent editors get a 409
    await employee.save();

    res.status(200).json({ success: true, employee });
  })
);

router.patch(
  "/performance",
  catchAsyncErrors(async (req, res, next) => {
    const { id, performance } = req.body;

    if (!id)              return next(new ErrorHandler("id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }
    if (performance == null) {
      return next(new ErrorHandler("performance value is required", 400));
    }

    const value = Number(performance);
    if (isNaN(value) || value < 0 || value > 100) {
      return next(
        new ErrorHandler("performance must be a number between 0 and 100", 400)
      );
    }

    const employee = await Employee.findByIdAndUpdate(
      id,
      { performance: value },
      { new: true, runValidators: true }
    );

    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    res.status(200).json({
      success: true,
      employee: { _id: employee._id, name: employee.name, performance: employee.performance },
    });
  })
);

// ═════════════════════════════════════════════════════════════
//  GET /performance-delta
//  Employees whose current-month avg shift efficiency dropped
//  more than `dropPct`% vs the previous month. Only includes
//  operators with meaningful samples in both windows so we don't
//  flag noise from the first shift of a new joiner.
//
//  Efficiency is computed exactly the same way as the employee
//  detail screen above:
//      eff = min(100, runtimeMinutes / 720 * 100)
//  where 720 = a 12-hour DAY shift in minutes.
// ═════════════════════════════════════════════════════════════
router.get(
  "/performance-delta",
  catchAsyncErrors(async (req, res) => {
    const dropPct      = Math.max(1, parseFloat(req.query.dropPct) || 15);
    const minShifts    = 3;     // per window — drops 1-shift outliers
    const minPrevAvg   = 40;    // ignore operators who were already low

    const now      = new Date();
    const curStart = new Date(now.getFullYear(), now.getMonth(),     1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Pull every closed shift in the two-month window in one query,
    // then bucket per (employee, month) in memory. Cheaper than two
    // round-trips and lets us reuse the same clockToMinutes helper.
    const shifts = await ShiftDetail.find({
      status: "closed",
      date:   { $gte: prevStart },
    })
      .select("employee date timer")
      .lean();

    const buckets = new Map();   // employeeId → { cur: [eff...], prev: [eff...] }
    for (const s of shifts) {
      if (!s.employee) continue;
      const runtime    = clockToMinutes(s.timer);
      const efficiency = runtime > 0 ? Math.min(100, (runtime / 720) * 100) : 0;
      const bucket     = new Date(s.date) >= curStart ? "cur" : "prev";
      const key        = String(s.employee);
      if (!buckets.has(key)) buckets.set(key, { cur: [], prev: [] });
      buckets.get(key)[bucket].push(efficiency);
    }

    const candidateIds = [];
    const deltas       = new Map();   // employeeId → { cur, prev, dropPct }
    for (const [empId, { cur, prev }] of buckets) {
      if (cur.length < minShifts || prev.length < minShifts) continue;
      const curAvg  = cur.reduce((a, b) => a + b, 0)  / cur.length;
      const prevAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
      if (prevAvg < minPrevAvg) continue;
      const drop = ((prevAvg - curAvg) / prevAvg) * 100;
      if (drop > dropPct) {
        candidateIds.push(empId);
        deltas.set(empId, {
          currentAvg:  parseFloat(curAvg.toFixed(2)),
          previousAvg: parseFloat(prevAvg.toFixed(2)),
          dropPct:     parseFloat(drop.toFixed(2)),
        });
      }
    }

    if (candidateIds.length === 0) {
      return res.json({ success: true, employees: [], count: 0 });
    }

    const employees = await Employee.find({
      _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("name department")
      .lean();

    const out = employees
      .map((e) => {
        const d = deltas.get(String(e._id));
        return {
          employeeId:  e._id,
          name:        e.name,
          department:  e.department,
          ...d,
        };
      })
      .sort((a, b) => b.dropPct - a.dropPct);

    return res.json({ success: true, employees: out, count: out.length });
  })
);

module.exports = router;

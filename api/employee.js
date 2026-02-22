"use strict";

const express = require("express");
const router  = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Employee         = require("../models/Employee");
const ShiftDetail      = require("../models/ShiftDetail");

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

// ─────────────────────────────────────────────────────────────
//  1.  CREATE EMPLOYEE
//      POST /employee/create-employee
//
//  FIX: original had no field validation — all fields passed
//       blindly to Employee.create(). Empty-name employees and
//       invalid phone numbers could be stored.
// ─────────────────────────────────────────────────────────────
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

    // Optional phone validation
    if (phoneNumber && !/^\d{10}$/.test(phoneNumber)) {
      return next(new ErrorHandler("phoneNumber must be 10 digits", 400));
    }

    // Duplicate check (same name + phone)
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

// ─────────────────────────────────────────────────────────────
//  2.  GET ALL EMPLOYEES
//      GET /employee/get-employees
//
//  FIX: was returning 201 (Created) for a GET list → now 200.
//  Added optional ?department= filter.
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  3.  GET EMPLOYEE DETAIL + LAST 10 SHIFTS
//      GET /employee/get-employee-detail?id=<_id>
//
//  FIX: original populate options ({ limit, sort }) were inside
//       populate() which Mongoose doesn't reliably support →
//       ALL shifts returned unsorted. Now sorted + sliced after
//       populate.
//  FIX: shift.employee could be null if employee was deleted →
//       caused TypeError on .name access.
//  FIX: efficiency could divide by zero when timer is "00:00:00".
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-employee-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const employee = await Employee.findById(id)
      .populate({
        path: "shifts",
        populate: [
          { path: "machine", model: "Machine", select: "ID" },
        ],
      })
      .exec();

    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    // FIX: sort + limit AFTER populate
    const latestShifts = [...employee.shifts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    const result = latestShifts.map((shift) => {
      const runtimeMinutes = clockToMinutes(shift.timer);
      // FIX: avoid division by zero; efficiency capped at 100%
      const efficiency     = runtimeMinutes > 0
        ? Math.min(100, (runtimeMinutes / 720) * 100)
        : 0;

      return {
        id:             shift._id,
        date:           shift.date,
        shift:          shift.shift,
        description:    shift.description || "",
        feedback:       shift.feedback    || "",
        // FIX: machine may be null if deleted
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

// ─────────────────────────────────────────────────────────────
//  4.  GET WEAVING EMPLOYEES  (for shift plan operator dropdown)
//      GET /employee/get-employee-weave
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-employee-weave",
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({ department: "weaving" })
      .select("name phoneNumber role department")
      .sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

// ─────────────────────────────────────────────────────────────
//  5.  UPDATE EMPLOYEE
//      PUT /employee/update?id=<_id>
// ─────────────────────────────────────────────────────────────
router.put(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("id is required", 400));

    const employee = await Employee.findById(id);
    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    const allowed = ["name", "phoneNumber", "role", "department", "aadhar", "skill"];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        employee[field] = req.body[field];
      }
    }

    await employee.save();

    res.status(200).json({ success: true, employee });
  })
);

// ─────────────────────────────────────────────────────────────
//  6.  UPDATE PERFORMANCE SCORE
//      PATCH /employee/performance
//
//  Called by other services (e.g. after closing a shift) to
//  recalculate the employee's overall performance rating.
// ─────────────────────────────────────────────────────────────
router.patch(
  "/performance",
  catchAsyncErrors(async (req, res, next) => {
    const { id, performance } = req.body;

    if (!id)              return next(new ErrorHandler("id is required", 400));
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

module.exports = router;
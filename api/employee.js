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
const aadhaar = require("../utils/aadhaar");
const { validate, fields: { text, textish, numberish, objectId }, z } = require("../middleware/validate");

// Request shapes (middleware/validate.js). The skill profile is nested
// and the model validates its levels; here it only has to be an object.
const EMPLOYEE_FIELDS = {
  name: text(100).optional(),
  phoneNumber: textish(20).nullable().optional(),
  role: text(100).nullable().optional(),
  department: text(50).optional(),
  aadhar: textish(30).nullable().optional(),
  hourlyRate: numberish.nullable().optional(),
  skillProfile: z.record(z.unknown()).nullable().optional(),
};
const { recordAccess } = require("../utils/accessLog");
const { ACTION_CODES } = require("../utils/fingerprint");

/** The masked number for a stored value, or null when there is none. */
function maskedAadhaar(stored) {
  if (!stored) return null;
  try {
    const plain = aadhaar.open(stored);
    return plain && plain !== "Not Provided" ? aadhaar.mask(plain) : null;
  } catch (err) {
    console.error("[aadhaar] could not read a stored number:", err.message);
    return "XXXX";
  }
}

/** An employee as the API returns it: never the stored Aadhaar value. */
function publicEmployee(doc) {
  const out = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const stored = out.aadhar;
  delete out.aadhar;
  if (stored !== undefined) out.aadhar = maskedAadhaar(stored);
  return out;
}

// All employee management routes are admin-only.
router.use(isAuthenticated, isAdmin('admin', 'accounts', 'production'));

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

// Registering a worker is the admin's alone. Supervisors (production)
// and accounts still read and correct employee records below, but a new
// person on the payroll — and so a new login the admin may hand them —
// starts with an admin.
router.post(
  "/create-employee",
  isAdmin("admin"),
  validate({ body: z.object(EMPLOYEE_FIELDS) }),
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

    const hourlyRate = Number(req.body.hourlyRate);
    const employee = await Employee.create({
      name:        name.trim(),
      phoneNumber: phoneNumber?.trim() || undefined,
      role:        role?.trim()        || undefined,
      department:  department.trim(),
      aadhar:      aadhaar.seal(aadhar?.trim()) || undefined,
      // Shift salary from the onboarding form (stored as ₹/hour; the
      // web form converts a DAY-shift salary ÷ 12h).
      hourlyRate:  Number.isFinite(hourlyRate) && hourlyRate >= 0 ? hourlyRate : 0,
      // Skill & performance questionnaire — schema enums validate levels.
      skillProfile: req.body.skillProfile || undefined,
    });

    console.log(`[employee/create] ${employee.name} registered`);

    res.status(201).json({ success: true, employee: publicEmployee(employee) });
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

    // The person's shifts are read from ShiftDetail by its `employee`
    // ref — ten newest, and a count — not from Employee.shifts.
    //
    // That array held one ref per shift ever worked, and this route
    // populated ALL of them (with each one's machine), sorted them in
    // JavaScript and threw all but ten away: the page got slower by about
    // 730 documents per operator per year, for good. The array was also
    // wrong for older data, since the plan route once pushed a whole
    // plan's shifts onto every operator in it — so "Total shifts" was
    // inflated, and is now the true count. Indexed { employee, createdAt }.
    const employee = await Employee.findById(id).select("-shifts +aadhar").exec();

    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    const [latestShifts, totalShifts] = await Promise.all([
      ShiftDetail.find({ employee: employee._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate({ path: "machine", model: "Machine", select: "ID" })
        .lean(),
      ShiftDetail.countDocuments({ employee: employee._id }),
    ]);

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
        // Masked for everyone; an admin sees the full number by asking
        // for it (GET /aadhaar), which is recorded.
        aadhar:      maskedAadhaar(employee.aadhar) || "Not Provided",
        performance: employee.performance || 0,
        skill:       employee.skill       || 0,
        hourlyRate:  employee.hourlyRate  || 0,
        skillProfile: employee.skillProfile || null,
        totalShifts,
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

// GET /employee/aadhaar?id= — the full number, for an admin who asks.
// Every answer is recorded in the audit trail (who looked, at whose).
router.get(
  "/aadhaar",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!mongoose.Types.ObjectId.isValid(id)) return next(new ErrorHandler("Invalid employee id", 400));
    const employee = await Employee.findById(id).select("name +aadhar").lean();
    if (!employee) return next(new ErrorHandler("Employee not found", 404));
    const plain = employee.aadhar ? aadhaar.open(employee.aadhar) : null;
    await recordAccess(req, ACTION_CODES.AADHAAR_VIEWED, { _id: employee._id, name: employee.name });
    res.json({ success: true, aadhar: plain && plain !== "Not Provided" ? plain : null });
  })
);

router.put(
  "/update",
  validate({
    query: z.object({ id: objectId }).passthrough(),
    body: z.object({ ...EMPLOYEE_FIELDS, skill: numberish.nullable().optional(), expectedVersion: numberish.optional() }),
  }),
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

    // The phone number is what a worker signs in with, so two employees
    // must never share one. Checked only when it changes, so a legacy
    // duplicate does not block unrelated edits to either record.
    if (req.body.phoneNumber !== undefined) {
      const raw = req.body.phoneNumber;
      const phone = raw == null ? "" : String(raw).trim();
      if (phone && !/^\d{10}$/.test(phone)) {
        return next(new ErrorHandler("phoneNumber must be 10 digits", 400));
      }
      if (phone && phone !== employee.phoneNumber) {
        const clash = await Employee.exists({ phoneNumber: phone, _id: { $ne: employee._id } });
        if (clash) {
          return next(new ErrorHandler(`An employee with phone number ${phone} already exists`, 409));
        }
      }
      req.body.phoneNumber = phone; // "" still clears it, as before
    }

    // Aadhaar: what comes back from the edit form is the masked number
    // (or "Not Provided"), never the real one. That means "unchanged",
    // and must never overwrite it. A new number is an admin's to set.
    if (req.body.aadhar !== undefined) {
      const typed = req.body.aadhar == null ? "" : String(req.body.aadhar).trim();
      if (aadhaar.looksMasked(typed) || typed === "Not Provided") {
        delete req.body.aadhar;
      } else if (req.user?.role !== "admin") {
        return next(new ErrorHandler("Only an admin can change an Aadhaar number", 403));
      } else {
        req.body.aadhar = typed ? aadhaar.seal(typed) : "";
      }
    }

    const allowed = ["name", "phoneNumber", "role", "department", "aadhar", "skill", "hourlyRate", "skillProfile"];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        employee[field] = req.body[field];
      }
    }

    employee.increment(); // bump __v so concurrent editors get a 409
    await employee.save();

    res.status(200).json({ success: true, employee: publicEmployee(employee) });
  })
);

router.patch(
  "/performance",
  validate({ body: z.object({ id: text(30).optional(), performance: numberish.nullable().optional() }) }),
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

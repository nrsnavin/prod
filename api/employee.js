"use strict";

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Employee         = require("../models/Employee");
const ShiftDetail      = require("../models/ShiftDetail");
const User             = require("../models/User");
const { OFFBOARD_REASONS } = require("../models/Employee");
const { stillHere, dayOf, factoryToday, fmtDay } = require("../utils/employeeStatus");
const { isSelfServiceOnly } = require("../utils/features");
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
  skillProfile: z.record(z.string(), z.unknown()).nullable().optional(),
  // As on the Aadhaar card (its QR code can fill them).
  dob: textish(10).nullable().optional(),
  gender: text(10).nullable().optional(),
  address: text(400).nullable().optional(),
  pincode: textish(6).nullable().optional(),
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

/**
 * Date of birth, gender, address and pin code as they may be stored;
 * "" clears one. { values } or { error }.
 */
function personalFields(body) {
  const values = {};
  const str = (v) => (v == null ? "" : String(v).trim());
  if (body.dob !== undefined) {
    const v = str(body.dob);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "Date of birth must be a date (YYYY-MM-DD)" };
    values.dob = v;
  }
  if (body.gender !== undefined) {
    const v = str(body.gender).toLowerCase();
    if (v && !["male", "female", "other"].includes(v)) return { error: "Gender must be male, female or other" };
    values.gender = v;
  }
  if (body.address !== undefined) values.address = str(body.address).slice(0, 400);
  if (body.pincode !== undefined) {
    const v = str(body.pincode);
    if (v && !/^\d{6}$/.test(v)) return { error: "Pin code must be 6 digits" };
    values.pincode = v;
  }
  return { values };
}

const CONSENT_NEEDED = "The employee's consent is needed to check their Aadhaar QR code";

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
// ── An Aadhaar or PAN card read into the new-employee form ──
//  POST /read-id  multipart "files" → name, date of birth, gender, PAN and
//  the Aadhaar number (to the form being filled only, checked by its
//  Verhoeff digit; the accuracy record keeps its last four). Nothing saved.
const idUpload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 2 } });
router.post(
  "/read-id",
  isAdmin("admin"),
  require("../middleware/userContext").keepRequestContext(idUpload.array("files", 2)),
  // Photos only: no text fields are taken from the body.
  validate({ body: z.object({}).strict() }),
  catchAsyncErrors(async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return next(new ErrorHandler("Photograph the Aadhaar or PAN card", 400));
    const aiLedger = require("../services/aiLedger");
    const { promptVersion } = require("../utils/aiPrompts");
    const { failure } = require("../utils/docRead");
    let read;
    try { read = await require("../utils/kycOcr").readIdCard(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype }))); } catch (err) {
      const f = failure(err, "ID card");
      if (f.status === 502) await aiLedger.record({ surface: "id-card-ocr", model: "?", promptVersion: promptVersion("id-card-ocr"), error: err.message });
      return next(new ErrorHandler(f.message, f.status));
    }
    if (read.problem) return res.json({ success: true, read, aiSuggestion: null });
    const { model, usage, latencyMs, ...fields } = read;
    const aiSuggestion = await aiLedger.record({
      surface: "id-card-ocr", model, promptVersion: promptVersion("id-card-ocr"), refType: "Employee",
      proposed: { kind: fields.kind, name: fields.name, dob: fields.dob, gender: fields.gender, panLast4: fields.pan.slice(-4), aadhaarLast4: fields.aadhaarLast4, aadhaarValid: fields.aadhaarValid },
      latencyMs, usage,
    });
    res.set("Cache-Control", "no-store");
    res.json({ success: true, read: fields, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null });
  })
);

// ── The QR code on an Aadhaar card ──
//  POST /aadhaar-qr { qr, consent: true, employeeId?, compare? }
//  Reads the card's QR code and checks UIDAI's signature on it
//  (utils/aadhaarQr.js), then compares the card with the employee or,
//  on the new-employee form, with what has been typed (`compare`). With
//  an employee, the outcome is kept on their record and the check goes
//  in the access log. Offline verification is the holder's to agree to,
//  so the request has to say they did.
router.post(
  "/aadhaar-qr",
  isAdmin("admin"),
  validate({ body: z.object({
    qr: text(12000),
    consent: z.boolean().optional(),
    employeeId: objectId.optional(),
    compare: z.object({
      name: text(100).nullable().optional(),
      phoneNumber: textish(20).nullable().optional(),
      aadhar: textish(30).nullable().optional(),
    }).optional(),
  }) }),
  catchAsyncErrors(async (req, res, next) => {
    if (req.body.consent !== true) return next(new ErrorHandler(CONSENT_NEEDED, 400));
    const qr = require("../utils/aadhaarQr");
    let read;
    try { read = await qr.readAadhaarQr(req.body.qr); } catch (err) {
      return next(new ErrorHandler(err.message, err.status || 400));
    }
    let employee = null;
    let against = req.body.compare || {};
    if (req.body.employeeId) {
      employee = await Employee.findById(req.body.employeeId).select("name phoneNumber +aadhar").lean();
      if (!employee) return next(new ErrorHandler("Employee not found", 404));
      let number = null;
      try { number = employee.aadhar ? aadhaar.open(employee.aadhar) : null; } catch { number = null; }
      against = { name: employee.name, phoneNumber: employee.phoneNumber, aadhar: number };
    }
    const matches = qr.compare(read, against);
    let check = null;
    if (employee) {
      check = qr.checkRecord(read, matches, req.user);
      // Not a save of the record: an edit form open on it keeps its version.
      await Employee.updateOne({ _id: employee._id }, { $set: { aadhaarCheck: check } });
      await recordAccess(req, ACTION_CODES.AADHAAR_QR_CHECKED, { _id: employee._id, name: employee.name }, { signature: check.signature, layout: check.layout });
    }
    res.set("Cache-Control", "no-store");
    res.json({ success: true, read: qr.publicRead(read), matches, check });
  })
);

router.post(
  "/create-employee",
  isAdmin("admin"),
  validate({ body: z.object({
    ...EMPLOYEE_FIELDS,
    // The card's QR code, when it was scanned on the form: read again
    // here, so what is kept is what the card says.
    aadhaarQr: text(12000).optional(),
    aadhaarQrConsent: z.boolean().optional(),
  }) }),
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
      const existing = await Employee.findOne({ phoneNumber }).select("name status").lean();
      if (existing?.status === "offboarded") {
        return next(new ErrorHandler(
          `${phoneNumber} belongs to ${existing.name}, who has left. Reinstate them from their page instead of adding them again.`,
          409
        ));
      }
      if (existing) {
        return next(
          new ErrorHandler(
            `An employee with phone number ${phoneNumber} already exists`,
            409
          )
        );
      }
    }

    const personal = personalFields(req.body);
    if (personal.error) return next(new ErrorHandler(personal.error, 400));
    let qrCheck = null;
    if (req.body.aadhaarQr) {
      if (req.body.aadhaarQrConsent !== true) return next(new ErrorHandler(CONSENT_NEEDED, 400));
      const qr = require("../utils/aadhaarQr");
      let read;
      try { read = await qr.readAadhaarQr(req.body.aadhaarQr); } catch (err) {
        return next(new ErrorHandler(err.message, err.status || 400));
      }
      qrCheck = qr.checkRecord(read, qr.compare(read, { name, phoneNumber, aadhar }), req.user);
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
      ...Object.fromEntries(Object.entries(personal.values).filter(([, v]) => v !== "")),
      aadhaarCheck: qrCheck || undefined,
    });
    if (qrCheck) {
      await recordAccess(req, ACTION_CODES.AADHAAR_QR_CHECKED, { _id: employee._id, name: employee.name }, { signature: qrCheck.signature, layout: qrCheck.layout });
    }

    console.log(`[employee/create] ${employee.name} registered`);

    res.status(201).json({ success: true, employee: publicEmployee(employee) });
  })
);

router.get(
  "/get-employees",
  catchAsyncErrors(async (req, res, next) => {
    const { department, status = "active" } = req.query;

    // active (the default): still working here today, someone serving
    // notice included. left: gone by today. all: everyone ever.
    let filter = {};
    if (status === "left") {
      filter = { status: "offboarded", "offboarding.lastWorkingDay": { $lt: dayOf(factoryToday()) } };
    } else if (status !== "all") {
      filter = stillHere();
    }
    if (department && department !== "all") {
      filter = { $and: [filter, { department }] };
    }

    const employees = await Employee.find(filter)
      .select("name phoneNumber role department performance skill status offboarding.lastWorkingDay offboarding.reason")
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
        // The version an edit sends back as expectedVersion, so a second
        // person's save is a 409 instead of overwriting the first.
        __v:         employee.__v ?? 0,
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
        // As on their Aadhaar card, and the last check of its QR code
        // (none until someone checks it).
        dob:         employee.dob     || "",
        gender:      employee.gender  || "",
        address:     employee.address || "",
        pincode:     employee.pincode || "",
        aadhaarCheck: employee.aadhaarCheck?.at ? (employee.toObject?.().aadhaarCheck ?? employee.aadhaarCheck) : null,
        status:      employee.status || "active",
        offboarding: employee.status === "offboarded" ? {
          lastWorkingDay: employee.offboarding?.lastWorkingDay ?? null,
          reason:         employee.offboarding?.reason ?? null,
          note:           employee.offboarding?.note || "",
          recordedByName: employee.offboarding?.recordedByName || "",
          recordedAt:     employee.offboarding?.recordedAt ?? null,
        } : null,
        pastOffboardings: employee.pastOffboardings || [],
        totalShifts,
        result,
      },
    });
  })
);

router.get(
  "/get-employee-weave",
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({ $and: [{ department: "weaving" }, stillHere()] })
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

    const personal = personalFields(req.body);
    if (personal.error) return next(new ErrorHandler(personal.error, 400));
    Object.assign(req.body, personal.values);

    const allowed = ["name", "phoneNumber", "role", "department", "aadhar", "skill", "hourlyRate", "skillProfile", "dob", "gender", "address", "pincode"];
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

    // Someone who has left is no longer anyone's concern here.
    const employees = await Employee.find({
      $and: [{ _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) } }, stillHere()],
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

// ══════════════════════════════════════════════════════════════
//  OFFBOARDING — someone leaves
//
//    POST /employee/:id/offboard   { lastWorkingDay: "YYYY-MM-DD", reason, note? }
//    POST /employee/:id/reinstate  { note? }   — rehired
//
//  Admin only. Nothing of theirs is deleted: shifts, attendance, pay and
//  bonus stay as they were, and periods they worked in still count them
//  (utils/employeeStatus.js). From the day after their last working day
//  they are out of the pickers and rosters and cannot be put on a shift.
//
//  Refused while they are on a shift after their last working day — a
//  planned loom would be left with nobody on it; move it first.
//
//  A worker login (phone + PIN) is closed at once: the PIN removed and
//  every open session ended. Any other login of theirs stops working
//  the day after the last working day, sessions already open included
//  (utils/session.js closedReason) — except an administrator's, which an
//  HR entry never closes. The reply says which; either way the login
//  stays listed under Users for the admin to remove.
// ══════════════════════════════════════════════════════════════
const OFFBOARD_BODY = z.object({
  lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lastWorkingDay must look like 2026-10-31"),
  reason: z.enum(OFFBOARD_REASONS),
  note: z.string().max(500).optional(),
});

router.post(
  "/:id/offboard",
  isAdmin("admin"),
  validate({ body: OFFBOARD_BODY }),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Employee not found", 404));
    const last = dayOf(req.body.lastWorkingDay);
    if (!last) return next(new ErrorHandler("lastWorkingDay is not a date", 400));

    const employee = await Employee.findById(req.params.id).select("name status offboarding").lean();
    if (!employee) return next(new ErrorHandler("Employee not found", 404));
    if (employee.status === "offboarded") {
      return next(new ErrorHandler(
        `${employee.name} is already recorded as leaving on ${fmtDay(employee.offboarding?.lastWorkingDay)}.`, 409));
    }

    // On a shift after the last day: planned (nobody would run the loom)
    // or even verified (then the last day is wrong).
    const later = await ShiftDetail.find({ employee: employee._id, date: { $gt: last } })
      .select("date shift status machine")
      .populate({ path: "machine", model: "Machine", select: "ID" })
      .sort({ date: 1 })
      .limit(20)
      .lean();
    if (later.length) {
      const err = new ErrorHandler(
        `${employee.name} is on ${later.length === 20 ? "20 or more shifts" : `${later.length} shift${later.length === 1 ? "" : "s"}`} ` +
        `after ${fmtDay(last)}. Put someone else on ${later.length === 1 ? "it" : "them"} first, or pick a later last working day.`,
        409);
      err.code = "EMPLOYEE_HAS_LATER_SHIFTS";
      err.details = {
        shifts: later.map((d) => ({
          id: String(d._id), date: d.date, shift: d.shift || null, status: d.status, machine: d.machine?.ID ?? null,
        })),
      };
      return next(err);
    }

    const note = (req.body.note || "").trim();
    const session = await mongoose.startSession();
    let login = null;
    let closedPhoneSignIn = false;
    try {
      await session.withTransaction(async () => {
        closedPhoneSignIn = false;
        const updated = await Employee.updateOne(
          { _id: employee._id, status: { $ne: "offboarded" } },
          {
            $set: {
              status: "offboarded",
              offboarding: {
                lastWorkingDay: last,
                reason: req.body.reason,
                note,
                recordedBy: req.user?._id,
                recordedByName: req.user?.name || "",
                recordedAt: new Date(),
              },
            },
          },
          { session }
        );
        if (!updated.modifiedCount) throw new ErrorHandler(`${employee.name} was offboarded meanwhile.`, 409);

        login = await User.findOne({ employee: employee._id })
          .select("name email department role features employee +pin").session(session);
        if (login && isSelfServiceOnly(login)) {
          // Their way in goes now, and so does every session open on a phone.
          closedPhoneSignIn = !!login.pin;
          await User.updateOne(
            { _id: login._id },
            { $unset: { pin: 1, pinLockedUntil: 1 }, $set: { pinAttempts: 0 }, $inc: { tokenVersion: 1 } },
            { session }
          );
        }
      });
    } catch (err) {
      return next(err);
    } finally {
      await session.endSession();
    }

    if (login && isSelfServiceOnly(login)) {
      await recordAccess(req, ACTION_CODES.PHONE_SIGNIN_OFF, login, {
        employee: String(employee._id), via: "offboarding", hadPin: closedPhoneSignIn,
      });
    }
    console.log(`[employee/offboard] ${employee.name} — last day ${fmtDay(last)} (${req.body.reason})`);

    res.json({
      success: true,
      employee: { id: String(employee._id), name: employee.name, status: "offboarded", lastWorkingDay: last, reason: req.body.reason },
      workerLoginClosed: !!(login && isSelfServiceOnly(login)),
      // Still listed under Users. `staysOpen`: an administrator's login,
      // which leaving does not close — that one the admin must remove.
      managerLogin: login && !isSelfServiceOnly(login)
        ? { id: String(login._id), email: login.email, staysOpen: login.role === "admin" }
        : null,
    });
  })
);

router.post(
  "/:id/reinstate",
  isAdmin("admin"),
  validate({ body: z.object({ note: z.string().max(500).optional() }) }),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Employee not found", 404));
    const employee = await Employee.findById(req.params.id).select("name status offboarding").lean();
    if (!employee) return next(new ErrorHandler("Employee not found", 404));
    if (employee.status !== "offboarded") return next(new ErrorHandler(`${employee.name} has not left.`, 409));

    const o = employee.offboarding || {};
    const note = (req.body.note || "").trim();
    const updated = await Employee.updateOne(
      { _id: employee._id, status: "offboarded" },
      {
        $set: { status: "active" },
        $unset: { offboarding: 1 },
        // What happened before is kept: when they left, why, and when they came back.
        $push: {
          pastOffboardings: {
            lastWorkingDay: o.lastWorkingDay,
            reason: o.reason,
            note: [o.note, note && `Reinstated: ${note}`].filter(Boolean).join(" · "),
            recordedByName: o.recordedByName || "",
            recordedAt: o.recordedAt,
            reinstatedAt: new Date(),
            reinstatedByName: req.user?.name || "",
          },
        },
      }
    );
    if (!updated.modifiedCount) return next(new ErrorHandler(`${employee.name} was reinstated meanwhile.`, 409));
    console.log(`[employee/reinstate] ${employee.name}`);
    // Phone sign-in is not turned back on: the admin sets a new PIN.
    res.json({ success: true, employee: { id: String(employee._id), name: employee.name, status: "active" } });
  })
);

module.exports = router;

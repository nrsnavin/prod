"use strict";

const express = require("express");
const router  = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Machine          = require("../models/Machine");

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Convert "HH:MM" timer string → total minutes.
 * FIX: original parseClockTimeToMinutes() returned NaN for
 *      null/undefined input on some Node versions because
 *      "".split(":").map(Number) → [NaN]. Added null guard.
 */
function clockToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const parts   = timeStr.split(":").map(Number);
  const hours   = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minutes = Number.isFinite(parts[1]) ? parts[1] : 0;
  return hours * 60 + minutes;
}

// ─────────────────────────────────────────────────────────────
//  1.  CREATE MACHINE
//      POST /machine/create-machine
//
//  FIX: original swallowed all errors via try/catch and called
//       next(new ErrorHandler(error, 400)) with the full Error
//       object instead of error.message → "object Object" in response.
//  Added: validation for required fields before hitting the DB.
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-machine",
  catchAsyncErrors(async (req, res, next) => {
    const { ID, manufacturer, NoOfHead, NoOfHooks } = req.body;

    // ── Validate ───────────────────────────────────────────
    if (!ID?.trim())           return next(new ErrorHandler("Machine ID is required", 400));
    if (!manufacturer?.trim()) return next(new ErrorHandler("Manufacturer is required", 400));
    if (!NoOfHead || isNaN(Number(NoOfHead)) || Number(NoOfHead) < 1) {
      return next(new ErrorHandler("NoOfHead must be a positive number", 400));
    }
    if (!NoOfHooks || isNaN(Number(NoOfHooks)) || Number(NoOfHooks) < 1) {
      return next(new ErrorHandler("NoOfHooks must be a positive number", 400));
    }

    // ── Duplicate check ────────────────────────────────────
    const existing = await Machine.findOne({ ID: ID.trim().toUpperCase() });
    if (existing) {
      return next(
        new ErrorHandler(`Machine with ID "${ID}" already exists`, 409)
      );
    }

    const machine = await Machine.create({
      ID:           ID.trim().toUpperCase(),
      manufacturer: manufacturer.trim(),
      NoOfHead:     Number(NoOfHead),
      NoOfHooks:    Number(NoOfHooks),
      DateOfPurchase: req.body.DateOfPurchase || null,
      status:       "free",
    });

    console.log(`[machine/create] Machine ${machine.ID} registered`);

    res.status(201).json({ success: true, machine });
  })
);

// ─────────────────────────────────────────────────────────────
//  2.  LIST ALL MACHINES
//      GET /machine/get-machines
//
//  FIX: status code was 201 (Created) for a GET → now 200.
//  Added optional ?status= filter query param.
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-machines",
  catchAsyncErrors(async (req, res, next) => {
    const { status } = req.query;

    const filter = {};
    if (status && ["free", "running", "maintenance"].includes(status)) {
      filter.status = status;
    }

    const machines = await Machine.find(filter)
      .select("ID manufacturer NoOfHead NoOfHooks status DateOfPurchase")
      .sort({ ID: 1 });

    res.status(200).json({ success: true, machines });
  })
);

// ─────────────────────────────────────────────────────────────
//  3.  GET MACHINE DETAIL + SHIFT HISTORY
//      GET /machine/get-machine-detail?id=<_id>
//
//  FIX: populate options: { limit, sort } is not reliably
//       supported inside populate() in Mongoose — resulted in
//       ALL shifts being returned unsorted. Fixed by post-
//       processing with .sort() and .slice(0, 10).
//
//  FIX: efficiency formula was: (runtimeMinutes / 720) * 100
//       where 720 = 12 hours in minutes. A 12-hour shift running
//       720 min → 100% efficiency. This is mathematically correct
//       but kept as-is since it matches the existing business logic.
//
//  FIX: status code was 201 → now 200.
//  Changed: limit reduced to 10 (as requested by the task).
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-machine-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Machine id is required", 400));

    const machine = await Machine.findById(id)
      .populate({
        path: "shifts",
        populate: [
          { path: "employee", model: "Employee", select: "name" },
        ],
      })
      .populate("orderRunning", "jobOrderNo")
      .exec();

    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    // FIX: sort + limit AFTER populate (not inside populate options)
    const sortedShifts = [...machine.shifts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    const result = sortedShifts.map((shift) => {
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
        // FIX: shift.employee may be null if employee was deleted
        employee:       shift.employee?.name ?? "Unknown",
        runtimeMinutes,
        outputMeters:   shift.production || 0,
        efficiency:     parseFloat(efficiency.toFixed(2)),
      };
    });

    res.status(200).json({
      success: true,
      machine: {
        id:           machine.ID,
        status:       machine.status,
        elastics:     machine.elastics,
        manufacturer: machine.manufacturer,
        heads:        machine.NoOfHead,
        hooks:        machine.NoOfHooks,
        dateOfPurchase: machine.DateOfPurchase || null,
        currentJobNo: machine.orderRunning?.jobOrderNo?.toString() ?? null,
        result,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  4.  FREE MACHINES
//      GET /machine/free
// ─────────────────────────────────────────────────────────────
router.get(
  "/free",
  catchAsyncErrors(async (req, res, next) => {
    const machines = await Machine.find({ status: "free" })
      .sort({ ID: 1 })
      .select("ID manufacturer status NoOfHooks NoOfHead");

    res.status(200).json({
      success: true,
      count:   machines.length,
      machines,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  5.  RUNNING MACHINES  (for shift plan creation)
//      GET /machine/running-machines
//
//  FIX: original response returned field `ID` but MachineRunningModel
//       .fromJson() accessed `json['machineCode']` → always null.
//       Now response includes BOTH `machineCode` (for the Flutter model)
//       AND `ID` (for backward compat with any other consumer).
// ─────────────────────────────────────────────────────────────
router.get(
  "/running-machines",
  catchAsyncErrors(async (req, res, next) => {
    const machines = await Machine.find({ status: "running" })
      .populate("orderRunning", "jobOrderNo")
      .select("ID manufacturer NoOfHead NoOfHooks elastics orderRunning status");

    const data = machines.map((m) => ({
      machineId:    m._id,
      // FIX: was only 'ID', model expected 'machineCode'
      machineCode:  m.ID,
      ID:           m.ID,
      manufacturer: m.manufacturer,
      noOfHeads:    m.NoOfHead,
      NoOfHead:     m.NoOfHead,
      jobOrderNo:   m.orderRunning?.jobOrderNo?.toString() ?? "—",
      elastics:     m.elastics,
    }));

    res.status(200).json({ success: true, data });
  })
);

// ─────────────────────────────────────────────────────────────
//  6.  UPDATE MACHINE ELASTIC ASSIGNMENTS
//      PUT /machine/updateOrder
//
//  FIX: was `Machine.findOne({ ID: req.body.id })` — if `id` is
//       a MongoDB _id (passed from some callers) this always
//       returns null. Now accepts either the string `ID` field
//       or a Mongo `_id` automatically.
// ─────────────────────────────────────────────────────────────
router.put(
  "/updateOrder",
  catchAsyncErrors(async (req, res, next) => {
    const { id, elastics } = req.body;
    if (!id) return next(new ErrorHandler("id is required", 400));

    // Accept both string ID ("LOOM-EL-01") and MongoDB _id
    let machine = await Machine.findOne({ ID: id });
    if (!machine) {
      // FIX: fallback to _id lookup
      machine = await Machine.findById(id).catch(() => null);
    }

    if (!machine) {
      return next(new ErrorHandler(`Machine "${id}" not found`, 404));
    }

    if (!Array.isArray(elastics)) {
      return next(new ErrorHandler("elastics must be an array", 400));
    }

    machine.elastics = elastics;
    await machine.save();

    console.log(`[machine/updateOrder] Elastics updated for ${machine.ID}`);

    res.status(200).json({ success: true, data: machine._id });
  })
);

// ─────────────────────────────────────────────────────────────
//  7.  UPDATE MACHINE STATUS
//      PATCH /machine/status
//
//  NEW: allows setting a machine to free/running/maintenance
//       from admin UI without going through job flow.
// ─────────────────────────────────────────────────────────────
router.patch(
  "/status",
  catchAsyncErrors(async (req, res, next) => {
    const { id, status } = req.body;

    if (!id)     return next(new ErrorHandler("id is required", 400));
    if (!status) return next(new ErrorHandler("status is required", 400));

    if (!["free", "running", "maintenance"].includes(status)) {
      return next(
        new ErrorHandler(
          `Invalid status "${status}". Valid: free, running, maintenance`,
          400
        )
      );
    }

    const machine = await Machine.findById(id);
    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    // Can't set to "running" without a job assigned via plan-weaving
    if (status === "running") {
      return next(
        new ErrorHandler(
          'Use the /job/plan-weaving endpoint to put a machine in running status',
          400
        )
      );
    }

    machine.status = status;
    if (status === "free") {
      machine.orderRunning = null;
    }
    await machine.save();

    res.status(200).json({
      success: true,
      machine: { _id: machine._id, ID: machine.ID, status: machine.status },
    });
  })
);

module.exports = router;
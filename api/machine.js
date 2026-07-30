"use strict";

const express = require("express");
const router  = express.Router();

const mongoose         = require("mongoose");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const ShiftDetail      = require("../models/ShiftDetail");
const MachineIssue     = require("../models/MachineIssue");
const Machine          = require("../models/Machine");
const { notify }       = require("../utils/notify");
const { actorFromRequest } = require("../utils/fingerprint");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");

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

/** Both DAY and NIGHT run 12h, so efficiency is measured against 720 min. */
const SHIFT_MINUTES = 720;

/** How many past shifts the machine detail page shows. */
const RECENT_SHIFT_LIMIT = 6;

/**
 * A shift's numbers before an admin verifies it live in the `submitted*`
 * fields; only on verification are they cascaded into the canonical ones.
 * Showing the canonical 0 for a shift the worker has already reported on
 * makes the machine look idle, so fall back to what was submitted and let
 * the row's `status` tell the reader it is not yet verified.
 */
function shiftFigures(shift) {
  const verified = shift.status === "closed";
  const timer =
    !verified && shift.submittedTimer ? shift.submittedTimer : shift.timer;
  const meters =
    !verified && Number.isFinite(shift.submittedProductionMeters)
      ? shift.submittedProductionMeters
      : shift.productionMeters;
  return { timer, meters: Number.isFinite(meters) ? meters : 0 };
}

/** Maps ShiftDetail documents to the rows the machine detail page renders. */
function toShiftRows(shifts) {
  return shifts.map((shift) => {
    const { timer, meters } = shiftFigures(shift);
    const runtimeMinutes = clockToMinutes(timer);
    const efficiency =
      runtimeMinutes > 0 ? Math.min(100, (runtimeMinutes / SHIFT_MINUTES) * 100) : 0;

    return {
      id:           shift._id,
      date:         shift.date,
      shift:        shift.shift,
      status:       shift.status,
      description:  shift.description || "",
      feedback:     shift.feedback    || "",
      // employee may be null if the operator was deleted since the shift ran
      employee:     shift.employee?.name ?? "Unknown",
      runtimeMinutes,
      outputMeters: meters,
      efficiency:   parseFloat(efficiency.toFixed(2)),
    };
  });
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
    // Friendly pre-check; the unique index on Machine.ID is the
    // actual race-free guarantee (Mongo rejects the duplicate
    // insert with E11000 even if two concurrent requests both
    // pass this lookup).
    const normalizedId = ID.trim().toUpperCase();
    const existing = await Machine.findOne({ ID: normalizedId });
    if (existing) {
      return next(
        new ErrorHandler(`Machine with ID "${ID}" already exists`, 409)
      );
    }

    let machine;
    try {
      machine = await Machine.create({
        ID:           normalizedId,
        manufacturer: manufacturer.trim(),
        NoOfHead:     Number(NoOfHead),
        NoOfHooks:    Number(NoOfHooks),
        DateOfPurchase: req.body.DateOfPurchase || null,
        status:       "free",
      });
    } catch (err) {
      // Concurrent insert won the race — surface a clean 409.
      if (err && err.code === 11000) {
        return next(
          new ErrorHandler(`Machine with ID "${ID}" already exists`, 409)
        );
      }
      throw err;
    }

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

router.patch(
  '/update-heads',
  catchAsyncErrors(async (req, res, next) => {
    const { machineId, noOfHead } = req.body;

    // ── Validate input ──────────────────────────────────────
    if (!machineId)
      return next(new ErrorHandler('machineId is required.', 400));

    if (
      typeof noOfHead !== 'number' ||
      !Number.isInteger(noOfHead) ||
      noOfHead < 1
    ) {
      return next(
        new ErrorHandler('noOfHead must be a positive integer.', 400)
      );
    }

    // ── Atomic guarded update ───────────────────────────────
    // The status guard lives IN the filter: a machine that starts
    // running between a read and a write can no longer slip through
    // (the old read-check-save had that TOCTOU window).
    const machine = await Machine.findOneAndUpdate(
      { _id: machineId, status: 'free' },
      { $set: { NoOfHead: noOfHead } },
      { new: false } // returns the pre-update doc → `old` for the log
    );
    if (!machine) {
      const exists = await Machine.findById(machineId).select('status');
      if (!exists) return next(new ErrorHandler('Machine not found.', 404));
      return next(
        new ErrorHandler(
          `Head count can only be updated when the machine is free ` +
          `(current status: "${exists.status}").`,
          400
        )
      );
    }
    const old = machine.NoOfHead;
    machine.NoOfHead = noOfHead; // reflect the new value in the response

    console.log(
      `[machine/update-heads] ${machine.ID}: NoOfHead ${old} → ${noOfHead}`
    );

    return res.status(200).json({
      success: true,
      message: `Head count updated from ${old} to ${noOfHead}.`,
      data: {
        machineId: machine._id,
        machineID: machine.ID,
        noOfHead:  machine.NoOfHead,
      },
    });
  })
);


router.get(
  "/get-machine-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Machine id is required", 400));

    const machine = await Machine.findById(id)
      .populate("orderRunning", "jobOrderNo")
      .populate({ path: "elastics.elastic", model: "Elastic", select: "name" })
      .exec();

    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    // Read the shifts from ShiftDetail rather than the denormalised
    // Machine.shifts array. Nothing ever wrote to that array — the
    // shift-plan create path pushes only onto Employee.shifts, while the
    // delete path prunes Machine.shifts — so it is empty for every machine
    // and this table always came back blank. Querying the shift records
    // themselves is also correct for all historical data with no backfill.
    const recentShifts = await ShiftDetail.find({ machine: machine._id })
      .sort({ date: -1, createdAt: -1 })
      .limit(RECENT_SHIFT_LIMIT)
      .populate({ path: "employee", model: "Employee", select: "name" })
      .lean()
      .exec();

    const result = toShiftRows(recentShifts);

    res.status(200).json({
      success: true,
      machine: {
        id:           machine.ID,
        status:       machine.status,
        // Head → elastic map, sorted by head, with the elastic populated
        // to { _id, name } so the UI can show which elastic runs on each head.
        elastics:     [...(machine.elastics || [])]
          .sort((a, b) => (a.head ?? 0) - (b.head ?? 0))
          .map((e) => ({
            head:    e.head ?? null,
            elastic: e.elastic
              ? { _id: e.elastic._id ?? e.elastic, name: e.elastic.name ?? null }
              : null,
          })),
        manufacturer: machine.manufacturer,
        heads:        machine.NoOfHead,
        hooks:        machine.NoOfHooks,
        dateOfPurchase: machine.DateOfPurchase || null,
        currentJobNo: machine.orderRunning?.jobOrderNo?.toString() ?? null,
        // Running job's id + number so the UI can link to the job page.
        currentJob:   machine.orderRunning
          ? { id: machine.orderRunning._id?.toString?.() ?? null,
              jobOrderNo: machine.orderRunning.jobOrderNo ?? null }
          : null,
        result,
        serviceLogs:  [...machine.serviceLogs]
          .sort((a, b) => new Date(b.date) - new Date(a.date)),
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

    const previousStatus = machine.status;
    const previousOrder  = machine.orderRunning;
    machine.status = status;
    if (status === "free") {
      machine.orderRunning = null;
    }
    await machine.save();

    res.status(200).json({
      success: true,
      machine: { _id: machine._id, ID: machine.ID, status: machine.status },
    });

    // Owner WhatsApp ping when a machine moves to "maintenance"
    // unexpectedly — i.e. NOT preceded by a service-log entry in
    // the last 5 minutes (which would indicate planned maintenance
    // via the add-service-log flow). The breakdown is the lost-
    // output signal; planned work isn't.
    if (status === "maintenance" && previousStatus !== "maintenance") {
      (async () => {
        try {
          // Look at the most recent service log. If it's fresh
          // (within 5 min), this status change is planned — skip.
          const logs = machine.serviceLogs || [];
          const lastLog = logs.length
            ? logs.reduce((a, b) => (new Date(a.date) > new Date(b.date) ? a : b))
            : null;
          const planned = lastLog && (Date.now() - new Date(lastLog.date).getTime() < 5 * 60_000);
          if (planned) {
            console.log(`[notify:machineBreakdown] machine=${machine.ID} → skipped: recent service log (planned)`);
            return;
          }
          const actorName = actorFromRequest(req)?.name || "Admin";
          const result = await notify("machineBreakdown", {
            machineId:      machine.ID,
            previousStatus,
            orderRunning:   previousOrder?.toString?.() || null,
            by:             actorName,
            via:            "Admin app",
            _entity: { type: "Machine", id: machine._id },
            _actor:  { id: req.user?._id, name: actorName },
          });
          console.log(`[notify:machineBreakdown] machine=${machine.ID} →`, JSON.stringify(result));
        } catch (err) {
          console.warn(`[notify:machineBreakdown] hook crashed: ${err?.message}`);
        }
      })();
    }
  })
);

// ─────────────────────────────────────────────────────────────
//  8.  ADD SERVICE LOG
//      POST /machine/add-service-log
//
//  Body:
//  {
//    machineId:       "<mongo _id>",
//    type:            "Preventive" | "Corrective" | "Breakdown" | "Inspection" | "Other",
//    description:     "Replaced drive belt",
//    technician:      "Rajan Kumar",        (optional)
//    cost:            1500,                  (optional, default 0)
//    nextServiceDate: "2026-06-15",          (optional ISO string)
//    resolved:        true                   (optional, default true)
//  }
// ─────────────────────────────────────────────────────────────
router.post(
  "/add-service-log",
  catchAsyncErrors(async (req, res, next) => {
    const {
      machineId,
      type,
      description,
      technician   = "",
      cost         = 0,
      nextServiceDate,
      resolved     = true,
    } = req.body;

    if (!machineId)   return next(new ErrorHandler("machineId is required", 400));
    if (!type)        return next(new ErrorHandler("type is required", 400));
    if (!description?.trim())
      return next(new ErrorHandler("description is required", 400));

    const validTypes = ["Preventive", "Corrective", "Breakdown", "Inspection", "Other"];
    if (!validTypes.includes(type)) {
      return next(
        new ErrorHandler(`type must be one of: ${validTypes.join(", ")}`, 400)
      );
    }

    const machine = await Machine.findById(machineId);
    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    const log = {
      date:        new Date(),
      type,
      description: description.trim(),
      technician:  technician?.trim() || "",
      cost:        Number(cost) || 0,
      nextServiceDate: nextServiceDate ? new Date(nextServiceDate) : null,
      resolved:    Boolean(resolved),
    };

    machine.serviceLogs.push(log);
    await machine.save();

    const saved = machine.serviceLogs[machine.serviceLogs.length - 1];

    console.log(`[machine/add-service-log] ${machine.ID}: ${type} log added`);

    res.status(201).json({
      success: true,
      log: saved,
      totalLogs: machine.serviceLogs.length,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  MAINTENANCE DUE
//  GET /machine/maintenance-due?days=14
//
//  For every machine, takes the LATEST service log carrying a
//  nextServiceDate and buckets it as:
//    • overdue   — nextServiceDate in the past
//    • dueSoon   — within the next `days` (default 14, max 90)
//  Machines whose latest dated log is further out (or that have
//  no dated logs at all) are excluded. Sorted most-urgent first.
//
//  Machine counts are small (tens), so the scan is in-process
//  rather than an aggregation pipeline.
// ─────────────────────────────────────────────────────────────
router.get(
  "/maintenance-due",
  catchAsyncErrors(async (req, res, next) => {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const machines = await Machine.find()
      .select("ID manufacturer status serviceLogs")
      .lean();

    const due = [];
    for (const m of machines) {
      const dated = (m.serviceLogs || [])
        .filter((l) => l.nextServiceDate)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      if (dated.length === 0) continue;

      const next = new Date(dated[0].nextServiceDate);
      if (Number.isNaN(next.getTime()) || next > horizon) continue;

      due.push({
        machineId:       m._id,
        ID:              m.ID,
        manufacturer:    m.manufacturer,
        status:          m.status,
        nextServiceDate: next,
        lastServiceType: dated[0].type,
        lastServiceDate: dated[0].date,
        overdue:         next < now,
        daysUntil: Math.ceil((next - now) / (24 * 60 * 60 * 1000)),
      });
    }

    due.sort((a, b) => new Date(a.nextServiceDate) - new Date(b.nextServiceDate));

    res.json({
      success: true,
      days,
      count: due.length,
      overdueCount: due.filter((d) => d.overdue).length,
      data: due,
    });
  })
);

// ═════════════════════════════════════════════════════════════
//  GET /machine/predictive-health
//
//  A per-machine health score (0–100) that predicts trouble before a
//  hard breakdown, from signals the app already captures:
//    • production drift  — recent 7d avg vs the prior 21d baseline
//    • issue frequency   — MachineIssues in the last 30d (open/critical)
//    • service recency   — overdue / due-soon next service date
//    • current status    — machine sitting in maintenance
//  Each machine comes back with a band (healthy/watch/at_risk) and the
//  human-readable reasons that moved the score.
// ═════════════════════════════════════════════════════════════
router.get(
  "/predictive-health",
  catchAsyncErrors(async (req, res) => {
    const now = new Date();
    const d7  = new Date(now.getTime() - 7  * 86_400_000);
    const d28 = new Date(now.getTime() - 28 * 86_400_000);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);

    const [prodAgg, issueAgg, machines] = await Promise.all([
      ShiftDetail.aggregate([
        { $match: { status: "closed", date: { $gte: d28 } } },
        { $group: {
            _id: "$machine",
            recentSum:   { $sum: { $cond: [{ $gte: ["$date", d7] }, "$productionMeters", 0] } },
            recentCount: { $sum: { $cond: [{ $gte: ["$date", d7] }, 1, 0] } },
            baseSum:     { $sum: { $cond: [{ $lt:  ["$date", d7] }, "$productionMeters", 0] } },
            baseCount:   { $sum: { $cond: [{ $lt:  ["$date", d7] }, 1, 0] } },
        } },
      ]),
      MachineIssue.aggregate([
        { $match: { createdAt: { $gte: d30 } } },
        { $group: {
            _id: "$machine",
            count:    { $sum: 1 },
            open:     { $sum: { $cond: [{ $in: ["$status", ["open", "acknowledged", "in_progress"]] }, 1, 0] } },
            critical: { $sum: { $cond: [{ $in: ["$severity", ["high", "critical"]] }, 1, 0] } },
        } },
      ]),
      Machine.find().select("ID status serviceLogs manufacturer NoOfHead").lean(),
    ]);

    const prodBy  = new Map(prodAgg.map((r) => [String(r._id), r]));
    const issueBy = new Map(issueAgg.map((r) => [String(r._id), r]));

    const out = machines.map((m) => {
      const id = String(m._id);
      const p  = prodBy.get(id) || {};
      const iss = issueBy.get(id) || { count: 0, open: 0, critical: 0 };

      const recentAvg = p.recentCount ? p.recentSum / p.recentCount : null;
      const baseAvg   = p.baseCount   ? p.baseSum   / p.baseCount   : null;
      const dropPct = baseAvg && recentAvg != null && baseAvg > 0
        ? Math.max(0, Math.round(((baseAvg - recentAvg) / baseAvg) * 100))
        : 0;

      // Service recency from the most recent log carrying a next date.
      const logs = (m.serviceLogs || []).filter((l) => l.nextServiceDate)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const nextService = logs.length ? new Date(logs[0].nextServiceDate) : null;
      const serviceOverdue = nextService && nextService < now;
      const serviceDueSoon = nextService && !serviceOverdue &&
        nextService < new Date(now.getTime() + 7 * 86_400_000);

      const reasons = [];
      let score = 100;

      if (dropPct >= 12 && p.recentCount) {
        const pen = Math.min(35, Math.round(dropPct * 0.7));
        score -= pen;
        reasons.push({ severity: dropPct >= 30 ? "high" : "medium",
          label: `Output down ${dropPct}%`,
          detail: `Recent avg ${Math.round(recentAvg)} m/shift vs ${Math.round(baseAvg)} m baseline.` });
      }
      if (iss.count > 0) {
        const pen = Math.min(40, iss.count * 8 + iss.critical * 5);
        score -= pen;
        reasons.push({ severity: iss.critical > 0 ? "high" : iss.count >= 3 ? "medium" : "low",
          label: `${iss.count} issue${iss.count === 1 ? "" : "s"} in 30d`,
          detail: `${iss.open} open${iss.critical ? ` · ${iss.critical} high/critical` : ""}.` });
      }
      if (serviceOverdue) {
        score -= 20;
        reasons.push({ severity: "high", label: "Service overdue",
          detail: `Was due ${nextService.toLocaleDateString("en-IN")}.` });
      } else if (serviceDueSoon) {
        score -= 8;
        reasons.push({ severity: "low", label: "Service due soon",
          detail: `Due ${nextService.toLocaleDateString("en-IN")}.` });
      }
      if (m.status === "maintenance") {
        score -= 10;
        reasons.push({ severity: "medium", label: "In maintenance", detail: "Currently down." });
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      const band = score >= 75 ? "healthy" : score >= 50 ? "watch" : "at_risk";

      return {
        machineId: m._id,
        machineID: m.ID,
        status: m.status,
        score, band, dropPct,
        issues30d: iss.count,
        openIssues: iss.open,
        recentAvg: recentAvg != null ? Math.round(recentAvg) : null,
        baselineAvg: baseAvg != null ? Math.round(baseAvg) : null,
        nextServiceDate: nextService,
        reasons,
      };
    });

    out.sort((a, b) => a.score - b.score); // worst first
    const atRisk = out.filter((m) => m.band === "at_risk").length;
    const watch  = out.filter((m) => m.band === "watch").length;

    res.json({ success: true, generatedAt: now, summary: { total: out.length, atRisk, watch }, machines: out });
  })
);

// ═════════════════════════════════════════════════════════════
//  GET /machine/health-advice/:id
//
//  A real-AI maintenance diagnosis for one machine: gathers the same
//  signals as the health score (production drift, recent issues,
//  service state) and asks Claude for a concise root-cause hypothesis
//  + recommended action + urgency. Falls back to a deterministic
//  summary when no Claude key is configured.
// ═════════════════════════════════════════════════════════════
router.get(
  "/health-advice/:id",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)) return next(new ErrorHandler("Invalid machine id", 400));

    const now = new Date();
    const d7  = new Date(now.getTime() - 7  * 86_400_000);
    const d28 = new Date(now.getTime() - 28 * 86_400_000);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);
    const oid = new mongoose.Types.ObjectId(id);

    const [machine, prod, issues] = await Promise.all([
      Machine.findById(id).select("ID status serviceLogs manufacturer NoOfHead").lean(),
      ShiftDetail.aggregate([
        { $match: { machine: oid, status: "closed", date: { $gte: d28 } } },
        { $group: {
            _id: null,
            recentSum:   { $sum: { $cond: [{ $gte: ["$date", d7] }, "$productionMeters", 0] } },
            recentCount: { $sum: { $cond: [{ $gte: ["$date", d7] }, 1, 0] } },
            baseSum:     { $sum: { $cond: [{ $lt:  ["$date", d7] }, "$productionMeters", 0] } },
            baseCount:   { $sum: { $cond: [{ $lt:  ["$date", d7] }, 1, 0] } },
        } },
      ]),
      MachineIssue.find({ machine: oid, createdAt: { $gte: d30 } })
        .select("title severity status createdAt").sort({ createdAt: -1 }).limit(8).lean(),
    ]);
    if (!machine) return next(new ErrorHandler("Machine not found", 404));

    const p = prod[0] || {};
    const recentAvg = p.recentCount ? Math.round(p.recentSum / p.recentCount) : null;
    const baseAvg   = p.baseCount   ? Math.round(p.baseSum   / p.baseCount)   : null;
    const dropPct = baseAvg && recentAvg != null && baseAvg > 0
      ? Math.max(0, Math.round(((baseAvg - recentAvg) / baseAvg) * 100)) : 0;
    const logs = (machine.serviceLogs || []).filter((l) => l.nextServiceDate)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const nextService = logs.length ? new Date(logs[0].nextServiceDate) : null;
    const serviceOverdue = nextService && nextService < now;

    const facts = [
      `Machine ${machine.ID} (${machine.manufacturer || "?"}, ${machine.NoOfHead || "?"} heads), status: ${machine.status}.`,
      recentAvg != null ? `Recent 7d avg ${recentAvg} m/shift vs ${baseAvg} m baseline (${dropPct}% ${dropPct > 0 ? "drop" : "change"}).` : "No recent production data.",
      `Issues in last 30d: ${issues.length}${issues.length ? " — " + issues.map((i) => `${i.title} [${i.severity}/${i.status}]`).join("; ") : ""}.`,
      nextService ? `Next service ${nextService.toLocaleDateString("en-IN")}${serviceOverdue ? " (OVERDUE)" : ""}.` : "No scheduled service.",
    ].join("\n");

    const claude = anthropic();
    if (claude) {
      try {
        const message = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 400,
          system:
            "You are a senior maintenance engineer for narrow-fabric (elastic tape) weaving/covering " +
            "machines. Given a machine's recent signals, give a concise, practical diagnosis. Output " +
            "plain text with three short labelled lines exactly: 'Likely cause:', 'Recommended action:', " +
            "'Urgency:' (one of low/medium/high). No preamble, no markdown.",
          messages: [{ role: "user", content: `Signals:\n${facts}\n\nGive the diagnosis.` }],
        });
        const advice = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        return res.json({ success: true, machineID: machine.ID, aiGenerated: true, advice, facts });
      } catch (err) {
        console.warn("[health-advice] AI failed, using fallback:", err?.message);
      }
    }

    // Deterministic fallback when no Claude key.
    const bits = [];
    if (dropPct >= 12) bits.push(`output is down ${dropPct}%`);
    if (issues.length) bits.push(`${issues.length} issue(s) in 30 days`);
    if (serviceOverdue) bits.push("service is overdue");
    const advice = bits.length
      ? `Likely cause: ${bits.join(", ")}.\nRecommended action: inspect the machine, clear open issues and bring service up to date.\nUrgency: ${serviceOverdue || dropPct >= 30 ? "high" : "medium"}.`
      : "Likely cause: no adverse signals.\nRecommended action: continue normal operation.\nUrgency: low.";
    return res.json({ success: true, machineID: machine.ID, aiGenerated: false, advice, facts });
  })
);

module.exports = router;
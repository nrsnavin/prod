"use strict";

const express = require("express");
const router  = express.Router();

const mongoose         = require("mongoose");
const multer           = require("multer");
// multer finishes from a stream event, which loses the request's
// AsyncLocalStorage stores — the database it routes to and the user
// it audits as. See middleware/userContext.js.
const { keepRequestContext } = require("../middleware/userContext.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const ShiftDetail      = require("../models/ShiftDetail");
const MachineIssue     = require("../models/MachineIssue");
const Machine          = require("../models/Machine");
const MachineServiceBill = require("../models/MachineServiceBill");
// Reading metres/timer off a ShiftDetail — shared with the shift-plan
// summary, which had its own (wrong) copy. See utils/shiftFigures.js.
const { shiftFigures, clockToMinutes, SHIFT_MINUTES } = require("../utils/shiftFigures");
const { notify }       = require("../utils/notify");
const { actorFromRequest } = require("../utils/fingerprint");
const { checkHookFit, hookFitError } = require("../utils/machineFit");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const machineHealth = require("../services/machineHealth");
const serviceAnomaly = require("../services/serviceAnomaly");
const ServiceAnomalyFeedback = require("../models/ServiceAnomalyFeedback");

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

// clockToMinutes / shiftFigures / SHIFT_MINUTES now live in
// utils/shiftFigures.js — the shift-plan summary needs the same reading of
// a ShiftDetail, and it had its own (wrong) copy. Imported at the top.

// ── Service / spare bill uploads ────────────────────────────────────
const { BILL_KINDS, ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES } = MachineServiceBill;

// Held in memory then written to the bill document as a data URL; multer's
// own limit is the first line of defence so an oversized file is rejected
// before it is ever fully buffered.
const billUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

/**
 * multer surfaces its size/count limits as a MulterError, which the generic
 * error handler would report as a 500. Turn them into the 400s they are.
 */
function handleBillUpload(req, res, next) {
  keepRequestContext(billUpload.single("file"))(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `File is too large — the limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`
          : `Upload rejected: ${err.message}`;
      return next(new ErrorHandler(message, 400));
    }
    return next(err);
  });
}

/** Strips the file payload; every listing returns metadata only. */
const BILL_METADATA = "-data";

const BILL_EXTENSION_TYPES = {
  pdf:  "application/pdf",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heic",
};

/**
 * The content type of an uploaded bill, or null if it is not one we take.
 *
 * multer reports whatever content type the client put on the multipart
 * part, and plenty of clients put nothing — Dio's MultipartFile defaults
 * every part to application/octet-stream unless the caller passes a media
 * type, and which class that is moved between Dio releases. A phone that
 * cannot name its own PDF is not a reason to refuse the bill, so an
 * unlabelled part falls back to its extension. A part that DOES name a
 * type we do not take is still refused on that name rather than being
 * given a second chance at guessing — a client asserting "video/mp4" is
 * telling us something, and .pdf on the end would not make it a PDF.
 *
 * Same shape as resolveImageType in api/sample.js, and the two end at the
 * same place: an unrecognised extension is refused.
 */
function resolveBillType(file) {
  const declared = String(file.mimetype || "").toLowerCase();
  if (ALLOWED_CONTENT_TYPES.includes(declared)) return declared;

  const unlabelled = !declared
    || declared === "application/octet-stream"
    || declared === "binary/octet-stream";
  if (!unlabelled) return null;

  const ext = String(file.originalname || "").split(".").pop().toLowerCase();
  return BILL_EXTENSION_TYPES[ext] ?? null;
}

/** How many past shifts the machine detail page shows. */
const RECENT_SHIFT_LIMIT = 6;

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
      // `orderRunning` was missing from this projection, so the list
      // never carried it and the Running Job column on the machines
      // screen showed a dash on every row — including machines that
      // were plainly running. The field itself was always right; it
      // just never left the server.
      //
      // Populated, because the column wants the job NUMBER and the
      // machine only stores the id. Selecting the id alone would have
      // swapped one wrong answer for another.
      .select("ID manufacturer NoOfHead NoOfHooks status DateOfPurchase orderRunning")
      .populate("orderRunning", "jobOrderNo status")
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

// ─────────────────────────────────────────────────────────────
//  3b. EDIT THE MACHINE'S DETAILS
//      PATCH /machine/update-details
//
//  Body: { machineId, ID?, manufacturer?, NoOfHooks?, DateOfPurchase?,
//          confirmHooks? }
//
//  Until now the only things about a machine that could be changed
//  after registration were its head count, its status and its head map.
//  A typo in the ID, the wrong manufacturer, a hook count entered as 12
//  when the loom has 24 — all of them meant deleting the machine and
//  registering it again, which is not possible once anything references
//  it. So they were simply lived with, and a wrong hook count is not a
//  cosmetic thing to live with: it decides which products the machine
//  is allowed to run.
//
//  ── Only what was sent is touched ────────────────────────────────
//  A PATCH that fills in the fields it was not given with defaults
//  quietly wipes whatever it was not told about. Absent means "leave
//  it", and only keys actually present in the body are written.
//
//  ── Two of these are gated, two are not ──────────────────────────
//  `manufacturer` and `DateOfPurchase` are labels. Nothing in this
//  system computes anything from them, so they can be corrected at any
//  time, on any machine.
//
//  `NoOfHooks` and `ID` are not labels:
//
//    • Hooks per head is the machine's physical capacity. checkHookFit
//      compares it against every elastic's `noOfHook` before allowing
//      an assignment, and the planner reads it as capacity. Changing it
//      under a running job silently changes what that job is allowed
//      to be.
//
//    • The ID is what the loom is called on the floor. ProductionPlan
//      snapshots it as a human label, so renaming a machine while a job
//      is on it leaves the live plan naming a machine that no longer
//      exists.
//
//  Both are therefore allowed only while the loom is FREE, enforced in
//  the update filter rather than by a read-then-write, so a machine
//  that starts running mid-request cannot slip through.
//
//  ── Lowering the hooks is a way round the fit rule ───────────────
//  checkHookFit is enforced on the three routes that write a head map.
//  None of them can stop somebody reaching the same place from the
//  other direction: leave the map alone and lower the machine's hook
//  count under it. So the same check runs here, against the elastics
//  already threaded — and, as everywhere else, it asks rather than
//  refuses. The floor sometimes knows better; it just has to say so on
//  the record.
// ─────────────────────────────────────────────────────────────

/** Fields that may only be changed while the loom is free. */
const DETAIL_FIELDS_REQUIRING_FREE = ["ID", "NoOfHooks"];

router.patch(
  "/update-details",
  catchAsyncErrors(async (req, res, next) => {
    const { machineId } = req.body;
    if (!machineId) return next(new ErrorHandler("machineId is required.", 400));

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k)
      && req.body[k] !== undefined;

    // ── Build the update out of what was actually sent ──────────────
    const updates = {};

    if (has("ID")) {
      const raw = String(req.body.ID ?? "").trim();
      if (!raw) return next(new ErrorHandler("Machine ID cannot be empty.", 400));
      updates.ID = raw.toUpperCase(); // same normalisation as create
    }

    if (has("manufacturer")) {
      const raw = String(req.body.manufacturer ?? "").trim();
      if (!raw) return next(new ErrorHandler("Manufacturer cannot be empty.", 400));
      updates.manufacturer = raw;
    }

    if (has("NoOfHooks")) {
      const n = Number(req.body.NoOfHooks);
      if (!Number.isInteger(n) || n < 1) {
        return next(
          new ErrorHandler("NoOfHooks must be a positive whole number.", 400)
        );
      }
      updates.NoOfHooks = n;
    }

    if (has("DateOfPurchase")) {
      // Clearing it is legitimate — an unknown purchase date recorded as
      // a guess is worse than no purchase date.
      const raw = req.body.DateOfPurchase;
      updates.DateOfPurchase = raw === null || raw === "" ? null : String(raw);
    }

    if (Object.keys(updates).length === 0) {
      return next(new ErrorHandler("Nothing to update.", 400));
    }

    const current = await Machine.findById(machineId);
    if (!current) return next(new ErrorHandler("Machine not found.", 404));

    // ── A duplicate ID, checked without the machine finding itself ──
    // A machine must not be refused as a duplicate of itself, which is
    // what happens if this lookup is written naively. Two things stop
    // it — the check is skipped when the ID is not actually changing,
    // and the machine is excluded from the lookup by _id. Either alone
    // is sufficient; both are kept because they fail differently (the
    // first stops the query, the second stops a wrong query).
    if (updates.ID && updates.ID !== current.ID) {
      const clash = await Machine.findOne({
        ID: updates.ID,
        _id: { $ne: current._id },
      }).select("_id");
      if (clash) {
        return next(
          new ErrorHandler(`Machine with ID "${updates.ID}" already exists.`, 409)
        );
      }
    }

    // ── Would the new hook count strand what is already threaded? ───
    if (updates.NoOfHooks !== undefined && updates.NoOfHooks < current.NoOfHooks) {
      const threaded = (current.elastics || []).map((e) => e?.elastic);
      const fit = await checkHookFit(
        { ...current.toObject(), NoOfHooks: updates.NoOfHooks },
        threaded
      );
      if (!fit.fits && req.body.confirmHooks !== true) {
        return next(hookFitError(current, fit, ErrorHandler));
      }
    }

    // ── Guarded, atomic write ───────────────────────────────────────
    const gated = DETAIL_FIELDS_REQUIRING_FREE.filter((f) => f in updates);
    const filter = gated.length
      ? { _id: machineId, status: "free" }
      : { _id: machineId };

    let before;
    try {
      before = await Machine.findOneAndUpdate(
        filter,
        { $set: updates },
        { new: false, runValidators: true }
      );
    } catch (err) {
      // Lost the race to a concurrent rename — the unique index is the
      // real guarantee, the lookup above is only a friendlier message.
      if (err && err.code === 11000) {
        return next(
          new ErrorHandler(`Machine with ID "${updates.ID}" already exists.`, 409)
        );
      }
      throw err;
    }

    if (!before) {
      // The document exists (checked above), so the filter can only have
      // failed on the status guard — name the field and the status,
      // because "update failed" is not something anybody can act on.
      const fresh = await Machine.findById(machineId).select("status");
      if (!fresh) return next(new ErrorHandler("Machine not found.", 404));
      return next(
        new ErrorHandler(
          `${gated.join(" and ")} can only be changed while the machine is ` +
          `free (current status: "${fresh.status}").`,
          400
        )
      );
    }

    // Reported from the pre-update document, so it is what actually
    // changed rather than what the client believed it was changing.
    const changes = Object.keys(updates)
      .map((field) => ({
        field,
        from: before[field] ?? null,
        to: updates[field] ?? null,
      }))
      .filter((c) => String(c.from ?? "") !== String(c.to ?? ""));

    console.log(
      `[machine/update-details] ${before.ID}: ` +
      (changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join(", ") || "no change")
    );

    return res.status(200).json({
      success: true,
      message: changes.length
        ? `Updated ${changes.map((c) => c.field).join(", ")}.`
        : "No changes were needed.",
      changes,
      data: {
        machineId:      before._id,
        machineID:      updates.ID ?? before.ID,
        manufacturer:   updates.manufacturer ?? before.manufacturer,
        noOfHooks:      updates.NoOfHooks ?? before.NoOfHooks,
        dateOfPurchase: updates.DateOfPurchase !== undefined
          ? updates.DateOfPurchase
          : (before.DateOfPurchase ?? null),
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

    // How many bills each service log carries, and what they add up to, so
    // the history renders in one request instead of one per log. The files
    // themselves are fetched only when a bill is actually opened.
    const billRollup = await MachineServiceBill.aggregate([
      { $match: { machine: machine._id } },
      {
        $group: {
          _id:    "$serviceLog",
          count:  { $sum: 1 },
          amount: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]);
    const billsByLog = new Map(
      billRollup.map((b) => [String(b._id), { count: b.count, amount: b.amount }])
    );

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
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map((log) => {
            const bills = billsByLog.get(String(log._id)) ?? { count: 0, amount: 0 };
            return { ...log.toObject(), billCount: bills.count, billTotal: bills.amount };
          }),
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

    // ── Can the machine run what is being put on it? ────────────────
    // This is the third route that writes a head → elastic map, after
    // /job/plan-weaving and /job/assign-machine. Guarding only those
    // two would leave the machine page's head-map editor as a way
    // straight past the rule, which is not a rule at all.
    //
    // A confirmation, not a refusal — see utils/machineFit.js.
    const fit = await checkHookFit(machine, elastics.map((e) => e?.elastic));
    if (!fit.fits && req.body?.confirmHooks !== true) {
      return next(hookFitError(machine, fit, ErrorHandler));
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
//    resolved:        true,                  (optional, default true)
//    setMaintenance:  true                   (optional — take the machine
//                                             off the floor in the same
//                                             action; see below)
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
      setMaintenance = false,
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

    // Taking the machine in for service is one action, not two: recording
    // the job and pulling the machine off the floor happen together, in a
    // single save, so the machine can never be left running against a log
    // that says it is stripped down.
    //
    // A machine mid-job is deliberately NOT pulled — its job would be left
    // pointing at a machine that is out of service. The caller has to stop
    // the job first, and gets told so.
    const wantsMaintenance =
      setMaintenance === true || setMaintenance === "true";
    let statusChanged = false;

    if (wantsMaintenance && machine.status !== "maintenance") {
      if (machine.status === "running") {
        return next(
          new ErrorHandler(
            "This machine is running a job. Stop the job before sending it for service.",
            409
          )
        );
      }
      machine.status = "maintenance";
      statusChanged = true;
    }

    await machine.save();

    const saved = machine.serviceLogs[machine.serviceLogs.length - 1];

    console.log(
      `[machine/add-service-log] ${machine.ID}: ${type} log added` +
        (statusChanged ? " → sent to maintenance" : "")
    );

    // No machineBreakdown notification here on purpose. That alert exists to
    // flag an *unplanned* stoppage; work booked through this endpoint is
    // planned by definition, which is exactly the case /status already
    // suppresses by looking for a recent service log.

    res.status(201).json({
      success: true,
      log: saved,
      totalLogs: machine.serviceLogs.length,
      status: machine.status,
      statusChanged,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  SERVICE & SPARE BILLS
//
//  POST   /machine/service-bill            (multipart, field "file")
//  GET    /machine/service-bills?machineId=&serviceLogId=
//  GET    /machine/service-bill/:id/file   download / inline view
//  DELETE /machine/service-bill/:id
// ─────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
//  THE LOG SAYS WHICH MACHINE, NOT THE CLIENT
//
//  This used to start from `machineId` and look the log up inside that
//  machine. Every bill upload therefore depended on the client holding
//  a correct machine id, and a screen that has been open a while — or
//  reached from a stale link, a bookmark, a cached list — does not.
//  When it was wrong the answer was "machine not found", which sounds
//  like the machine is missing when the machine is sitting right there
//  on the page.
//
//  A service log's `_id` is a unique ObjectId, and a log belongs to
//  exactly one machine. So the log is the better key: ask which
//  machine owns THIS log and the client's opinion stops mattering.
//
//  `machineId` is still read, and still checked, but only where it can
//  catch something the log cannot:
//
//    • it names a machine that EXISTS and is a DIFFERENT one — the
//      client is genuinely confused about which machine it is looking
//      at, and filing the bill would put it somewhere nobody expects.
//      Still refused.
//
//    • it names nothing at all — stale, deleted, or simply wrong. The
//      log already told us the answer, so this is noted in the log
//      file and the upload goes through. This is the case that used to
//      fail, and there was never anything wrong with the request.
// ══════════════════════════════════════════════════════════════════
/** Resolves the machine + service log a bill is being filed against. */
async function findServiceLog(machineId, serviceLogId) {
  if (!mongoose.isValidObjectId(serviceLogId)) {
    throw new ErrorHandler(
      `serviceLogId "${serviceLogId}" is not an id. The bill attaches to a ` +
      `service log's database id.`,
      400
    );
  }

  const machine = await Machine.findOne({ 'serviceLogs._id': serviceLogId });
  if (!machine) {
    // Nothing owns this log. Say which of the two plausible reasons it
    // is, rather than leaving somebody to guess from four words.
    const claimed = mongoose.isValidObjectId(machineId)
      ? await Machine.findById(machineId).select('ID serviceLogs').lean()
      : null;
    // ── Name the database ─────────────────────────────────────────
    //  "It is on my screen and the API says it does not exist" has two
    //  shapes, and only one of them is about the record. The other is
    //  that the page and this process are looking at DIFFERENT
    //  databases, which nothing in the app has ever been able to say.
    //
    //  It is easy to end up there without noticing: the web app
    //  defaults to a hardcoded production host in BOTH dev (the Vite
    //  proxy) and production builds, so a locally-run API and the page
    //  in front of you are not necessarily the same system. Printing
    //  the database name turns an afternoon into a glance.
    //  It must be the database THIS REQUEST used, not the one the
    //  process happens to be connected to. Those differ for every
    //  sandbox user (db/tenants.js routes them to a second database on
    //  the same client), and the first version of this read the default
    //  connection — so it told a sandbox user their API was reading the
    //  live database while their request was correctly reading the
    //  sandbox. A diagnostic that is wrong is worse than none: it sends
    //  somebody looking in the one place the answer cannot be.
    const { currentDb, routingStateFor } = require("../db/tenants.js");
    const { getCurrentUser } = require("../middleware/userContext.js");
    const db = currentDb() || mongoose.connection?.name || "unknown";

    //  And WHY that database. "Reading baluElastics" answers half the
    //  question and leaves the expensive half — a sandbox user reads
    //  that and still cannot tell whether they are off the list,
    //  whether SANDBOX_DB is unset, or whether it collided with the
    //  primary. Three causes, three different fixes, one symptom.
    const routing = routingStateFor(getCurrentUser());
    const why = routing.routed ? "" : ` ${routing.detail}`;
    throw new ErrorHandler(
      (claimed
        ? `Machine ${claimed.ID} has no service log ${serviceLogId}. It has ` +
          `${(claimed.serviceLogs || []).length} log(s) — the log may have ` +
          `been removed, or the page may be out of date.`
        : `No service log has id ${serviceLogId}. It may have been removed, ` +
          `or the page may be out of date — reload and try again.`) +
      ` (This request read database "${db}".${why})`,
      404
    );
  }

  // Both ids resolve and they disagree: that is a confused client, not
  // a stale one, and guessing which it meant would file the paperwork
  // against the wrong machine.
  if (mongoose.isValidObjectId(machineId) && String(machine._id) !== String(machineId)) {
    const other = await Machine.findById(machineId).select('ID').lean();
    if (other) {
      throw new ErrorHandler(
        `Service log ${serviceLogId} is on machine ${machine.ID}, not on ` +
        `machine ${other.ID}.`,
        409
      );
    }
    // It resolves to nothing — the id the page was holding is stale.
    // The log already identified the machine, so this is a note, not a
    // failure.
    console.warn(
      `[machine/service-bill] stale machineId ${machineId} from client; ` +
      `resolved log ${serviceLogId} to machine ${machine.ID} (${machine._id})`
    );
  }

  return { machine, log: machine.serviceLogs.id(serviceLogId) };
}

router.post(
  "/service-bill",
  handleBillUpload,
  catchAsyncErrors(async (req, res, next) => {
    const { machineId, serviceLogId, kind, amount, vendor, billNo, billDate, partName, notes } =
      req.body;

    if (!req.file) {
      return next(new ErrorHandler('No file uploaded (field name must be "file").', 400));
    }
    if (!BILL_KINDS.includes(kind)) {
      return next(
        new ErrorHandler(`kind must be one of: ${BILL_KINDS.join(", ")}`, 400)
      );
    }
    const contentType = resolveBillType(req.file);
    if (!contentType) {
      return next(
        new ErrorHandler(
          `Unsupported file type "${req.file.mimetype}". Upload a PDF or a photo.`,
          400
        )
      );
    }

    const { machine } = await findServiceLog(machineId, serviceLogId);

    const bill = await MachineServiceBill.create({
      machine:     machine._id,
      serviceLog:  serviceLogId,
      kind,
      filename:    req.file.originalname || "",
      // The resolved type, not the declared one: the data URL and the
      // stored contentType have to agree, or the download route sends a
      // header that contradicts its own payload.
      contentType,
      size:        req.file.size,
      data:        `data:${contentType};base64,${req.file.buffer.toString("base64")}`,
      amount:      Number(amount) > 0 ? Number(amount) : 0,
      vendor:      vendor   || "",
      billNo:      billNo   || "",
      billDate:    billDate ? new Date(billDate) : null,
      partName:    partName || "",
      notes:       notes    || "",
      uploadedBy:  req.user?._id ?? null,
    });

    // Echo without the payload — the client already has the file.
    const { data: _omit, ...meta } = bill.toObject();

    res.status(201).json({ success: true, bill: meta });
  })
);

router.get(
  "/service-bills",
  catchAsyncErrors(async (req, res, next) => {
    const { machineId, serviceLogId } = req.query;
    if (!mongoose.isValidObjectId(machineId)) {
      return next(new ErrorHandler("A valid machineId is required", 400));
    }

    const filter = { machine: machineId };
    // Optional: without it, every bill for the machine comes back.
    if (serviceLogId) {
      if (!mongoose.isValidObjectId(serviceLogId)) {
        return next(new ErrorHandler("A valid serviceLogId is required", 400));
      }
      filter.serviceLog = serviceLogId;
    }

    const bills = await MachineServiceBill.find(filter)
      .select(BILL_METADATA)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: bills.length,
      totalAmount: bills.reduce((sum, b) => sum + (b.amount || 0), 0),
      bills,
    });
  })
);

router.get(
  "/service-bill/:id/file",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return next(new ErrorHandler("A valid bill id is required", 400));
    }

    const bill = await MachineServiceBill.findById(id).lean();
    if (!bill) return next(new ErrorHandler("Bill not found", 404));

    // Stored as data:<mime>;base64,<payload> — send back the bytes.
    const base64 = String(bill.data).split(",")[1] ?? "";
    const buffer = Buffer.from(base64, "base64");

    // `inline` so a PDF or photo opens in the browser's viewer rather than
    // dropping into Downloads; the filename is still used if it is saved.
    const safeName = (bill.filename || `bill-${bill._id}`).replace(/["\\\r\n]/g, "");
    res.setHeader("Content-Type", bill.contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.send(buffer);
  })
);

router.delete(
  "/service-bill/:id",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return next(new ErrorHandler("A valid bill id is required", 400));
    }

    const bill = await MachineServiceBill.findByIdAndDelete(id);
    if (!bill) return next(new ErrorHandler("Bill not found", 404));

    res.json({ success: true, id });
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

    // Output drift comes from services/machineHealth.js, which divides
    // every shift by what the (elastic, machine) posterior expects for
    // that pair. This route used to sum raw productionMeters, so a loom
    // moved onto a slower product showed a 50% "output drop" and lost
    // up to 35 points of health score for doing what it was told.
    const [prodAgg, issueAgg, machines, drift] = await Promise.all([
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
      machineHealth.driftByMachine({ recentDays: 7, baselineDays: 21, now }),
    ]);

    const prodBy  = new Map(prodAgg.map((r) => [String(r._id), r]));
    const issueBy = new Map(issueAgg.map((r) => [String(r._id), r]));

    const out = machines.map((m) => {
      const id = String(m._id);
      const p  = prodBy.get(id) || {};
      const iss = issueBy.get(id) || { count: 0, open: 0, critical: 0 };

      // Raw metres, kept for context on screen — they are what somebody
      // sees on the floor — but NOT what the penalty is computed from.
      const recentAvg = p.recentCount ? p.recentSum / p.recentCount : null;
      const baseAvg   = p.baseCount   ? p.baseSum   / p.baseCount   : null;

      const d = drift.get(id) || { dropPct: 0, recentPctOfExpected: null, baselinePctOfExpected: null };
      const dropPct = d.dropPct;

      // Service recency from the most recent log carrying a next date.
      const logs = (m.serviceLogs || []).filter((l) => l.nextServiceDate)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const nextService = logs.length ? new Date(logs[0].nextServiceDate) : null;
      const serviceOverdue = nextService && nextService < now;
      const serviceDueSoon = nextService && !serviceOverdue &&
        nextService < new Date(now.getTime() + 7 * 86_400_000);

      const reasons = [];
      let score = 100;

      if (dropPct >= 12 && d.recentShifts > 0) {
        const pen = Math.min(35, Math.round(dropPct * 0.7));
        score -= pen;
        reasons.push({ severity: dropPct >= 30 ? "high" : "medium",
          label: `Output down ${dropPct}%`,
          // Percent of what this machine's own products normally make,
          // not metres: over a period where the product changed, a
          // metre figure compares two different things.
          detail: `Running at ${d.recentPctOfExpected}% of expected, against ` +
                  `${d.baselinePctOfExpected}% over the previous three weeks.` });
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
        // The figures the drop is actually computed from.
        recentPctOfExpected: d.recentPctOfExpected,
        baselinePctOfExpected: d.baselinePctOfExpected,
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


// ─────────────────────────────────────────────────────────────
//  SERVICE ANALYTICS
//
//  Three questions the machine screens ask:
//    what are we spending, on what, and which patterns deserve a look.
//
//  The detector is deliberately not called "fraud detection" anywhere a
//  user can see. It finds patterns; a person decides what they mean.
//  See services/serviceAnomaly.js for why that distinction shapes the
//  whole design rather than being a caveat on the end.
//
//  No isAdmin here: this router is gated where it is mounted, and a
//  redundant guard inside it once took the whole app down at require
//  time because the helper was not imported.
// ─────────────────────────────────────────────────────────────

const WINDOW_MAX = 1095;   // three years; past that the sheet is history

const readWindow = (req) =>
  Math.min(WINDOW_MAX, Math.max(30, Number(req.query.days) || 365));

router.get(
  "/service-analytics",
  catchAsyncErrors(async (req, res) => {
    const days = readWindow(req);
    // One history read would be nicer, but these are independent
    // questions and the sheet is small enough that clarity wins.
    const [spend, anomalies, costliest] = await Promise.all([
      serviceAnomaly.spending(days),
      serviceAnomaly.analyse(days),
      serviceAnomaly.costliestMachines(days),
    ]);

    res.json({ success: true, days, spend, anomalies, costliest });
  })
);

router.get(
  "/service-analytics/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid machine id", 400));
    }
    const days = readWindow(req);
    const spend = await serviceAnomaly.spending(days, req.params.id);
    res.json({ success: true, days, spend });
  })
);

/**
 * What one machine actually produced, month by month.
 *
 * Beside the spending chart this is the only comparison that matters:
 * a loom that costs a lot to keep running is a problem only if it is
 * not also producing a lot.
 *
 * Unverified shifts are EXCLUDED. Their figures are the operator's own
 * and are corrected at verification, so including them would draw a
 * production line that quietly rewrites itself days later.
 */
router.get(
  "/production-series/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid machine id", 400));
    }
    const days = readWindow(req);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const shifts = await ShiftDetail.find({
      machine: req.params.id,
      date: { $gte: since },
      status: "closed",
    })
      .select("date shift timer productionMeters production")
      .lean();

    // Every month in the window, including the empty ones — a chart
    // drawn only from months that had output closes the gaps and makes
    // three idle months look like three busy ones.
    const buckets = new Map(
      serviceAnomaly.monthsBetween(since, new Date()).map((m) => [
        m, { month: m, meters: 0, shifts: 0, runtimeMinutes: 0 },
      ])
    );

    for (const shift of shifts) {
      const bucket = buckets.get(serviceAnomaly.monthKey(shift.date));
      if (!bucket) continue;
      const { timer, meters } = shiftFigures(shift);
      bucket.meters += Number(meters) || 0;
      bucket.runtimeMinutes += clockToMinutes(timer);
      bucket.shifts += 1;
    }

    const series = [...buckets.values()].map((b) => ({
      month: b.month,
      meters: Math.round(b.meters),
      shifts: b.shifts,
      runtimeHours: Math.round(b.runtimeMinutes / 6) / 10,
    }));

    res.json({
      success: true,
      days,
      series,
      totalMeters: series.reduce((s, b) => s + b.meters, 0),
      totalShifts: series.reduce((s, b) => s + b.shifts, 0),
    });
  })
);

/**
 * "I have looked at this and it is fine."
 *
 * The finding stops being raised for a while — see
 * models/ServiceAnomalyFeedback.js for why a dismissal expires rather
 * than holding forever.
 */
router.post(
  "/service-analytics/dismiss",
  catchAsyncErrors(async (req, res, next) => {
    const { kind, subject, reason } = req.body || {};
    if (!kind || !subject) {
      return next(new ErrorHandler("kind and subject are required", 400));
    }
    if (String(reason || "").trim().length < 5) {
      // A dismissal with no reason is indistinguishable from somebody
      // clearing their screen, and it is the only record of why a
      // pattern was judged harmless.
      return next(new ErrorHandler(
        "Say why this is not a problem — it is the only record of the judgement.",
        400
      ));
    }

    const feedback = await ServiceAnomalyFeedback.create({
      kind: String(kind).trim(),
      subject: String(subject).trim(),
      reason: String(reason).trim(),
      dismissedBy: req.user?._id,
    });

    res.status(201).json({ success: true, dismissal: {
      kind: feedback.kind, subject: feedback.subject, expiresAt: feedback.expiresAt,
    } });
  })
);

module.exports = router;
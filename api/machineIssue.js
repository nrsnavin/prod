// ══════════════════════════════════════════════════════════════
//  MACHINE ISSUE ROUTES
//  File: api/machineIssue.js
//  Mount: app.use('/api/v2/machine-issue', require('./api/machineIssue'));
//
//  Endpoints:
//    POST  /                  — worker reports a machine issue (AUTH)
//    GET   /employee/:empId   — list issues raised by one worker (AUTH)
//    GET   /                  — admin list (ADMIN)
//    GET   /:id               — single issue detail (AUTH)
//    PUT   /:id/status        — admin updates status / resolution (ADMIN)
//    DELETE /:id              — worker withdraws an open issue (AUTH)
//
//  A high or critical issue is told to the owner as a breakdown is
//  (services/machineIssueAlert.js).
// ══════════════════════════════════════════════════════════════
"use strict";

const express        = require("express");
const mongoose       = require("mongoose");
const router         = express.Router();
const MachineIssue   = require("../models/MachineIssue");
const Machine        = require("../models/Machine");
const Employee       = require("../models/Employee");
const ShiftDetail    = require("../models/ShiftDetail");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { capped } = require("../utils/listLimit");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin, selfOrAdmin } = require("../middleware/auth");
const { staffOnly } = require("../middleware/staffOnly");
const { resolveEmployeeId } = require("../utils/resolveEmployee");
const multer = require("multer");
const { keepRequestContext } = require("../middleware/userContext");
const issueIntake = require("../services/machineIssueIntake");
const { alertIfUrgent } = require("../services/machineIssueAlert");
const aiLedger = require("../services/aiLedger");

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const photo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// Every machine-issue route requires login. Staff routes additionally
// chain isAdmin('admin', 'production', 'accounts') in-line below.
router.use(isAuthenticated);

const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES   = ["open", "acknowledged", "in_progress", "resolved", "rejected"];
// The two ways an issue ends: `resolvedAt` / `resolvedBy` are of these.
const CLOSED     = ["resolved", "rejected"];

// A value written as itself in a pipeline update — a text beginning
// with "$" would otherwise be read as the name of a field.
const lit = (v) => ({ $literal: v });

// What every screen shows of an issue: its machine, who raised it —
// the operator, or the office login when there is none — and who closed it.
const withPeople = (query) => query
  .populate("machine", "ID status")
  .populate("employee", "name department role")
  .populate("reportedBy", "name")
  .populate("resolvedBy", "name role");

// ─────────────────────────────────────────────────────────────
//  POST /machine-issue/intake   { machineId, text } + optional "photo"
//
//  What the worker said (speech turned to text, Tamil or English) or
//  photographed, written up: title, English description, severity, and
//  the machine's open issues with any that look like the same fault.
//  Nothing is saved.
// ─────────────────────────────────────────────────────────────
router.post(
  "/intake",
  keepRequestContext(photo.single("photo")),
  catchAsyncErrors(async (req, res, next) => {
    const { machineId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(machineId || ""))) return next(new ErrorHandler("Pick the machine first", 400));
    const text = String(req.body?.text || "").slice(0, 3000);
    const image = req.file && PHOTO_TYPES.has(req.file.mimetype) ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : null;
    if (!text.trim() && !image) return next(new ErrorHandler("Say what is wrong, or add a photo", 400));
    try {
      res.json({ success: true, data: await issueIntake.intake({ machineId, text, image }) });
    } catch (err) {
      if (err.status === 404) return next(new ErrorHandler(err.message, 404));
      throw err;
    }
  })
);

router.post(
  "/",
  catchAsyncErrors(async (req, res, next) => {
    const {
      machineId,
      title,
      description,
      severity = "medium",
      attachments = [],
    } = req.body;

    // Workers file under their own id; admins may file on behalf, or
    // raise the issue directly (no linked employee) — recorded against
    // the admin user instead.
    const employeeId = resolveEmployeeId(req);
    const isAdminRole = req.user?.role === "admin";

    if (!machineId)   return next(new ErrorHandler("machineId is required", 400));
    if (!employeeId && !isAdminRole) {
      return next(new ErrorHandler("Cannot determine employee — your account has no linked employee", 403));
    }
    // Text, and some of it: `title?.trim()` on a number was a server error.
    if (typeof title !== "string" || !title.trim()) {
      return next(new ErrorHandler("title is required", 400));
    }
    if (typeof description !== "string" || !description.trim()) {
      return next(new ErrorHandler("description is required", 400));
    }
    if (!SEVERITIES.includes(severity)) {
      return next(new ErrorHandler(
        `severity must be one of: ${SEVERITIES.join(", ")}`, 400));
    }

    const machine = await Machine.findById(machineId, "ID status");
    if (!machine)  return next(new ErrorHandler("Machine not found", 404));
    let reporter = req.user?.name || "";
    if (employeeId) {
      const employee = await Employee.findById(employeeId, "name");
      if (!employee) return next(new ErrorHandler("Employee not found", 404));
      reporter = employee.name || reporter;
    }

    const issue = await MachineIssue.create({
      machine:     machineId,
      employee:    employeeId || undefined,
      reportedBy:  req.user?._id || undefined,
      source:      employeeId ? "worker" : "admin",
      title:       title.trim(),
      description: description.trim(),
      severity,
      attachments: Array.isArray(attachments) ? attachments : [],
    });

    // Written up from what the worker said: what was filed scores it.
    if (mongoose.Types.ObjectId.isValid(String(req.body.aiSuggestion || ""))) {
      aiLedger.settle(req.body.aiSuggestion, {
        accepted: { title: title.trim(), description: description.trim(), severity },
        decidedBy: req.user?._id, expectSurface: "machine-issue-intake", ignoreMissing: true,
      }).catch(() => {});
    }

    res.status(201).json({ success: true, data: issue });

    // A stopped loom is not something to find in a list later. After the
    // answer, and never its problem: the issue is filed either way.
    alertIfUrgent(issue, { by: reporter, actor: { id: req.user?._id, name: req.user?.name } })
      .catch((err) => console.warn(`[machine-issue] alert failed: ${err?.message}`));
  })
);

router.get(
  "/employee/:empId",
  selfOrAdmin,
  catchAsyncErrors(async (req, res, next) => {
    const { empId } = req.params;
    const issues = await MachineIssue.find({ employee: empId })
      .populate("machine", "ID status")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: issues.length, data: issues });
  })
);

router.get(
  "/",
  isAdmin('admin', 'production', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const { status, machineId } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (machineId) filter.machine = machineId;

    // Newest first, at most LIST_CEILING (utils/listLimit): this list only grows.
    const { rows: issues, capped: cut } = await capped(
      withPeople(MachineIssue.find(filter))
        .sort({ createdAt: -1 })
        .lean(),
      res
    );

    res.json({ success: true, count: issues.length, data: issues, ...(cut ? { capped: true } : {}) });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /machine-issue/anomalies?days=30&threshold=3
//
//  Machines that reported issues frequently in the window — a
//  repeat-offender signal worth a deeper look than any single
//  ticket. Registered before /:id so "anomalies" isn't read as an id.
// ─────────────────────────────────────────────────────────────
router.get(
  "/anomalies",
  isAdmin('admin', 'production'),
  staffOnly, // a roll-up for the office; a worker's own login has the same role
  catchAsyncErrors(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const threshold = Math.max(2, Number(req.query.threshold) || 3);
    const since = new Date(Date.now() - days * 86_400_000);

    const anomalies = await MachineIssue.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: {
          _id: "$machine",
          count:     { $sum: 1 },
          openCount: { $sum: { $cond: [{ $in: ["$status", ["open", "acknowledged", "in_progress"]] }, 1, 0] } },
          critical:  { $sum: { $cond: [{ $in: ["$severity", ["high", "critical"]] }, 1, 0] } },
          lastIssueAt: { $max: "$createdAt" },
      } },
      { $match: { count: { $gte: threshold } } },
      { $sort: { count: -1 } },
      { $lookup: { from: "machines", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: {
          _id: 0,
          machineId: "$_id",
          machineID: "$m.ID",
          status:    "$m.status",
          count: 1, openCount: 1, critical: 1, lastIssueAt: 1,
      } },
    ]);

    res.json({ success: true, windowDays: days, threshold, anomalies });
  })
);

router.get(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    const issue = await withPeople(MachineIssue.findById(req.params.id));
    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    res.json({ success: true, data: issue });
  })
);

router.put(
  "/:id/status",
  isAdmin('admin', 'production', 'accounts'),
  // A worker's own login has the role "production" too: it may report an
  // issue and see the list, but closing one (its own, or anybody's) is
  // the office's call. The role gate alone let it through.
  staffOnly,
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Issue not found", 404));
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }
    const set = { status: lit(status) };
    // The notes are changed when notes are sent. A change of status that
    // says nothing of them used to write "" over "Ordered the belt, due
    // Friday". An empty text, sent, still clears them.
    if (typeof req.body.resolutionNotes === "string") {
      set.resolutionNotes = lit(req.body.resolutionNotes.slice(0, 2000));
    }

    // One write, reading the status it replaces: every `$status` below is
    // the one on file, not the one being set.
    const stages = [{ $set: set }];
    if (CLOSED.includes(status)) {
      // When it was closed, and by whom — stamped when that is decided,
      // not again each time a closed issue is saved (a note corrected the
      // week after moved "resolved" to that day, under that name).
      const unchanged = { $eq: ["$status", lit(status)] };
      const now = lit(new Date());
      const who = lit(req.user?._id || null);
      set.resolvedAt = { $cond: [unchanged, { $ifNull: ["$resolvedAt", now] }, now] };
      set.resolvedBy = { $cond: [unchanged, { $ifNull: ["$resolvedBy", who] }, who] };
    } else {
      // Open again: it no longer says it was resolved, on a day, by someone.
      stages.push({ $unset: ["resolvedAt", "resolvedBy"] });
    }

    const issue = await withPeople(
      MachineIssue.findByIdAndUpdate(req.params.id, stages, { new: true })
    );

    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    res.json({ success: true, data: issue });
  })
);

router.delete(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid issue id", 400));
    }
    const issue = await MachineIssue.findById(req.params.id);
    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    if (issue.status !== "open") {
      return next(new ErrorHandler(
        "Only open issues can be withdrawn", 400));
    }

    // Workers can only withdraw their own issues; admins can withdraw
    // any. Without this check the route's router-level isAuthenticated
    // let any logged-in worker delete other workers' complaints.
    //
    // "Their own" needs an employee on both sides. An office login has
    // none, and neither has an issue the office raised — and undefined
    // is undefined, so any such login "owned" every such issue.
    const isAdminRole = req.user?.role === 'admin';
    if (!isAdminRole) {
      const mine = Boolean(req.user?.employee && issue.employee) &&
        String(req.user.employee) === String(issue.employee);
      if (!mine) {
        return next(new ErrorHandler(
          "You can only withdraw your own issues", 403));
      }
      // Raised by the supervisor from the floor entry: the loom's operator
      // is on it, but did not report it, and it is not theirs to take back.
      if (issue.source === "floor") {
        return next(new ErrorHandler(
          "This was raised from the floor entry — ask the office to close it", 403));
      }
    }

    // Only while it is still open — checked in the delete itself, so one
    // the office picked up a moment ago is not removed under them.
    const gone = await MachineIssue.findOneAndDelete({ _id: issue._id, status: "open" });
    if (!gone) {
      return next(new ErrorHandler(
        "Only open issues can be withdrawn", 400));
    }
    // The floor entry it was raised from no longer points at it.
    if (gone.shiftDetail) {
      await ShiftDetail.updateOne(
        { _id: gone.shiftDetail, "remark.issue": gone._id },
        { $unset: { "remark.issue": 1 } }
      );
    }
    res.json({ success: true, message: "Issue withdrawn" });
  })
);

module.exports = router;

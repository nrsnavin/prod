// ══════════════════════════════════════════════════════════════
//  MACHINE ISSUE ROUTES
//  File: api/machineIssue.js
//  Mount: app.use('/api/v2/machine-issue', require('./api/machineIssue'));
//
//  Endpoints:
//    POST  /                  — worker reports a machine issue
//    GET   /employee/:empId   — list issues raised by one worker
//    GET   /                  — admin list (filter by status / machine)
//    GET   /:id               — single issue detail
//    PUT   /:id/status        — admin updates status / resolution
//    DELETE /:id              — worker withdraws an open issue
// ══════════════════════════════════════════════════════════════
"use strict";

const express        = require("express");
const router         = express.Router();
const MachineIssue   = require("../models/MachineIssue");
const Machine        = require("../models/Machine");
const Employee       = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

// Severity validation (mirrors the schema enum so we 400 with a
// meaningful message instead of a 500 from Mongoose validation).
const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES   = ["open", "acknowledged", "in_progress", "resolved", "rejected"];

// ─────────────────────────────────────────────────────────────
// POST /          — worker reports an issue
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  catchAsyncErrors(async (req, res, next) => {
    const {
      machineId,
      employeeId,
      title,
      description,
      severity = "medium",
      attachments = [],
    } = req.body;

    if (!machineId)   return next(new ErrorHandler("machineId is required", 400));
    if (!employeeId)  return next(new ErrorHandler("employeeId is required", 400));
    if (!title?.trim())       return next(new ErrorHandler("title is required", 400));
    if (!description?.trim()) return next(new ErrorHandler("description is required", 400));
    if (!SEVERITIES.includes(severity)) {
      return next(new ErrorHandler(
        `severity must be one of: ${SEVERITIES.join(", ")}`, 400));
    }

    const [machine, employee] = await Promise.all([
      Machine.findById(machineId, "ID status"),
      Employee.findById(employeeId, "name"),
    ]);
    if (!machine)  return next(new ErrorHandler("Machine not found", 404));
    if (!employee) return next(new ErrorHandler("Employee not found", 404));

    const issue = await MachineIssue.create({
      machine:     machineId,
      employee:    employeeId,
      title:       title.trim(),
      description: description.trim(),
      severity,
      attachments: Array.isArray(attachments) ? attachments : [],
    });

    res.status(201).json({ success: true, data: issue });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /employee/:empId   — worker's own history
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:empId",
  catchAsyncErrors(async (req, res, next) => {
    const { empId } = req.params;
    const issues = await MachineIssue.find({ employee: empId })
      .populate("machine", "ID status")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: issues.length, data: issues });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /          — admin list (filter by status / machine)
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  catchAsyncErrors(async (req, res, next) => {
    const { status, machineId } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (machineId) filter.machine = machineId;

    const issues = await MachineIssue.find(filter)
      .populate("machine", "ID status")
      .populate("employee", "name department role")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: issues.length, data: issues });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    const issue = await MachineIssue.findById(req.params.id)
      .populate("machine", "ID status")
      .populate("employee", "name department role")
      .populate("resolvedBy", "name role");
    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    res.json({ success: true, data: issue });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id/status   — admin updates status / resolution
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id/status",
  catchAsyncErrors(async (req, res, next) => {
    const { status, resolutionNotes = "", resolvedBy } = req.body;
    if (!STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }

    const update = { status, resolutionNotes };
    if (status === "resolved" || status === "rejected") {
      update.resolvedAt = new Date();
      if (resolvedBy) update.resolvedBy = resolvedBy;
    }

    const issue = await MachineIssue.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true })
      .populate("machine", "ID status")
      .populate("employee", "name");

    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    res.json({ success: true, data: issue });
  })
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id   — worker withdraws an OPEN issue
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    const issue = await MachineIssue.findById(req.params.id);
    if (!issue) return next(new ErrorHandler("Issue not found", 404));
    if (issue.status !== "open") {
      return next(new ErrorHandler(
        "Only open issues can be withdrawn", 400));
    }
    await issue.deleteOne();
    res.json({ success: true, message: "Issue withdrawn" });
  })
);

module.exports = router;

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
// ══════════════════════════════════════════════════════════════
"use strict";

const express        = require("express");
const mongoose       = require("mongoose");
const router         = express.Router();
const MachineIssue   = require("../models/MachineIssue");
const Machine        = require("../models/Machine");
const Employee       = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

// Every machine-issue route requires login. Admin-only routes
// additionally chain isAdmin('admin') in-line below.
router.use(isAuthenticated);

const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES   = ["open", "acknowledged", "in_progress", "resolved", "rejected"];

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

router.get(
  "/",
  isAdmin('admin'),
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

router.put(
  "/:id/status",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { status, resolutionNotes = "" } = req.body;
    if (!STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }

    const update = { status, resolutionNotes };
    if (status === "resolved" || status === "rejected") {
      update.resolvedAt = new Date();
      update.resolvedBy = req.user?._id || null;
    }

    const issue = await MachineIssue.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true })
      .populate("machine", "ID status")
      .populate("employee", "name");

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
    const isOwner = req.user?.employee?.toString() ===
      issue.employee?.toString();
    const isAdminRole = req.user?.role === 'admin';
    if (!isOwner && !isAdminRole) {
      return next(new ErrorHandler(
        "You can only withdraw your own issues", 403));
    }

    await issue.deleteOne();
    res.json({ success: true, message: "Issue withdrawn" });
  })
);

module.exports = router;

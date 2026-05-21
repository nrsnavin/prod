// ══════════════════════════════════════════════════════════════
//  EMPLOYEE FEEDBACK ROUTES
//  File: api/feedback.js
//  Mount: app.use('/api/v2/feedback', require('./api/feedback'));
//
//  Endpoints:
//    POST   /                 — worker files complaint / suggestion (AUTH)
//    GET    /employee/:empId  — worker history (AUTH)
//    GET    /                 — admin list (ADMIN)
//    PUT    /:id/respond      — admin replies + sets status (ADMIN)
//    DELETE /:id              — worker withdraws an OPEN entry (AUTH)
// ══════════════════════════════════════════════════════════════
"use strict";

const express   = require("express");
const mongoose  = require("mongoose");
const router    = express.Router();
const Feedback  = require("../models/EmployeeFeedback");
const Employee  = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const TYPES      = ["complaint", "suggestion"];
const CATEGORIES = ["machine", "safety", "management", "facilities", "payroll", "other"];
const STATUSES   = ["open", "in_review", "resolved", "rejected", "closed"];

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const {
      employeeId,
      type,
      category = "other",
      subject,
      body,
      isAnonymous = false,
    } = req.body;

    if (!employeeId)        return next(new ErrorHandler("employeeId is required", 400));
    if (!TYPES.includes(type)) {
      return next(new ErrorHandler(
        `type must be one of: ${TYPES.join(", ")}`, 400));
    }
    if (!CATEGORIES.includes(category)) {
      return next(new ErrorHandler(
        `category must be one of: ${CATEGORIES.join(", ")}`, 400));
    }
    if (!subject?.trim()) return next(new ErrorHandler("subject is required", 400));
    if (!body?.trim())    return next(new ErrorHandler("body is required", 400));

    const emp = await Employee.findById(employeeId, "name");
    if (!emp) return next(new ErrorHandler("Employee not found", 404));

    const fb = await Feedback.create({
      employee: employeeId,
      type, category,
      subject:  subject.trim(),
      body:     body.trim(),
      isAnonymous,
    });

    res.status(201).json({ success: true, data: fb });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /employee/:empId
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:empId",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const items = await Feedback.find({ employee: req.params.empId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, count: items.length, data: items });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { status, type, category } = req.query;
    const filter = {};
    if (status && status !== "all")   filter.status   = status;
    if (type && type !== "all")       filter.type     = type;
    if (category && category !== "all") filter.category = category;

    const items = await Feedback.find(filter)
      .populate("employee", "name department role")
      .populate("respondedBy", "name role")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, count: items.length, data: items });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id/respond
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id/respond",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid feedback id", 400));
    }
    const { response = "", status } = req.body;
    if (status && !STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }

    // Trust the server, not the client: respondedBy comes from req.user.
    const update = {
      response,
      respondedAt: new Date(),
      respondedBy: req.user?._id || null,
    };
    if (status) update.status = status;

    const doc = await Feedback.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true })
      .populate("employee", "name");
    if (!doc) return next(new ErrorHandler("Feedback not found", 404));
    res.json({ success: true, data: doc });
  })
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id    — worker withdraws an OPEN entry
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid feedback id", 400));
    }
    const fb = await Feedback.findById(req.params.id);
    if (!fb) return next(new ErrorHandler("Feedback not found", 404));
    if (fb.status !== "open") {
      return next(new ErrorHandler(
        "Only open feedback can be withdrawn", 400));
    }
    await fb.deleteOne();
    res.json({ success: true, message: "Feedback withdrawn" });
  })
);

module.exports = router;

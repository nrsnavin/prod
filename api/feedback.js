// ══════════════════════════════════════════════════════════════
//  EMPLOYEE FEEDBACK ROUTES
//  File: api/feedback.js
//  Mount: app.use('/api/v2/feedback', require('./api/feedback'));
//
//  Endpoints:
//    POST   /                 — worker files complaint / suggestion
//    GET    /employee/:empId  — worker history
//    GET    /                 — admin list (filter by status/type)
//    PUT    /:id/respond      — admin replies + sets status
//    DELETE /:id              — worker withdraws an OPEN entry
// ══════════════════════════════════════════════════════════════
"use strict";

const express   = require("express");
const router    = express.Router();
const Feedback  = require("../models/EmployeeFeedback");
const Employee  = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const TYPES      = ["complaint", "suggestion"];
const CATEGORIES = ["machine", "safety", "management", "facilities", "payroll", "other"];
const STATUSES   = ["open", "in_review", "resolved", "rejected", "closed"];

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
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
  catchAsyncErrors(async (req, res, next) => {
    const { response = "", status, respondedBy } = req.body;
    if (status && !STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }

    const update = { response, respondedAt: new Date() };
    if (status) update.status = status;
    if (respondedBy) update.respondedBy = respondedBy;

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
  catchAsyncErrors(async (req, res, next) => {
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

// ══════════════════════════════════════════════════════════════
//  ANNOUNCEMENT ROUTES
//  File: api/announcement.js
//  Mount: app.use('/api/v2/announcement', require('./api/announcement'));
//
//  Endpoints:
//    GET   /active?dept=     — workers fetch active notices (AUTH)
//    GET   /                 — admin lists all (ADMIN)
//    POST  /                 — admin creates (ADMIN)
//    PUT   /:id              — admin edits (ADMIN)
//    DELETE /:id             — admin deletes (soft via isActive) (ADMIN)
// ══════════════════════════════════════════════════════════════
"use strict";

const express      = require("express");
const mongoose     = require("mongoose");
const router       = express.Router();
const Announcement = require("../models/Announcement");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const TYPES = ["info", "warning", "safety", "policy", "celebration"];

// ─────────────────────────────────────────────────────────────
// GET /active?dept=
//   Workers see: pinned first, then newest, where audience is
//   "all" OR matches their dept, and validUntil hasn't passed.
// ─────────────────────────────────────────────────────────────
router.get(
  "/active",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { dept } = req.query;
    const now = new Date();

    const filter = {
      isActive: true,
      $and: [
        { $or: [{ validFrom: { $exists: false } }, { validFrom: { $lte: now } }] },
        { $or: [{ validUntil: { $exists: false } }, { validUntil: null }, { validUntil: { $gte: now } }] },
      ],
      $or: [
        { audience: "all" },
        { audience: "department", department: dept || "" },
      ],
    };

    const items = await Announcement.find(filter)
      .sort({ isPinned: -1, createdAt: -1 })
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
    const items = await Announcement.find()
      .sort({ isPinned: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, count: items.length, data: items });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const {
      title, body,
      type = "info",
      audience = "all",
      department = "",
      isPinned = false,
      validFrom,
      validUntil,
      attachmentUrl = "",
    } = req.body;

    if (!title?.trim()) return next(new ErrorHandler("title is required", 400));
    if (!body?.trim())  return next(new ErrorHandler("body is required", 400));
    if (!TYPES.includes(type)) {
      return next(new ErrorHandler(
        `type must be one of: ${TYPES.join(", ")}`, 400));
    }
    if (audience === "department" && !department.trim()) {
      return next(new ErrorHandler(
        "department is required when audience is 'department'", 400));
    }

    // Parse and validate dates up front so Mongo never stores an
    // Invalid Date that silently breaks `$lte: now` comparisons.
    const parseDate = (raw, field) => {
      if (raw === undefined || raw === null || raw === "") return undefined;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        throw new ErrorHandler(`${field} is not a valid date`, 400);
      }
      return d;
    };
    let validFromDate, validUntilDate;
    try {
      validFromDate  = parseDate(validFrom,  "validFrom");
      validUntilDate = parseDate(validUntil, "validUntil");
    } catch (err) {
      return next(err);
    }

    const a = await Announcement.create({
      title:      title.trim(),
      body:       body.trim(),
      type,
      audience,
      department: department.trim(),
      isPinned,
      validFrom:  validFromDate,
      validUntil: validUntilDate,
      attachmentUrl,
    });

    res.status(201).json({ success: true, data: a });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const allowed = [
      "title", "body", "type", "audience", "department",
      "isPinned", "validFrom", "validUntil", "attachmentUrl", "isActive",
    ];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    if (update.type && !TYPES.includes(update.type)) {
      return next(new ErrorHandler(
        `type must be one of: ${TYPES.join(", ")}`, 400));
    }

    // Mirror POST validation: dates must parse, audience=='department'
    // requires a non-empty department.
    const parseDate = (raw, field) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        throw new ErrorHandler(`${field} is not a valid date`, 400);
      }
      return d;
    };
    try {
      if ('validFrom'  in update) update.validFrom  = parseDate(update.validFrom,  'validFrom');
      if ('validUntil' in update) update.validUntil = parseDate(update.validUntil, 'validUntil');
    } catch (err) {
      return next(err);
    }
    if (update.audience === 'department' &&
        (!update.department || !String(update.department).trim())) {
      return next(new ErrorHandler(
        "department is required when audience is 'department'", 400));
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid announcement id", 400));
    }
    const doc = await Announcement.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true });
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, data: doc });
  })
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id    — soft delete via isActive=false
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const doc = await Announcement.findByIdAndUpdate(
      req.params.id, { $set: { isActive: false } }, { new: true });
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, message: "Announcement deactivated" });
  })
);

module.exports = router;

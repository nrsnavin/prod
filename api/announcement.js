// ══════════════════════════════════════════════════════════════
//  ANNOUNCEMENT ROUTES
//  File: api/announcement.js
//  Mount: app.use('/api/v2/announcement', require('./api/announcement'));
//
//  Endpoints:
//    GET   /active?dept=     — workers fetch active notices
//    GET   /                 — admin lists all
//    POST  /                 — admin creates
//    PUT   /:id              — admin edits
//    DELETE /:id             — admin deletes (soft via isActive)
// ══════════════════════════════════════════════════════════════
"use strict";

const express      = require("express");
const router       = express.Router();
const Announcement = require("../models/Announcement");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const TYPES = ["info", "warning", "safety", "policy", "celebration"];

// ─────────────────────────────────────────────────────────────
// GET /active?dept=
//   Workers see: pinned first, then newest, where audience is
//   "all" OR matches their dept, and validUntil hasn't passed.
// ─────────────────────────────────────────────────────────────
router.get(
  "/active",
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

    const a = await Announcement.create({
      title:      title.trim(),
      body:       body.trim(),
      type,
      audience,
      department: department.trim(),
      isPinned,
      validFrom:  validFrom  ? new Date(validFrom)  : undefined,
      validUntil: validUntil ? new Date(validUntil) : undefined,
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
  catchAsyncErrors(async (req, res, next) => {
    const doc = await Announcement.findByIdAndUpdate(
      req.params.id, { $set: { isActive: false } }, { new: true });
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, message: "Announcement deactivated" });
  })
);

module.exports = router;

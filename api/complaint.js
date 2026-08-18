// ══════════════════════════════════════════════════════════════
//  CUSTOMER COMPLAINT ROUTES
//  File: api/complaint.js
//  Mount: app.use('/api/v2/complaint', gate(...), require('./api/complaint'));
//
//  Endpoints:
//    GET    /themes      — categories, and themes when there is enough
//    POST   /            — file a complaint
//    GET    /            — list, filtered
//    GET    /:id         — one complaint
//    GET    /:id/trace   — the blast radius behind it
//    PUT    /:id         — status, resolution, added notes
//
//  ── The model this serves had no routes at all ────────────────
//  models/Complaints.js has existed for a long time, exported as an ES
//  module in a CommonJS codebase, referenced by the customer-delete
//  usage probe and by the reset script and by nothing else. There was no
//  way to file a complaint, read one or resolve one. The lot trail this
//  file exposes was the reason to fix that.
//
//  ── Gating lives at the mount, not in here ────────────────────
//  Deliberately no isAdmin/isAuthenticated calls below. app.js applies
//  them to the whole router, and a second copy in here is how this file
//  would end up referencing an identifier it never imported — which
//  takes the entire app down at require time, not just this route,
//  because app.js requires every router at boot. That has happened.
//  See tests/api/appLoads.test.js.
// ══════════════════════════════════════════════════════════════
"use strict";

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const Complaint = require("../models/Complaints");
const { CATEGORIES, STATUSES } = require("../models/Complaints");
const JobOrder  = require("../models/JobOrder");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const { trace }  = require("../services/complaintTrace");
const themes     = require("../services/complaintThemes");

const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// ─────────────────────────────────────────────────────────────
// GET /themes
//
// Before /:id, and it has to stay before it: Express matches in order,
// so a later /themes would be swallowed by /:id and answered with
// "Invalid complaint id".
// ─────────────────────────────────────────────────────────────
router.get(
  "/themes",
  catchAsyncErrors(async (req, res) => {
    const days = Number(req.query.days);
    const report = await themes.analyse({
      days: Number.isFinite(days) && days > 0 ? days : 365,
    });
    res.json({ success: true, data: report });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  catchAsyncErrors(async (req, res, next) => {
    const {
      customer, job, elastic, category = "other",
      reason, feedback = "", date, attachments = [],
    } = req.body;

    if (!isId(customer)) return next(new ErrorHandler("A valid customer is required", 400));
    if (!isId(job))      return next(new ErrorHandler("A valid job is required", 400));
    if (elastic && !isId(elastic)) return next(new ErrorHandler("Invalid elastic id", 400));
    if (!CATEGORIES.includes(category)) {
      return next(new ErrorHandler(`category must be one of: ${CATEGORIES.join(", ")}`, 400));
    }
    if (!reason?.trim()) return next(new ErrorHandler("reason is required", 400));

    // The job is what the trail runs through, so a complaint against a
    // job that does not exist is worse than useless — it produces an
    // empty blast radius that reads as "nobody else is affected".
    const jobDoc = await JobOrder.findById(job).select("customer").lean();
    if (!jobDoc) return next(new ErrorHandler("Job not found", 404));

    // A complaint filed against another customer's job would put the
    // wrong name at the head of the trace and, worse, would send someone
    // to ring a customer about goods they never received.
    if (String(jobDoc.customer) !== String(customer)) {
      return next(new ErrorHandler(
        "That job belongs to a different customer — check the job number", 400));
    }

    const doc = await Complaint.create({
      customer, job,
      elastic: elastic || undefined,
      category,
      reason: reason.trim(),
      feedback: String(feedback || "").trim(),
      date: date ? new Date(date) : new Date(),
      attachments: Array.isArray(attachments) ? attachments : [],
    });

    res.status(201).json({ success: true, data: doc });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  catchAsyncErrors(async (req, res) => {
    const { status, category, customer } = req.query;
    const filter = {};
    if (status && status !== "all")     filter.status   = status;
    if (category && category !== "all") filter.category = category;
    if (customer && isId(customer))     filter.customer = customer;

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const [items, total] = await Promise.all([
      Complaint.find(filter)
        .populate("customer", "name")
        .populate("elastic", "name")
        .populate({ path: "job", select: "jobOrderNo order", populate: { path: "order", select: "orderNo" } })
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Complaint.countDocuments(filter),
    ]);

    res.json({ success: true, count: items.length, total, page, limit, data: items });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /:id/trace
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/trace",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Invalid complaint id", 400));
    const result = await trace(req.params.id);
    if (result.ok === false && result.reason === "not-found") {
      return next(new ErrorHandler("Complaint not found", 404));
    }
    res.json({ success: true, data: result });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Invalid complaint id", 400));
    const doc = await Complaint.findById(req.params.id)
      .populate("customer", "name")
      .populate("elastic", "name")
      .populate("actionTakenBy", "name")
      .populate({ path: "job", select: "jobOrderNo order status", populate: { path: "order", select: "orderNo" } })
      .lean();
    if (!doc) return next(new ErrorHandler("Complaint not found", 404));
    res.json({ success: true, data: doc });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Invalid complaint id", 400));

    const { status, resolution, feedback, actionTakenBy, category } = req.body;
    if (status && !STATUSES.includes(status)) {
      return next(new ErrorHandler(`status must be one of: ${STATUSES.join(", ")}`, 400));
    }
    if (category && !CATEGORIES.includes(category)) {
      return next(new ErrorHandler(`category must be one of: ${CATEGORIES.join(", ")}`, 400));
    }
    if (actionTakenBy && !isId(actionTakenBy)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    // Only the fields actually sent are written. A PUT carrying just a
    // status must not blank the resolution somebody typed yesterday.
    const update = {};
    if (status !== undefined)        update.status        = status;
    if (resolution !== undefined)    update.resolution    = String(resolution || "");
    if (feedback !== undefined)      update.feedback      = String(feedback || "").trim();
    if (category !== undefined)      update.category      = category;
    if (actionTakenBy !== undefined) update.actionTakenBy = actionTakenBy || null;

    if (Object.keys(update).length === 0) {
      return next(new ErrorHandler("Nothing to update", 400));
    }

    const doc = await Complaint.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true, runValidators: true }
    ).populate("customer", "name").lean();

    if (!doc) return next(new ErrorHandler("Complaint not found", 404));
    res.json({ success: true, data: doc });
  })
);

module.exports = router;

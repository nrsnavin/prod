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

const multer = require("multer");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { dateFrom } = require("../utils/requestDate");
const { keepRequestContext } = require("../middleware/userContext");
const intakeService = require("../services/complaintIntake");
const aiLedger = require("../services/aiLedger");
const { getDocumentSettings } = require("../services/documentSettings");
const Customer = require("../models/Customer");

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const photos = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 3 } });

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
    const complainedOn = dateFrom(date, "date", new Date());

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
      date: complainedOn,
      attachments: Array.isArray(attachments) ? attachments : [],
    });

    // Filled in from the customer's message: what was filed scores the read.
    if (isId(req.body.aiSuggestion)) {
      aiLedger.settle(req.body.aiSuggestion, {
        accepted: { category, reason: reason.trim(), job: String(job), elastic: elastic ? String(elastic) : null },
        decidedBy: req.user?._id, expectSurface: "complaint-intake", ignoreMissing: true,
      }).catch(() => {});
    }

    res.status(201).json({ success: true, data: doc });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /intake   { customer, text } + up to 3 "photos"
//   What the customer sent, read into the form: category, the
//   complaint in plain English, the likely jobs (from theirs), and the
//   elastic only when they named it. Nothing is saved.
// ─────────────────────────────────────────────────────────────
router.post(
  "/intake",
  keepRequestContext(photos.array("photos", 3)),
  catchAsyncErrors(async (req, res, next) => {
    const customer = req.body?.customer;
    if (!isId(customer)) return next(new ErrorHandler("Pick the customer first", 400));
    const text = String(req.body?.text || "").slice(0, 4000);
    const files = (Array.isArray(req.files) ? req.files : []).filter((f) => PHOTO_TYPES.has(f.mimetype));
    if (!text.trim() && !files.length) return next(new ErrorHandler("Paste what the customer sent, or add a photo", 400));
    try {
      const out = await intakeService.intake({ customer, text, images: files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })) });
      res.json({ success: true, data: out });
    } catch (err) {
      if (err.status === 404) return next(new ErrorHandler(err.message, 404));
      throw err;
    }
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
// GET /:id/reply-draft   a reply to the customer, to edit and send
// POST /:id/reply        { text, aiSuggestion } — what was sent, kept
//                        on the complaint's notes
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/reply-draft",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Invalid complaint id", 400));
    let found = null;
    try { found = await trace(req.params.id); } catch { found = null; }
    const settings = await getDocumentSettings().catch(() => ({}));
    try {
      const draft = await intakeService.draftReply(req.params.id, { company: settings?.companyName || "Balu Elastics", trace: found });
      const c = await Complaint.findById(req.params.id).select("customer").lean();
      const cust = c ? await Customer.findById(c.customer).select("phoneNumber").lean() : null;
      res.json({ success: true, data: { ...draft, phone: cust?.phoneNumber || "" } });
    } catch (err) {
      if (err.status === 404) return next(new ErrorHandler(err.message, 404));
      throw err;
    }
  })
);

router.post(
  "/:id/reply",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Invalid complaint id", 400));
    const text = String(req.body?.text || "").trim();
    if (text.length < 10) return next(new ErrorHandler("The reply is empty", 400));
    const c = await Complaint.findById(req.params.id).select("feedback").lean();
    if (!c) return next(new ErrorHandler("Complaint not found", 404));
    const stamp = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const note = `Reply sent ${stamp}${req.user?.name ? ` by ${req.user.name}` : ""}:\n${text.slice(0, 2000)}`;
    const feedback = c.feedback ? `${c.feedback}\n\n${note}` : note;
    await Complaint.updateOne({ _id: c._id }, { $set: { feedback } });
    if (isId(req.body?.aiSuggestion)) {
      aiLedger.settle(req.body.aiSuggestion, { accepted: { text }, decidedBy: req.user?._id, expectSurface: "complaint-reply", ignoreMissing: true }).catch(() => {});
    }
    res.json({ success: true, data: { feedback } });
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

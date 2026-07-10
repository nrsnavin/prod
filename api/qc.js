"use strict";
// ══════════════════════════════════════════════════════════════
//  QUALITY CONTROL
//  Mount: app.use('/api/v2/qc', ...)
//
//  POST /create        — record a QC result for a job+elastic
//  GET  /by-job        — all QC records for a job (?jobId=)
//  GET  /coa           — COA payload for a job (?jobId=) — the web
//                        app renders/prints it; grouped per elastic
//                        with the latest passing record.
// ══════════════════════════════════════════════════════════════

const express = require("express");
const multer  = require("multer");
const router = express.Router();

const QcRecord = require("../models/QcRecord");
const JobOrder = require("../models/JobOrder");
const Elastic  = require("../models/Elastic");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { classifyDefect } = require("../utils/qcVision");

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ── Jobs eligible for a QC check (weaving → checking) ──────────────
router.get(
  "/jobs-for-qc",
  catchAsyncErrors(async (_req, res) => {
    const jobs = await JobOrder.find({ status: { $in: ["weaving", "finishing", "checking"] } })
      .populate("customer", "name")
      .populate("elastics.elastic", "name testingParameters")
      .select("_id jobOrderNo status elastics customer")
      .sort({ updatedAt: -1 });
    res.json({ success: true, jobs });
  })
);

// ── Recent QC records across all jobs ──────────────────────────────
router.get(
  "/recent",
  catchAsyncErrors(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const records = await QcRecord.find({})
      .populate("elastic", "name")
      .populate("checkedBy", "name")
      .populate({ path: "job", select: "jobOrderNo customer", populate: { path: "customer", select: "name" } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-image")
      .lean();
    res.json({ success: true, count: records.length, records });
  })
);

// ── AI vision draft — classify defects from a photo (not saved) ────
router.post(
  "/vision-draft",
  imageUpload.single("image"),
  catchAsyncErrors(async (req, res, next) => {
    if (!req.file) return next(new ErrorHandler('No image uploaded (field name must be "image").', 400));
    const { elasticId } = req.body;

    let spec = { name: "elastic tape", parameters: [] };
    if (elasticId) {
      const elastic = await Elastic.findById(elasticId).select("name testingParameters").lean();
      if (elastic) {
        const tp = elastic.testingParameters || {};
        const params = [];
        if (tp.width != null)      params.push({ parameter: "Width (mm)",  expected: String(tp.width) });
        if (tp.elongation != null) params.push({ parameter: "Elongation (%)", expected: String(tp.elongation) });
        for (const [k, v] of Object.entries(tp)) {
          if (["width", "elongation"].includes(k)) continue;
          if (v != null && typeof v !== "object") params.push({ parameter: k, expected: String(v) });
        }
        spec = { name: elastic.name, parameters: params };
      }
    }

    let draft;
    try {
      draft = await classifyDefect(req.file.buffer, req.file.mimetype, spec);
    } catch (err) {
      return next(new ErrorHandler(err.message || "Vision analysis failed", 400));
    }
    if (!draft.available) {
      return res.json({ success: true, available: false, message: "AI vision is not configured (no API key)." });
    }
    if (!draft.ok) {
      return res.json({ success: true, available: true, ok: false, message: "Couldn't read the image confidently — fill the check manually." });
    }

    // Echo the image back as a data URL so the client can attach it on save.
    const image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    res.json({ success: true, available: true, ok: true, draft, image, spec });
  })
);

router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const {
      jobId,
      elasticId,
      checkedBy,
      results = [],
      defectCode = "",
      rejectedMeters = 0,
      notes = "",
      image = "",
      aiAssisted = false,
    } = req.body;

    if (!jobId) return next(new ErrorHandler("jobId is required", 400));
    if (!elasticId) return next(new ErrorHandler("elasticId is required", 400));
    if (!Array.isArray(results) || results.length === 0)
      return next(new ErrorHandler("At least one measured result is required", 400));

    const job = await JobOrder.findById(jobId).select("jobOrderNo status");
    if (!job) return next(new ErrorHandler("Job not found", 404));

    const cleanResults = results.map((r) => ({
      parameter: String(r.parameter || "").trim(),
      expected: String(r.expected ?? "").trim(),
      measured: String(r.measured ?? "").trim(),
      pass: Boolean(r.pass),
    }));
    if (cleanResults.some((r) => !r.parameter || r.measured === ""))
      return next(new ErrorHandler("Every result needs a parameter and a measured value", 400));

    const overallResult = cleanResults.every((r) => r.pass) ? "pass" : "fail";

    const record = await QcRecord.create({
      job: jobId,
      elastic: elasticId,
      checkedBy: checkedBy || undefined,
      results: cleanResults,
      overallResult,
      defectCode: overallResult === "fail" ? String(defectCode).trim() : "",
      rejectedMeters: Number(rejectedMeters) || 0,
      notes: String(notes).trim(),
      image: typeof image === "string" ? image : "",
      aiAssisted: Boolean(aiAssisted),
    });

    res.status(201).json({ success: true, record, jobOrderNo: job.jobOrderNo });
  })
);

router.get(
  "/by-job",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    const records = await QcRecord.find({ job: jobId })
      .populate("elastic", "name testingParameters")
      .populate("checkedBy", "name department")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: records.length, records });
  })
);

router.get(
  "/coa",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.query;
    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    const job = await JobOrder.findById(jobId)
      .populate("customer", "name gstin")
      .populate("order", "orderNo po")
      .select("jobOrderNo status customer order")
      .lean();
    if (!job) return next(new ErrorHandler("Job not found", 404));

    const records = await QcRecord.find({ job: jobId, overallResult: "pass" })
      .populate("elastic", "name")
      .populate("checkedBy", "name")
      .sort({ createdAt: -1 })
      .lean();

    // Latest passing record per elastic — that's what the COA certifies.
    const latestByElastic = new Map();
    for (const r of records) {
      const key = r.elastic?._id?.toString() ?? String(r.elastic);
      if (!latestByElastic.has(key)) latestByElastic.set(key, r);
    }

    res.json({
      success: true,
      coa: {
        jobOrderNo: job.jobOrderNo,
        orderNo: job.order?.orderNo ?? null,
        customerPo: job.order?.po ?? "",
        customerName: job.customer?.name ?? "",
        items: [...latestByElastic.values()].map((r) => ({
          elasticName: r.elastic?.name ?? "",
          checkedBy: r.checkedBy?.name ?? "",
          checkedAt: r.createdAt,
          results: r.results,
        })),
      },
    });
  })
);

module.exports = router;

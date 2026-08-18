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
const mongoose = require("mongoose");
const router = express.Router();

const QcRecord = require("../models/QcRecord");
const JobOrder = require("../models/JobOrder");
const Elastic  = require("../models/Elastic");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { classifyDefect } = require("../utils/qcVision");
const { VISION_MODEL } = require("../utils/anthropicClient");
const { promptVersion } = require("../utils/aiPrompts");
const ledger = require("../services/aiLedger");

// Cap uploads so the base64 photo stored on the QcRecord stays well under
// MongoDB's 16 MB per-document limit (base64 inflates the file ~1.33×).
const QC_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: QC_IMAGE_MAX_BYTES },
});
// data:<mime>;base64,<data> — a 4 MB file is ~5.6 MB of base64; reject
// anything that would risk the BSON cap as defence-in-depth on /create.
const QC_IMAGE_MAX_CHARS = 8 * 1024 * 1024;

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
    const startedAt = Date.now();
    try {
      draft = await classifyDefect(req.file.buffer, req.file.mimetype, spec);
    } catch (err) {
      await ledger.record({
        surface: "qc-vision",
        model: VISION_MODEL,
        promptVersion: promptVersion("qc-vision"),
        refType: "Elastic",
        refId: mongoose.Types.ObjectId.isValid(elasticId) ? elasticId : undefined,
        latencyMs: Date.now() - startedAt,
        error: err.message || String(err),
      });
      return next(new ErrorHandler(err.message || "Vision analysis failed", 400));
    }
    if (!draft.available) {
      return res.json({ success: true, available: false, message: "AI vision is not configured (no API key)." });
    }
    if (!draft.ok) {
      // The model answered with something the parser could not read.
      // This used to return a polite message and record nothing, so a
      // vision model that had started replying in prose instead of JSON
      // looked — from every angle a person can see — exactly like a
      // feature nobody was using.
      await ledger.record({
        surface: "qc-vision",
        model: VISION_MODEL,
        promptVersion: promptVersion("qc-vision"),
        refType: "Elastic",
        refId: mongoose.Types.ObjectId.isValid(elasticId) ? elasticId : undefined,
        latencyMs: Date.now() - startedAt,
        error: "reply could not be parsed as JSON",
      });
      return res.json({ success: true, available: true, ok: false, message: "Couldn't read the image confidently — fill the check manually." });
    }

    // Record what vision said BEFORE the inspector sees it. The id goes
    // back with the draft so POST /create can record what they actually
    // saved — the gap between the two is the only measurement of this
    // surface that exists, and until now it was thrown away on every
    // check: the corrected value was kept and the correction was not.
    const aiSuggestionId = await ledger.record({
      surface: "qc-vision",
      model: VISION_MODEL,
      promptVersion: promptVersion("qc-vision"),
      refType: "Elastic",
      refId: mongoose.Types.ObjectId.isValid(elasticId) ? elasticId : undefined,
      proposed: {
        overallResult: draft.overallResult,
        defectCode: draft.defectCode,
        rejectedMeters: draft.rejectedMetersHint,
        results: draft.results,
      },
      latencyMs: Date.now() - startedAt,
    });

    // Echo the image back as a data URL so the client can attach it on save.
    const image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    res.json({
      success: true, available: true, ok: true, draft, image, spec,
      aiSuggestionId: aiSuggestionId ? String(aiSuggestionId) : null,
    });
  })
);

// ── Fine-tune readiness: how close the labelled QC images are to a
//    trainable defect dataset. The flywheel — every AI draft an
//    inspector corrects and saves with a photo becomes a labelled
//    sample. Training runs offline once the thresholds are met. ──────
const FT = { MIN_SAMPLES: 200, MIN_CLASSES: 3, MIN_PER_CLASS: 20 };

router.get(
  "/training-readiness",
  catchAsyncErrors(async (_req, res) => {
    const [total, withImage, aiAssisted, failCount, byDefect] = await Promise.all([
      QcRecord.countDocuments({}),
      QcRecord.countDocuments({ image: { $ne: "" } }),
      QcRecord.countDocuments({ aiAssisted: true, image: { $ne: "" } }),
      QcRecord.countDocuments({ overallResult: "fail", image: { $ne: "" } }),
      QcRecord.aggregate([
        { $match: { image: { $ne: "" }, overallResult: "fail" } },
        { $group: { _id: { $ifNull: ["$defectCode", "(unlabelled)"] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const classes = byDefect.map((d) => ({ defectCode: d._id || "(unlabelled)", count: d.count }));
    // A "pass" class is a valid label too (defect-free), plus each defect code.
    const passWithImage = withImage - failCount;
    const labelClasses = [
      ...(passWithImage > 0 ? [{ defectCode: "pass (no defect)", count: passWithImage }] : []),
      ...classes,
    ];
    const classesReady = labelClasses.filter((c) => c.count >= FT.MIN_PER_CLASS).length;

    const ready = withImage >= FT.MIN_SAMPLES && classesReady >= FT.MIN_CLASSES;
    const progressPct = Math.min(100, Math.round((withImage / FT.MIN_SAMPLES) * 100));

    res.json({
      success: true,
      thresholds: FT,
      totals: {
        qcRecords: total,
        labelledImages: withImage,
        aiAssisted,
        aiAssistedShare: withImage > 0 ? Math.round((aiAssisted / withImage) * 100) : 0,
      },
      classes: labelClasses,
      classesReady,
      progressPct,
      ready,
      recommendation: ready
        ? "You have enough labelled data to fine-tune a defect classifier. Export the dataset to train offline."
        : `Keep capturing QC photos. Need ${Math.max(0, FT.MIN_SAMPLES - withImage)} more labelled images and ${Math.max(0, FT.MIN_CLASSES - classesReady)} more classes with ≥${FT.MIN_PER_CLASS} samples.`,
    });
  })
);

// ── Export a fine-tuning dataset: image + label pairs. ─────────────
router.get(
  "/export-dataset",
  catchAsyncErrors(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const records = await QcRecord.find({ image: { $ne: "" } })
      .select("image overallResult defectCode results elastic createdAt")
      .populate("elastic", "name")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const samples = records.map((r) => ({
      image: r.image,
      label: r.overallResult === "fail" ? (r.defectCode || "defect") : "pass",
      overallResult: r.overallResult,
      elastic: r.elastic?.name || null,
      parameters: (r.results || []).map((x) => ({ parameter: x.parameter, measured: x.measured, pass: x.pass })),
      capturedAt: r.createdAt,
    }));

    res.json({ success: true, count: samples.length, exportedAt: new Date().toISOString(), samples });
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
      aiSuggestionId = null,
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

    // Guard the BSON 16 MB cap — drop an oversized photo rather than fail
    // the whole QC save. The check is still recorded; just without the image.
    let safeImage = typeof image === "string" ? image : "";
    if (safeImage.length > QC_IMAGE_MAX_CHARS) safeImage = "";

    const record = await QcRecord.create({
      job: jobId,
      elastic: elasticId,
      checkedBy: checkedBy || undefined,
      results: cleanResults,
      overallResult,
      defectCode: overallResult === "fail" ? String(defectCode).trim() : "",
      rejectedMeters: Number(rejectedMeters) || 0,
      notes: String(notes).trim(),
      image: safeImage,
      aiAssisted: Boolean(aiAssisted),
    });

    // What the inspector settled on, against what vision proposed. The
    // outcome is DERIVED from the two payloads, not asserted by the
    // client: a UI that believes it applied the draft unchanged but
    // flipped one `pass` is an edit, whatever it believes.
    if (aiSuggestionId) {
      await ledger.settle(aiSuggestionId, {
        expectSurface: "qc-vision",
        accepted: {
          overallResult,
          defectCode: record.defectCode,
          rejectedMeters: record.rejectedMeters,
          results: cleanResults,
        },
        decidedBy: req.user?._id,
      });
    }

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

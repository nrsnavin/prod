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
const { inStages, OUTPUT_STAGES } = require('../domain/jobStatus');
const multer  = require("multer");
// multer finishes from a stream event, which loses the request's
// AsyncLocalStorage stores — the database it routes to and the user
// it audits as. See middleware/userContext.js.
const { keepRequestContext } = require("../middleware/userContext.js");
const mongoose = require("mongoose");
const router = express.Router();

const QcRecord = require("../models/QcRecord");
const JobOrder = require("../models/JobOrder");
const Order    = require("../models/Order");
const Elastic  = require("../models/Elastic");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { classifyDefect } = require("../utils/qcVision");
const { VISION_MODEL } = require("../utils/anthropicClient");
const { promptVersion } = require("../utils/aiPrompts");
const ledger = require("../services/aiLedger");
const rootCause = require("../services/defectRootCause");

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
    const jobs = await JobOrder.find({ status: inStages(OUTPUT_STAGES) })
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
  keepRequestContext(imageUpload.single("image")),
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

// ── Root cause: the lot trail, pointed backwards ───────────────────
//
//  YarnLot → WarpingBatch → job → elastic was built to answer "where
//  did this lot go". Run the other way it answers "what is causing this
//  defect", which is what it was worth building for.
//
//  Read-only, and every figure is a group-by and a chi-square that can
//  be reproduced by hand. Claude writes the closing sentence and
//  computes nothing — the output of this route names a lot, a machine
//  or a person, and that is not a thing to hand to a model.
//
//  ?days=90  ?elasticId=  ?narrative=1
//  Gating is at the mount in app.js — gate('production') plus
//  requireFeature('/qc', '/jobs') — so this route carries no guard of
//  its own. A second one here would be redundant at best, and this
//  router does not even import isAdmin.
router.get(
  "/root-cause",
  catchAsyncErrors(async (req, res) => {
    const days = Number(req.query.days);
    const opts = {
      days: Number.isFinite(days) && days > 0 ? Math.min(days, 1095) : 90,
      elasticId: mongoose.Types.ObjectId.isValid(req.query.elasticId)
        ? req.query.elasticId : undefined,
    };
    const out = req.query.narrative
      ? await rootCause.analyseWithNarrative(opts)
      : await rootCause.analyse(opts);
    res.json({ success: true, ...out });
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
//
//  Written a record at a time. Each sample carries its photo — megabytes
//  of text — and this used to read up to 2,000 of them into memory and
//  hand the lot to res.json() as one string. The dataset is "ready" at
//  200 photos, which is about where one string stops being possible
//  (and where reading them all at once is most of the server's memory,
//  for everybody using it). What arrives is the same document:
//  { success, exportedAt, samples: [...], count }.
/** Room in the socket again — or the reader gone, which is also an answer. */
const roomToWrite = (res) => new Promise((resolve) => {
  const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
  res.once("drain", done);
  res.once("close", done);
});

const exportSample = (r) => ({
  image: r.image,
  label: r.overallResult === "fail" ? (r.defectCode || "defect") : "pass",
  overallResult: r.overallResult,
  elastic: r.elastic?.name || null,
  parameters: (r.results || []).map((x) => ({ parameter: x.parameter, measured: x.measured, pass: x.pass })),
  capturedAt: r.createdAt,
});

router.get(
  "/export-dataset",
  catchAsyncErrors(async (req, res) => {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 500, 1), 2000);
    // Newest first, by creation. `createdAt` then `_id`: the photos make
    // these documents large, and the two together are a stable order.
    const cursor = QcRecord.find({ image: { $ne: "" } })
      .select("image overallResult defectCode results elastic createdAt")
      .populate("elastic", "name")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean()
      .cursor({ batchSize: 5 });

    res.status(200).set("Content-Type", "application/json; charset=utf-8");
    let count = 0;
    try {
      res.write(`{"success":true,"exportedAt":${JSON.stringify(new Date().toISOString())},"samples":[`);
      for await (const r of cursor) {
        if (res.destroyed) break;          // whoever asked has gone
        // Wait for the socket when it is full, so a slow download holds one
        // record in memory and not all of them.
        if (!res.write((count ? "," : "") + JSON.stringify(exportSample(r)))) await roomToWrite(res);
        count += 1;
      }
      if (!res.destroyed) res.end(`],"count":${count}}`);
    } catch (err) {
      // Half a document has gone: there is no status left to send. Cut the
      // download so it fails, rather than end it as if it were whole.
      console.error(`[qc:export-dataset] failed after ${count} samples: ${err?.message}`);
      res.destroy(err);
    } finally {
      await cursor.close().catch(() => {});
    }
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

    if (!mongoose.Types.ObjectId.isValid(String(jobId))) return next(new ErrorHandler("Job not found", 404));
    if (!mongoose.Types.ObjectId.isValid(String(elasticId))) return next(new ErrorHandler("elasticId is not a valid id", 400));

    const job = await JobOrder.findById(jobId).select("jobOrderNo status order elastics.elastic").lean();
    if (!job) return next(new ErrorHandler("Job not found", 404));

    // The elastic is one this job makes. The job's certificate is built
    // from its checks, so a check filed against the wrong job put an
    // elastic on that certificate the job never made. A job that lists
    // none of its own (older ones) is read off its order.
    let made = (job.elastics || []).map((e) => String(e.elastic));
    if (!made.length && job.order) {
      const order = await Order.findById(job.order).select("elasticOrdered.elastic").lean();
      made = (order?.elasticOrdered || []).map((e) => String(e.elastic));
    }
    if (!made.includes(String(elasticId))) {
      return next(new ErrorHandler(`That elastic is not made on this job (J-${job.jobOrderNo}).`, 400));
    }

    const cleanResults = results.map((r) => ({
      parameter: String(r?.parameter || "").trim(),
      expected: String(r?.expected ?? "").trim(),
      measured: String(r?.measured ?? "").trim(),
      // A yes, and nothing else. Boolean("false") is true: any text sent
      // for it was a pass.
      pass: r?.pass === true || r?.pass === "true",
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

    // Every check, newest first, without the photos.
    const records = await QcRecord.find({ job: jobId })
      .select("-image")
      .populate("elastic", "name")
      .populate("checkedBy", "name")
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    // Latest passing record per elastic — that's what the COA certifies.
    //
    // And the newest check of that elastic, when it is a FAILURE that came
    // after the pass: the sheet reads PASS, and whoever is about to print
    // and sign it should know the last word on this elastic was not that.
    const latestByElastic = new Map();
    const newestByElastic = new Map();
    for (const r of records) {
      const key = r.elastic?._id?.toString() ?? String(r.elastic);
      if (!newestByElastic.has(key)) newestByElastic.set(key, r);
      if (r.overallResult === "pass" && !latestByElastic.has(key)) latestByElastic.set(key, r);
    }
    const laterFail = (key, pass) => {
      const newest = newestByElastic.get(key);
      if (!newest || newest.overallResult !== "fail" || String(newest._id) === String(pass._id)) return null;
      return { at: newest.createdAt, defectCode: newest.defectCode || "", rejectedMeters: newest.rejectedMeters || 0 };
    };

    res.json({
      success: true,
      coa: {
        jobOrderNo: job.jobOrderNo,
        orderNo: job.order?.orderNo ?? null,
        customerPo: job.order?.po ?? "",
        customerName: job.customer?.name ?? "",
        items: [...latestByElastic.entries()].map(([key, r]) => ({
          elasticName: r.elastic?.name ?? "",
          checkedBy: r.checkedBy?.name ?? "",
          checkedAt: r.createdAt,
          results: r.results,
          laterFail: laterFail(key, r),
        })),
      },
    });
  })
);

module.exports = router;

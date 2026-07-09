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
const router = express.Router();

const QcRecord = require("../models/QcRecord");
const JobOrder = require("../models/JobOrder");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

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

"use strict";

const express           = require("express");
const router            = express.Router();
const Covering          = require("../models/Covering");
const JobOrder          = require("../models/JobOrder");
const Elastic           = require("../models/Elastic");   // keeps model in registry for nested populate
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");

// ══════════════════════════════════════════════════════════════
//  1.  LIST COVERINGS
//      GET /covering/list
//      ?status=open|in_progress|completed|cancelled
//      ?search=<jobOrderNo>
//      ?page=<n>&limit=<n>
// ══════════════════════════════════════════════════════════════

router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const {
      status = "open",
      search = "",
      page   = 1,
      limit  = 20,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const validStatuses = ["open", "in_progress", "completed", "cancelled"];
    if (!validStatuses.includes(status)) {
      return next(new ErrorHandler(`Invalid status: ${status}`, 400));
    }

    let filter = { status };

    if (search && search.trim()) {
      const jobNo = parseInt(search.trim(), 10);
      if (!isNaN(jobNo)) {
        const matchedJobs = await JobOrder.find({ jobOrderNo: jobNo }).select("_id");
        filter.job = { $in: matchedJobs.map((j) => j._id) };
      }
    }

    const [data, total] = await Promise.all([
      Covering.find(filter)
        .populate({
          path:   "job",
          select: "jobOrderNo status customer",
          populate: { path: "customer", select: "name" },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Covering.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page:    Number(page),
        limit:   Number(limit),
        hasMore: skip + data.length < total,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  2.  COVERING DETAIL
//      GET /covering/detail?id=<coveringId>
// ══════════════════════════════════════════════════════════════

router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Covering ID is required", 400));

    const covering = await Covering.findById(id)
      .populate({
        path: "job",
        populate: [
          { path: "customer", select: "name" },
          { path: "order",    select: "orderNo po status" },
        ],
      })
      .populate({
        path: "elasticPlanned.elastic",
        populate: [
          { path: "warpSpandex.id",    model: "RawMaterial", select: "name category" },
          { path: "spandexCovering.id", model: "RawMaterial", select: "name category" },
        ],
      })
      .lean();

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    res.status(200).json({ success: true, covering });
  })
);

// ══════════════════════════════════════════════════════════════
//  3.  START COVERING
//      POST /covering/start
//      body: { id }
// ══════════════════════════════════════════════════════════════

router.post(
  "/start",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const covering = await Covering.findById(id);
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    if (covering.status !== "open") {
      return next(
        new ErrorHandler(
          `Only OPEN covering can be started (current: ${covering.status})`, 400
        )
      );
    }

    covering.status = "in_progress";
    await covering.save();

    res.status(200).json({ success: true, covering });
  })
);

// ══════════════════════════════════════════════════════════════
//  4.  COMPLETE COVERING
//      POST /covering/complete
//      body: { id, remarks? }
//
//  KEY CHANGE: after marking covering as completed, we call
//  checkAndAdvanceToWeaving() which checks if the job's warping
//  is also complete. If both are done, the job automatically
//  transitions from "preparatory" → "weaving", making it ready
//  for machine assignment on the frontend.
// ══════════════════════════════════════════════════════════════

router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const covering = await Covering.findById(id);
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    if (covering.status !== "in_progress") {
      return next(
        new ErrorHandler(
          `Only IN-PROGRESS covering can be completed (current: ${covering.status})`, 400
        )
      );
    }

    covering.status        = "completed";
    covering.completedDate = new Date();
    if (remarks?.trim()) covering.remarks = remarks.trim();
    await covering.save();

    // ── Auto-advance job to weaving if warping is also complete ────
    const { advanced, jobStatus } = await checkAndAdvanceToWeaving(covering.job);

    res.status(200).json({
      success:   true,
      covering,
      job: {
        // Echo back the job's new status so the Flutter client can
        // react immediately (e.g. show "Assign Machine" button)
        advanced,
        status: jobStatus,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  5.  CANCEL COVERING
//      POST /covering/cancel
//      body: { id, remarks? }
// ══════════════════════════════════════════════════════════════

router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const covering = await Covering.findById(id);
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    if (covering.status === "completed") {
      return next(
        new ErrorHandler("Completed covering cannot be cancelled", 400)
      );
    }

    covering.status  = "cancelled";
    if (remarks?.trim()) covering.remarks = remarks.trim();
    await covering.save();

    res.status(200).json({ success: true, covering });
  })
);

module.exports = router;
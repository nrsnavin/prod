const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Covering = require("../models/Covering");
const JobOrder = require("../models/JobOrder");
const Employee = require("../models/Employee");

/**
 * 🔹 GET OPEN COVERING
 */
router.get(
  "/open",
  catchAsyncErrors(async (req, res, next) => {
    const coverings = await Covering.find({ status: "open" })
      .populate("job")
      .populate("machine")
      .populate("operator")
      .exec();

    res.status(200).json({
      success: true,
      count: coverings.length,
      data: coverings,
    });
  })
);

/**
 * 🔹 GET COMPLETED COVERING
 */
router.get(
  "/completed",
  catchAsyncErrors(async (req, res, next) => {
    const coverings = await Covering.find({ status: "completed" })
      .populate("job")
      .populate("machine")
      .populate("closedBy")
      .exec();

    res.status(200).json({
      success: true,
      count: coverings.length,
      data: coverings,
    });
  })
);

/**
 * 🔹 GET COVERING DETAIL
 * ?id=coveringId
 */
router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;

    if (!id) {
      return next(new ErrorHandler("Covering ID required", 400));
    }

    const covering = await Covering.findById(id)
      .populate("job")
      .populate("machine")
      .populate("elasticPlanned.elastic")
      .populate("elasticCovered.elastic")
      .populate("wastageElastic.elastic")
      .populate("operator")
      .populate("closedBy")
      .exec();

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    res.status(200).json({
      success: true,
      data: covering,
    });
  })
);

/**
 * 🔹 MARK COVERING AS COMPLETED
 */
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { coveringId, closedBy } = req.body;

    if (!coveringId || !closedBy) {
      return next(
        new ErrorHandler("Covering ID and closedBy are required", 400)
      );
    }

    const covering = await Covering.findById(coveringId);

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    covering.status = "completed";
    covering.closedBy = closedBy;
    covering.completedDate = new Date();

    await covering.save();

    res.status(200).json({
      success: true,
      message: "Covering completed successfully",
      data: covering,
    });
  })
);

module.exports = router;
    
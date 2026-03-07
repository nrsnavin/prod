const express = require("express");
const router = express.Router();

const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Elastic = require("../models/Elastic");
const RawMaterial = require("../models/RawMaterial");
const Costing = require("../models/Costing");

const { calculateElasticCosting } = require("../utils/elasticCosting.js");


// ────────────────────────────────────────────────────────────────
//  CREATE ELASTIC
// ────────────────────────────────────────────────────────────────
router.post(
  "/create-elastic",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;
      console.log("Received elastic data:", elasticData);

      const elastic = await Elastic.create(elasticData);

      const { materialCost, details } =
        await calculateElasticCosting(elasticData);

      const conversionCost = elasticData.conversionCost ?? 1.25;
      const totalCost = materialCost + conversionCost;

      const costing = await Costing.create({
        date: new Date(),
        elastic: elastic._id,
        conversionCost,
        materialCost,
        details,
        totalCost,
        status: "Draft",
      });

      elastic.costing = costing._id;
      await elastic.save();

      res.status(201).json({ success: true, elastic, costing });
    } catch (err) {
      console.error(err);
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


// ────────────────────────────────────────────────────────────────
//  LIST ELASTICS
// ────────────────────────────────────────────────────────────────
router.get(
  "/get-elastics",
  catchAsyncErrors(async (req, res) => {
    const { search = "", page = 1, limit = 20 } = req.query;

    const filter = search
      ? { name: { $regex: search, $options: "i" } }
      : {};

    const elastics = await Elastic.find(filter)
      .skip((page - 1) * limit)
      .limit(search ? 0 : Number(limit))
      .sort({ createdAt: -1 });

    const total = await Elastic.countDocuments(filter);

    res.json({ success: true, elastics, total, page: Number(page) });
  })
);


// ────────────────────────────────────────────────────────────────
//  GET ELASTIC DETAIL
// ────────────────────────────────────────────────────────────────
router.get(
  "/get-elastic-detail",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.query.id)
      .populate("warpSpandex.id")
      .populate("spandexCovering.id")
      .populate("weftYarn.id")
      .populate("warpYarn.id")
      .populate("costing");

    if (!elastic)
      return next(new ErrorHandler("Elastic not found", 404));

    res.json({ success: true, elastic });
  })
);


// ────────────────────────────────────────────────────────────────
//  UPDATE ELASTIC
//  FIX: was using a local calculateElasticCost() that always assumed
//  warpSpandex/weftYarn/spandexCovering were present — crash on optional
//  fields. Now uses calculateElasticCosting util (handles optional fields).
//  Also: creates a costing doc if one doesn't exist yet; field-level
//  assignment prevents accidental null overwrites.
// ────────────────────────────────────────────────────────────────
router.put(
  "/update-elastic",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;

      if (!elasticData._id) {
        return next(new ErrorHandler("Elastic _id is required", 400));
      }

      const elastic = await Elastic.findById(elasticData._id);
      if (!elastic)
        return next(new ErrorHandler("Elastic not found", 404));

      // ── 1. Update elastic fields ──────────────────────────────
      const fieldsToCopy = [
        "name", "weaveType", "pick", "noOfHook", "weight",
        "spandexEnds", "warpSpandex", "weftYarn", "spandexCovering",
        "warpYarn", "testingParameters",
      ];
      for (const field of fieldsToCopy) {
        if (elasticData[field] !== undefined) {
          elastic[field] = elasticData[field];
        }
      }
      // Coerce numeric types so Mongoose validators pass
      if (elasticData.pick      !== undefined) elastic.pick      = Number(elasticData.pick);
      if (elasticData.noOfHook  !== undefined) elastic.noOfHook  = Number(elasticData.noOfHook);
      if (elasticData.weight    !== undefined) elastic.weight    = Number(elasticData.weight);
      if (elasticData.spandexEnds !== undefined) elastic.spandexEnds = Number(elasticData.spandexEnds);

      await elastic.save();

      // ── 2. Recalculate costing ────────────────────────────────
      let materialCost = 0;
      let details = [];

      try {
        const result = await calculateElasticCosting(elasticData);
        materialCost = result.materialCost;
        details      = result.details;
      } catch (costErr) {
        // Non-fatal: log and continue — costing will show 0 until fixed
        console.warn("Costing recalculation warning:", costErr.message);
      }

      // ── 3. Update or create costing document ─────────────────
      if (elastic.costing) {
        const existingCosting = await Costing.findById(elastic.costing);
        const conversionCost  = existingCosting?.conversionCost ?? 1.25;

        await Costing.findByIdAndUpdate(elastic.costing, {
          materialCost,
          details,
          totalCost: materialCost + conversionCost,
          status: "Draft",
        });
      } else {
        // Elastic had no costing — create one now
        const conversionCost = 1.25;
        const costing = await Costing.create({
          date: new Date(),
          elastic: elastic._id,
          conversionCost,
          materialCost,
          details,
          totalCost: materialCost + conversionCost,
          status: "Draft",
        });
        elastic.costing = costing._id;
        await elastic.save();
      }

      // ── 4. Return fully populated elastic ────────────────────
      const updated = await Elastic.findById(elastic._id)
        .populate("warpSpandex.id")
        .populate("spandexCovering.id")
        .populate("weftYarn.id")
        .populate("warpYarn.id")
        .populate("costing");

      res.json({ success: true, elastic: updated });
    } catch (err) {
      console.error("update-elastic error:", err);
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


// ────────────────────────────────────────────────────────────────
//  RECALCULATE COST  (manual trigger)
// ────────────────────────────────────────────────────────────────
router.post(
  "/recalculate-elastic-cost",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.body.elasticId);
    if (!elastic)
      return res.status(404).json({ success: false });

    try {
      const { materialCost, details } =
        await calculateElasticCosting(elastic.toObject());

      const existingCosting = await Costing.findById(elastic.costing);
      const conversionCost  = existingCosting?.conversionCost ?? 1.25;

      await Costing.findByIdAndUpdate(elastic.costing, {
        materialCost,
        details,
        totalCost: materialCost + conversionCost,
      });

      res.json({ success: true });
    } catch (err) {
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


// ────────────────────────────────────────────────────────────────
//  DELETE ELASTIC
// ────────────────────────────────────────────────────────────────
router.delete(
  "/delete-elastic",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.query.id);
    if (!elastic)
      return next(new ErrorHandler("Elastic not found", 404));

    // Delete associated costing document if it exists
    if (elastic.costing) {
      await Costing.findByIdAndDelete(elastic.costing);
    }

    await elastic.deleteOne();

    res.json({
      success: true,
      message: "Elastic deleted successfully",
    });
  })
);


module.exports = router;
const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Elastic  = require("../models/Elastic");
const Costing  = require("../models/Costing");
const { calculateElasticCosting } = require("../utils/elasticCosting.js");

// ── Helper: full populate for elastic ─────────────────────────
const _populate = (q) =>
  q
    .populate("warpSpandex.id")
    .populate("spandexCovering.id")
    .populate("weftYarn.id")
    .populate("warpYarn.id")
    .populate("costing")
    .populate("warpingPlanTemplate.beams.sections.warpYarn", "name category");

// ── Helper: normalise + compute totalEnds per beam ─────────────
function _normalisePlan(template) {
  const beams = (template.beams || []).map((b, i) => {
    const sections = (b.sections || [])
      .filter((s) => s.warpYarn && Number(s.ends) > 0)
      .map((s) => ({
        warpYarn:  s.warpYarn,
        ends:      Number(s.ends || 0),
        maxMeters: Number(s.maxMeters || 0),
      }));
    const totalEnds = sections.reduce((sum, s) => sum + s.ends, 0);
    return {
      beamNo:    b.beamNo ?? i + 1,
      totalEnds,
      sections,
    };
  });
  return { noOfBeams: beams.length, beams };
}


// ────────────────────────────────────────────────────────────────
//  CREATE ELASTIC
//  Accepts optional warpingPlanTemplate in body.
// ────────────────────────────────────────────────────────────────
router.post(
  "/create-elastic",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;
      console.log("Received elastic data:", JSON.stringify(elasticData, null, 2));

      // Pull out the plan so Elastic.create() doesn't choke on it
      const planTemplate = elasticData.warpingPlanTemplate ?? null;
      delete elasticData.warpingPlanTemplate;

      const elastic = await Elastic.create(elasticData);

      // Attach validated plan if supplied
      if (
        planTemplate &&
        Array.isArray(planTemplate.beams) &&
        planTemplate.beams.length > 0
      ) {
        elastic.warpingPlanTemplate = _normalisePlan(planTemplate);
        await elastic.save();
      }

      const { materialCost, details } = await calculateElasticCosting(elasticData);
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
    const elastic = await _populate(Elastic.findById(req.query.id));
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));
    res.json({ success: true, elastic });
  })
);


// ────────────────────────────────────────────────────────────────
//  UPDATE ELASTIC
//  Also accepts warpingPlanTemplate — pass null/empty to clear.
// ────────────────────────────────────────────────────────────────
router.put(
  "/update-elastic",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;

      if (!elasticData._id)
        return next(new ErrorHandler("Elastic _id is required", 400));

      const elastic = await Elastic.findById(elasticData._id);
      if (!elastic)
        return next(new ErrorHandler("Elastic not found", 404));

      // ── 1. Core fields ────────────────────────────────────────
      const fieldsToCopy = [
        "name", "weaveType", "pick", "noOfHook", "weight",
        "spandexEnds", "warpSpandex", "weftYarn", "spandexCovering",
        "warpYarn", "testingParameters",
      ];
      for (const field of fieldsToCopy) {
        if (elasticData[field] !== undefined) elastic[field] = elasticData[field];
      }
      if (elasticData.pick        !== undefined) elastic.pick        = Number(elasticData.pick);
      if (elasticData.noOfHook    !== undefined) elastic.noOfHook    = Number(elasticData.noOfHook);
      if (elasticData.weight      !== undefined) elastic.weight      = Number(elasticData.weight);
      if (elasticData.spandexEnds !== undefined) elastic.spandexEnds = Number(elasticData.spandexEnds);

      // ── 2. Warping plan template (optional) ───────────────────
      if ("warpingPlanTemplate" in elasticData) {
        const tpl = elasticData.warpingPlanTemplate;
        if (tpl && Array.isArray(tpl.beams) && tpl.beams.length > 0) {
          elastic.warpingPlanTemplate = _normalisePlan(tpl);
        } else {
          elastic.warpingPlanTemplate = undefined;
        }
      }

      await elastic.save();

      // ── 3. Recalculate costing ────────────────────────────────
      let materialCost = 0, details = [];
      try {
        ({ materialCost, details } = await calculateElasticCosting(elasticData));
      } catch (costErr) {
        console.warn("Costing recalculation warning:", costErr.message);
      }

      if (elastic.costing) {
        const existingCosting = await Costing.findById(elastic.costing);
        const conversionCost  = existingCosting?.conversionCost ?? 1.25;
        await Costing.findByIdAndUpdate(elastic.costing, {
          materialCost, details,
          totalCost: materialCost + conversionCost,
          status: "Draft",
        });
      } else {
        const conversionCost = 1.25;
        const costing = await Costing.create({
          date: new Date(), elastic: elastic._id,
          conversionCost, materialCost, details,
          totalCost: materialCost + conversionCost,
          status: "Draft",
        });
        elastic.costing = costing._id;
        await elastic.save();
      }

      const updated = await _populate(Elastic.findById(elastic._id));
      res.json({ success: true, elastic: updated });
    } catch (err) {
      console.error("update-elastic error:", err);
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


// ────────────────────────────────────────────────────────────────
//  ADD / UPDATE WARPING PLAN TEMPLATE  (standalone — called from
//  elastic detail page when plan was skipped at creation time)
//
//  PUT /elastic/warping-plan-template
//  Body: { elasticId, template: { noOfBeams, beams: [...] } }
//        Pass template: null to clear.
// ────────────────────────────────────────────────────────────────
router.put(
  "/warping-plan-template",
  catchAsyncErrors(async (req, res, next) => {
    const { elasticId, template } = req.body;
    if (!elasticId) return next(new ErrorHandler("elasticId is required", 400));

    const elastic = await Elastic.findById(elasticId);
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    if (template && Array.isArray(template.beams) && template.beams.length > 0) {
      elastic.warpingPlanTemplate = _normalisePlan(template);
    } else {
      elastic.warpingPlanTemplate = undefined;
    }
    await elastic.save();

    const updated = await _populate(Elastic.findById(elasticId));
    res.json({ success: true, elastic: updated });
  })
);


// ────────────────────────────────────────────────────────────────
//  RECALCULATE COST  (manual trigger from detail page)
//
//  POST /elastic/recalculate-elastic-cost
//  Body: { elasticId, conversionCost? }
//
//  Changes vs original:
//  • Uses _populate() so raw material prices are always fresh from DB
//  • Accepts an optional conversionCost override from the client
//    (allows the user to change conversion cost inline)
//  • Updates costing.date to now (tracks when last recalculated)
//  • Returns the full updated costing object so Flutter can
//    update the UI without a second fetch
// ────────────────────────────────────────────────────────────────
router.post(
  "/recalculate-elastic-cost",
  catchAsyncErrors(async (req, res, next) => {
    const { elasticId, conversionCost: convCostOverride } = req.body;

    if (!elasticId) {
      return next(new ErrorHandler("elasticId is required", 400));
    }

    // ── Load with full population so calculateElasticCosting
    //    receives populated raw material objects (with current price)
    const elastic = await _populate(Elastic.findById(elasticId));
    if (!elastic) {
      return res.status(404).json({ success: false, message: "Elastic not found" });
    }

    try {
      const { materialCost, details } =
        await calculateElasticCosting(elastic.toObject());

      // Determine conversion cost:
      //   1. Use override from request body if supplied
      //   2. Fall back to existing costing value
      //   3. Default to 1.25
      const existingCosting = elastic.costing
        ? await Costing.findById(
            typeof elastic.costing === "object"
              ? elastic.costing._id
              : elastic.costing
          )
        : null;

      const conversionCost =
        convCostOverride != null
          ? Number(convCostOverride)
          : (existingCosting?.conversionCost ?? 1.25);

      const totalCost = materialCost + conversionCost;

      let updatedCosting;

      if (existingCosting) {
        // Update in place
        updatedCosting = await Costing.findByIdAndUpdate(
          existingCosting._id,
          {
            $set: {
              materialCost,
              conversionCost,
              details,
              totalCost,
              date: new Date(),   // mark when last recalculated
            },
          },
          { new: true }
        );
      } else {
        // No costing document yet — create one
        updatedCosting = await Costing.create({
          date: new Date(),
          elastic: elastic._id,
          conversionCost,
          materialCost,
          details,
          totalCost,
          status: "Draft",
        });
        elastic.costing = updatedCosting._id;
        await elastic.save();
      }

    

      res.json({ success: true, costing: updatedCosting });
    } catch (err) {
      console.error("[recalculate-elastic-cost]", err.message);
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
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    if (elastic.costing) await Costing.findByIdAndDelete(elastic.costing);
    await elastic.deleteOne();

    res.json({ success: true, message: "Elastic deleted successfully" });
  })
);


module.exports = router;
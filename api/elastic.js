const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Elastic       = require("../models/Elastic");
const Costing       = require("../models/Costing");
const StockMovement = require("../models/StockMovement");
const { calculateElasticCosting } = require("../utils/elasticCosting.js");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { applyMovement } = require("../utils/elasticStock");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");

// Mixed-auth router. Mount in app.js without ADMIN_GATE — we
// require isAuthenticated for everything here and add isAdmin
// per-route on writes. Mirrors the warping/covering/packing/shift
// pattern in this same backend.
router.use(isAuthenticated);

// ── Helper: full populate for elastic ─────────────────
const _populate = (q) =>
  q
    .populate("warpSpandex.id")
    .populate("spandexCovering.id")
    .populate("weftYarn.id")
    .populate("warpYarn.id")
    .populate("costing")
    .populate("warpingPlanTemplate.beams.sections.warpYarn", "name category");

// ── Helper: normalise + compute totalEnds per beam ─────────
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


// ─────────────────────────────────────────────────────────────
//  CREATE ELASTIC
//  Accepts optional warpingPlanTemplate in body.
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-elastic",
  isAdmin('admin'),
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


// ─────────────────────────────────────────────────────────────
//  LIST ELASTICS
// ─────────────────────────────────────────────────────────────
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


// ─────────────────────────────────────────────────────────────
//  GET ELASTIC DETAIL
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-elastic-detail",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await _populate(Elastic.findById(req.query.id));
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));
    res.json({ success: true, elastic });
  })
);


// ─────────────────────────────────────────────────────────────
//  STOCK MAP — admin overview of every elastic's stock
//  GET /api/v2/elastic/stock-summary
//
//  IMPORTANT: must appear before /:id/stock so '/stock-summary'
//  is not captured as an :id.
// ─────────────────────────────────────────────────────────────
router.get(
  "/stock-summary",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const elastics = await Elastic.find()
      .select("name stock quantityProduced minStock reservedStock")
      .lean();

    // One round-trip for the latest movement per elastic.
    const ids = elastics.map((e) => e._id);
    const lastMoves = ids.length
      ? await StockMovement.aggregate([
          { $match: { elastic: { $in: ids } } },
          { $sort:  { elastic: 1, date: -1, _id: -1 } },
          { $group: {
              _id:      "$elastic",
              lastDate: { $first: "$date" },
              lastType: { $first: "$type" },
          }},
        ])
      : [];
    const lastByElastic = new Map(lastMoves.map((m) => [String(m._id), m]));

    const summary = elastics.map((e) => {
      const last     = lastByElastic.get(String(e._id));
      const stock    = Number(e.stock) || 0;
      const reserved = Number(e.reservedStock) || 0;
      const minStock = Number(e.minStock) || 0;
      return {
        elasticId:        e._id,
        name:             e.name,
        stock,
        reservedStock:    reserved,
        available:        Math.max(0, stock - reserved),
        minStock,
        isLowStock:       minStock > 0 && stock <= minStock,
        quantityProduced: Number(e.quantityProduced) || 0,
        lastMovementAt:   last ? last.lastDate : null,
        lastMovementType: last ? last.lastType : null,
      };
    });

    summary.sort((a, b) => (b.stock || 0) - (a.stock || 0));
    res.json({ success: true, count: summary.length, summary });
  })
);


// ─────────────────────────────────────────────────────────────
//  STOCK DETAIL — current stock + paginated movement ledger
//  GET /api/v2/elastic/:id/stock?page=&limit=
//
//  AUTH (not ADMIN) so worker portals can render a stock screen.
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/stock",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid elastic id", 400));
    }

    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const elastic = await Elastic.findById(id)
      .select("name stock quantityProduced minStock reservedStock")
      .lean();
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    const filter = { elastic: elastic._id };
    const total     = await StockMovement.countDocuments(filter);
    const movements = await StockMovement.find(filter)
      .sort({ date: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const stock    = Number(elastic.stock) || 0;
    const reserved = Number(elastic.reservedStock) || 0;
    const minStock = Number(elastic.minStock) || 0;

    res.json({
      success: true,
      elastic: {
        _id:              elastic._id,
        name:             elastic.name,
        stock,
        reservedStock:    reserved,
        available:        Math.max(0, stock - reserved),
        minStock,
        isLowStock:       minStock > 0 && stock <= minStock,
        quantityProduced: Number(elastic.quantityProduced) || 0,
      },
      stock,
      reservedStock:    reserved,
      available:        Math.max(0, stock - reserved),
      minStock,
      quantityProduced: Number(elastic.quantityProduced) || 0,
      movements,
      page,
      limit,
      total,
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  MANUAL ADJUST — admin correction / opening balance / theft
//  POST /api/v2/elastic/:id/adjust-stock   { delta, reason }
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/adjust-stock",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    const { delta, reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid elastic id", 400));
    }
    const deltaNum = Number(delta);
    if (!Number.isFinite(deltaNum) || deltaNum === 0) {
      return next(new ErrorHandler("delta must be a non-zero number", 400));
    }
    if (!reason || !String(reason).trim()) {
      return next(new ErrorHandler("reason is required", 400));
    }

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const { elastic, movement } = await applyMovement(session, {
          elasticId: id,
          type:      "MANUAL_ADJUST",
          quantity:  deltaNum,
          refType:   "ManualAdjust",
          reason:    String(reason).trim(),
          by:        req.user?._id,
        });

        const fp = buildFingerprint(ACTION_CODES.ELASTIC_STOCK_ADJUST, {
          entityId: elastic._id,
          actor:    actorFromRequest(req),
          meta: {
            elasticName:    elastic.name,
            requestedDelta: deltaNum,
            appliedDelta:   movement.applied,
            balance:        movement.balance,
            reason:         String(reason).trim(),
          },
        });

        resp = {
          elasticId: elastic._id,
          name:      elastic.name,
          stock:     elastic.stock,
          movement,
          fingerprint: fp,
        };
      });
      res.json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);


// ─────────────────────────────────────────────────────────────
//  UPDATE ELASTIC
//  Also accepts warpingPlanTemplate — pass null/empty to clear.
// ─────────────────────────────────────────────────────────────
router.put(
  "/update-elastic",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;

      if (!elasticData._id)
        return next(new ErrorHandler("Elastic _id is required", 400));

      const elastic = await Elastic.findById(elasticData._id);
      if (!elastic)
        return next(new ErrorHandler("Elastic not found", 404));

      // ── 1. Core fields ───────────────────────────
      const fieldsToCopy = [
        "name", "weaveType", "pick", "noOfHook", "weight",
        "spandexEnds", "warpSpandex", "weftYarn", "spandexCovering",
        "warpYarn", "testingParameters", "minStock",
      ];
      for (const field of fieldsToCopy) {
        if (elasticData[field] !== undefined) elastic[field] = elasticData[field];
      }
      if (elasticData.pick        !== undefined) elastic.pick        = Number(elasticData.pick);
      if (elasticData.noOfHook    !== undefined) elastic.noOfHook    = Number(elasticData.noOfHook);
      if (elasticData.weight      !== undefined) elastic.weight      = Number(elasticData.weight);
      if (elasticData.spandexEnds !== undefined) elastic.spandexEnds = Number(elasticData.spandexEnds);
      if (elasticData.minStock    !== undefined) elastic.minStock    = Math.max(0, Number(elasticData.minStock) || 0);

      // ── 2. Warping plan template (optional) ───────────────
      if ("warpingPlanTemplate" in elasticData) {
        const tpl = elasticData.warpingPlanTemplate;
        if (tpl && Array.isArray(tpl.beams) && tpl.beams.length > 0) {
          elastic.warpingPlanTemplate = _normalisePlan(tpl);
        } else {
          elastic.warpingPlanTemplate = undefined;
        }
      }

      await elastic.save();

      // ── 3. Recalculate costing ────────────────────────
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


// ─────────────────────────────────────────────────────────────
//  ADD / UPDATE WARPING PLAN TEMPLATE  (standalone — called from
//  elastic detail page when plan was skipped at creation time)
// ─────────────────────────────────────────────────────────────
router.put(
  "/warping-plan-template",
  isAdmin('admin'),
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


// ─────────────────────────────────────────────────────────────
//  RECALCULATE COST  (manual trigger from detail page)
// ─────────────────────────────────────────────────────────────
router.post(
  "/recalculate-elastic-cost",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { elasticId, conversionCost: convCostOverride } = req.body;

    if (!elasticId) {
      return next(new ErrorHandler("elasticId is required", 400));
    }

    const elastic = await _populate(Elastic.findById(elasticId));
    if (!elastic) {
      return res.status(404).json({ success: false, message: "Elastic not found" });
    }

    try {
      const { materialCost, details } =
        await calculateElasticCosting(elastic.toObject());

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
        updatedCosting = await Costing.findByIdAndUpdate(
          existingCosting._id,
          {
            $set: {
              materialCost,
              conversionCost,
              details,
              totalCost,
              date: new Date(),
            },
          },
          { new: true }
        );
      } else {
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


// ─────────────────────────────────────────────────────────────
//  DELETE ELASTIC
// ─────────────────────────────────────────────────────────────
router.delete(
  "/delete-elastic",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.query.id);
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    if (elastic.costing) await Costing.findByIdAndDelete(elastic.costing);
    await elastic.deleteOne();

    res.json({ success: true, message: "Elastic deleted successfully" });
  })
);


module.exports = router;

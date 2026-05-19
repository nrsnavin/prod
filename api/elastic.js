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

router.use(isAuthenticated);

const _populate = (q) =>
  q
    .populate("warpSpandex.id")
    .populate("spandexCovering.id")
    .populate("weftYarn.id")
    .populate("warpYarn.id")
    .populate("costing")
    .populate("warpingPlanTemplate.beams.sections.warpYarn", "name category");

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


router.post(
  "/create-elastic",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;
      console.log("Received elastic data:", JSON.stringify(elasticData, null, 2));

      const planTemplate = elasticData.warpingPlanTemplate ?? null;
      delete elasticData.warpingPlanTemplate;

      const elastic = await Elastic.create(elasticData);

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


router.get(
  "/get-elastics",
  catchAsyncErrors(async (req, res) => {
    const { search = "", page = 1, limit = 20 } = req.query;
    const filter = search ? { name: { $regex: search, $options: "i" } } : {};
    const elastics = await Elastic.find(filter)
      .skip((page - 1) * limit)
      .limit(search ? 0 : Number(limit))
      .sort({ createdAt: -1 });
    const total = await Elastic.countDocuments(filter);
    res.json({ success: true, elastics, total, page: Number(page) });
  })
);


router.get(
  "/get-elastic-detail",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await _populate(Elastic.findById(req.query.id));
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));
    res.json({ success: true, elastic });
  })
);


router.get(
  "/stock-summary",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const elastics = await Elastic.find()
      .select("name stock quantityProduced minStock reservedStock")
      .lean();

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


router.get(
  "/reconcile",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const elastics = await Elastic.find().select("name stock").lean();
    if (elastics.length === 0) {
      return res.json({ success: true, elasticCount: 0, driftCount: 0, drifts: [] });
    }

    const ids = elastics.map((e) => e._id);
    const ledgers = await StockMovement.aggregate([
      { $match: { elastic: { $in: ids } } },
      { $group: {
          _id:   "$elastic",
          sum:   { $sum: "$applied" },
          count: { $sum: 1 },
      }},
    ]);
    const ledgerMap = new Map(ledgers.map((l) => [String(l._id), l]));

    const drifts = [];
    for (const e of elastics) {
      const l         = ledgerMap.get(String(e._id));
      const stock     = Number(e.stock) || 0;
      const ledgerSum = l ? Number(l.sum) || 0 : 0;
      const moveCount = l ? l.count : 0;
      const drift     = stock - ledgerSum;

      if (drift !== 0) {
        drifts.push({
          elasticId: e._id,
          name:      e.name,
          stock,
          ledgerSum,
          drift,
          moveCount,
        });
      }
    }

    res.json({
      success:      true,
      elasticCount: elastics.length,
      driftCount:   drifts.length,
      drifts,
    });
  })
);


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
//  MANUAL ADJUST
//  POST /api/v2/elastic/:id/adjust-stock { delta, reason, force? }
//
//  PR E P1-4: rejects |delta| > max(100, 0.5 * currentStock)
//  unless body has force: true. Error includes the threshold so
//  the UI can prompt a second confirm before retrying with force.
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/adjust-stock",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    const { delta, reason, force } = req.body;

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

    // Percentage cap — checked before opening the transaction so
    // the UI gets a clean 400 with the threshold value.
    const peek = await Elastic.findById(id).select("stock").lean();
    if (!peek) return next(new ErrorHandler("Elastic not found", 404));
    const currentStock = Number(peek.stock) || 0;
    const threshold    = Math.max(100, 0.5 * currentStock);
    if (Math.abs(deltaNum) > threshold && force !== true) {
      return next(new ErrorHandler(
        `Magnitude ${Math.abs(deltaNum)} exceeds ${threshold.toFixed(0)} (50% of ${currentStock} on hand, floor 100). Pass force:true to override.`,
        400
      ));
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
            forced:         force === true,
          },
        });

        resp = {
          elasticId: elastic._id,
          name:      elastic.name,
          stock:     elastic.stock,
          movement,
          fingerprint: fp,
          forced:    force === true,
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
//  SET MIN STOCK (lightweight)
//  PATCH /api/v2/elastic/:id/min-stock   { minStock }
// ─────────────────────────────────────────────────────────────
router.patch(
  "/:id/min-stock",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid elastic id", 400));
    }
    const v = Number(req.body?.minStock);
    if (!Number.isFinite(v) || v < 0) {
      return next(new ErrorHandler("minStock must be a non-negative number", 400));
    }

    const elastic = await Elastic.findByIdAndUpdate(
      id,
      { $set: { minStock: v } },
      { new: true }
    ).select("_id name stock minStock reservedStock");

    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    const stock    = Number(elastic.stock)    || 0;
    const minStock = Number(elastic.minStock) || 0;
    const reserved = Number(elastic.reservedStock) || 0;

    res.json({
      success:       true,
      elasticId:     elastic._id,
      name:          elastic.name,
      stock,
      minStock,
      reservedStock: reserved,
      available:     Math.max(0, stock - reserved),
      isLowStock:    minStock > 0 && stock <= minStock,
    });
  })
);


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

      if ("warpingPlanTemplate" in elasticData) {
        const tpl = elasticData.warpingPlanTemplate;
        if (tpl && Array.isArray(tpl.beams) && tpl.beams.length > 0) {
          elastic.warpingPlanTemplate = _normalisePlan(tpl);
        } else {
          elastic.warpingPlanTemplate = undefined;
        }
      }

      await elastic.save();

      const costingFields = [
        "weight", "pick", "noOfHook", "spandexEnds",
        "warpSpandex", "warpYarn", "spandexCovering", "weftYarn",
      ];
      const costingDirty = costingFields.some((f) =>
        Object.prototype.hasOwnProperty.call(elasticData, f)
      );

      if (costingDirty) {
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
      }

      const updated = await _populate(Elastic.findById(elastic._id));
      res.json({ success: true, elastic: updated });
    } catch (err) {
      console.error("update-elastic error:", err);
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


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
//
//  Refuses to delete when stock > 0, reservedStock > 0, or any
//  movements are on record. ?force=true overrides (admin escape
//  hatch for test data only — cascades StockMovement deletion).
// ─────────────────────────────────────────────────────────────
router.delete(
  "/delete-elastic",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.query.id);
    if (!elastic) return next(new ErrorHandler("Elastic not found", 404));

    const force = String(req.query.force || "").toLowerCase() === "true";

    if (!force) {
      const currentStock = Number(elastic.stock) || 0;
      if (currentStock !== 0) {
        return next(new ErrorHandler(
          `Refusing to delete: stock is ${currentStock}. Adjust to zero first, or pass force=true.`,
          400
        ));
      }
      const reserved = Number(elastic.reservedStock) || 0;
      if (reserved !== 0) {
        return next(new ErrorHandler(
          `Refusing to delete: ${reserved} unit(s) reserved against active orders. Cancel/complete those orders first, or pass force=true.`,
          400
        ));
      }
      const moveCount = await StockMovement.countDocuments({ elastic: elastic._id });
      if (moveCount > 0) {
        return next(new ErrorHandler(
          `Refusing to delete: ${moveCount} stock movement(s) on record. Pass force=true to override.`,
          400
        ));
      }
    }

    const deletedMoves = await StockMovement.deleteMany({ elastic: elastic._id });

    if (elastic.costing) await Costing.findByIdAndDelete(elastic.costing);
    await elastic.deleteOne();

    if (force) {
      console.warn(
        `[elastic/delete] FORCED delete of ${elastic._id} (${elastic.name}) by user=${req.user?._id} — cascaded ${deletedMoves.deletedCount || 0} StockMovement row(s).`
      );
    }

    res.json({
      success:               true,
      message:               "Elastic deleted successfully",
      forced:                force,
      cascadedMoves:         deletedMoves.deletedCount || 0,
    });
  })
);


module.exports = router;

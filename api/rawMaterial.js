"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/MaterialInward");
const MaterialOutward   = require("../models/MaterialOut.cjs");
const Supplier          = require("../models/Supplier");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");

// ══════════════════════════════════════════════════════════════
//  1.  CREATE RAW MATERIAL
//      POST /materials/create-raw-material
// ══════════════════════════════════════════════════════════════
router.post(
  "/create-raw-material",
  catchAsyncErrors(async (req, res, next) => {
    const { name, category, stock, minStock, supplier, price } = req.body;

    if (!name || !category || !supplier) {
      return next(new ErrorHandler("name, category and supplier are required", 400));
    }

    const material = await RawMaterial.create({
      name,
      category,
      stock:    stock    || 0,
      minStock: minStock || 0,
      supplier,
      price:    price    || 0,
    });

    res.status(201).json({ success: true, material });
  })
);

// ══════════════════════════════════════════════════════════════
//  2.  GET RAW MATERIALS LIST
//      GET /materials/get-raw-materials
//      ?search=<n> ?category=<cat> ?lowStock=true
// ══════════════════════════════════════════════════════════════
router.get(
  "/get-raw-materials",
  catchAsyncErrors(async (req, res, next) => {
    const { search, category, lowStock } = req.query;

    const filter = {};
    if (category)            filter.category = category;
    if (search)              filter.name = { $regex: search, $options: "i" };
    if (lowStock === "true") filter.$expr = { $lte: ["$stock", "$minStock"] };

    const materials = await RawMaterial.find(filter)
      .populate("supplier", "name")
      .select("-stockMovements")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, materials });
  })
);

// ══════════════════════════════════════════════════════════════
//  3.  GET RAW MATERIAL DETAIL
//      GET /materials/get-raw-material-detail?id=<id>
// ══════════════════════════════════════════════════════════════
router.get(
  "/get-raw-material-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Material ID required", 400));

    const material = await RawMaterial.findById(id)
      .populate("supplier", "name phone email")
      .populate("stockMovements.order", "orderNo")
      .lean();

    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    // Sort stockMovements newest-first, keep last 50
    material.stockMovements = (material.stockMovements || [])
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 50);

    // Sort priceHistory newest-first, keep last 20
    material.priceHistory = (material.priceHistory || [])
      .sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt))
      .slice(0, 20);

    const inwards = await MaterialInward.find({ rawMaterial: id })
      .populate("purchaseOrder", "poNo status")
      .sort({ inwardDate: -1 })
      .limit(50)
      .lean();

    const outwards = await MaterialOutward.find({ rawMaterial: id })
      .populate("job",   "jobOrderNo")
      .populate("order", "orderNo")
      .sort({ outwardDate: -1 })
      .limit(50)
      .lean();

    res.status(200).json({
      success: true,
      material: { ...material, inwards, outwards },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  4.  DELETE RAW MATERIAL
//      DELETE /materials/delete-raw-material?id=<id>
// ══════════════════════════════════════════════════════════════
router.delete(
  "/delete-raw-material",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Material ID required", 400));

    const material = await RawMaterial.findByIdAndDelete(id);
    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    res.status(200).json({ success: true, message: "Material deleted" });
  })
);

// ══════════════════════════════════════════════════════════════
//  5.  EDIT RAW MATERIAL
//      PUT /materials/edit-raw-material
// ══════════════════════════════════════════════════════════════
router.put(
  "/edit-raw-material",
  catchAsyncErrors(async (req, res, next) => {
    const { _id, ...update } = req.body;
    if (!_id) return next(new ErrorHandler("Material ID required", 400));

    const existing = await RawMaterial.findById(_id);
    if (!existing) return next(new ErrorHandler("Raw material not found", 404));

    // ── Track price change ────────────────────────────────────
    if (
      update.price !== undefined &&
      Number(update.price) !== Number(existing.price)
    ) {
      update.$push = {
        priceHistory: {
          price:    Number(update.price),
          oldPrice: Number(existing.price),
          changedAt: new Date(),
          reason:   update.priceReason?.trim() || "Manual edit",
        },
      };
      // Remove priceReason from the root update (not a schema field)
      delete update.priceReason;
    }

    const material = await RawMaterial.findByIdAndUpdate(_id, update, {
      new: true, runValidators: true,
    });

    res.status(200).json({ success: true, material });
  })
);

// ══════════════════════════════════════════════════════════════
//  6.  SUPPLIERS LIST
//      GET /materials/suppliers?search=<n>
// ══════════════════════════════════════════════════════════════
router.get(
  "/suppliers",
  catchAsyncErrors(async (req, res, next) => {
    const { search } = req.query;
    const filter = {};
    if (search) filter.name = { $regex: search, $options: "i" };

    const suppliers = await Supplier.find(filter)
      .select("name phone email")
      .sort({ name: 1 })
      .limit(100);

    res.status(200).json({ success: true, suppliers });
  })
);

// ══════════════════════════════════════════════════════════════
//  7.  RAISE PURCHASE ORDER
//      POST /materials/raise-po
// ══════════════════════════════════════════════════════════════
router.post(
  "/raise-po",
  catchAsyncErrors(async (req, res, next) => {
    const { supplier, items } = req.body;

    if (!supplier)                   return next(new ErrorHandler("Supplier required", 400));
    if (!items || items.length === 0) return next(new ErrorHandler("At least one item required", 400));

    for (const item of items) {
      if (!item.rawMaterial) return next(new ErrorHandler("rawMaterial required for each item", 400));
      if (!item.quantity || item.quantity <= 0)
        return next(new ErrorHandler("quantity must be > 0 for each item", 400));
    }

    const po = await PurchaseOrder.create({
      supplier, items, date: new Date(), status: "Open",
    });

    const populated = await po.populate([
      { path: "supplier",           select: "name" },
      { path: "items.rawMaterial",  select: "name category" },
    ]);

    res.status(201).json({ success: true, po: populated });
  })
);

// ══════════════════════════════════════════════════════════════
//  8.  MATERIAL INWARD
//      POST /materials/material-inward
// ══════════════════════════════════════════════════════════════
router.post(
  "/material-inward",
  catchAsyncErrors(async (req, res, next) => {
    const { rawMaterialId, purchaseOrderId, quantity, remarks } = req.body;

    if (!rawMaterialId || !purchaseOrderId || !quantity) {
      return next(
        new ErrorHandler("rawMaterialId, purchaseOrderId and quantity are required", 400)
      );
    }
    const qtyNum = Number(quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return next(
        new ErrorHandler("quantity must be a positive number", 400)
      );
    }

    const [material, po] = await Promise.all([
      RawMaterial.findById(rawMaterialId),
      PurchaseOrder.findById(purchaseOrderId),
    ]);

    if (!material) return next(new ErrorHandler("Raw material not found", 404));
    if (!po)       return next(new ErrorHandler("Purchase order not found", 404));

    material.stock += qtyNum;
    material.stockMovements.push({
      date:     new Date(),
      type:     "PO_INWARD",
      quantity: qtyNum,
      balance:  material.stock,
    });
    await material.save();

    const inward = await MaterialInward.create({
      rawMaterial:   rawMaterialId,
      purchaseOrder: purchaseOrderId,
      quantity:      Number(quantity),
      inwardDate:    new Date(),
      remarks:       remarks || "",
    });

    const item = po.items.find(
      (i) => i.rawMaterial.toString() === rawMaterialId
    );
    if (item) {
      item.receivedQuantity = (item.receivedQuantity || 0) + Number(quantity);
      const allFilled = po.items.every(
        (i) => (i.receivedQuantity || 0) >= (i.quantity || 0)
      );
      po.status = allFilled ? "Completed" : "Partial";
      await po.save();
    }

    res.status(201).json({ success: true, inward });
  })
);

// ══════════════════════════════════════════════════════════════
//  9.  BULK STOCK ADJUSTMENT  ← NEW
//      POST /materials/bulk-adjust-stock
//
//  Body:
//  {
//    adjustments: [
//      { _id: "...", adjustment: 50,  reason: "Physical count" },
//      { _id: "...", adjustment: -10, reason: "Damaged" },
//      { _id: "...", adjustment: 0  }   ← skipped automatically
//    ],
//    globalReason: "Monthly stock audit"   ← fallback reason
//  }
//
//  • Items with adjustment === 0 are silently skipped
//  • stock is clamped to minimum 0 (never goes negative)
//  • Appends a STOCK_ADJUST entry to stockMovements
//  • Returns { success, updated[], skipped, errors? }
// ══════════════════════════════════════════════════════════════
router.post(
  "/bulk-adjust-stock",
  catchAsyncErrors(async (req, res, next) => {
    const { adjustments = [], globalReason = "Stock adjustment" } = req.body;

    if (!Array.isArray(adjustments) || adjustments.length === 0) {
      return next(new ErrorHandler("adjustments array is required", 400));
    }

    // Only process items with a meaningful non-zero delta
    const toProcess = adjustments.filter(
      (a) => a._id && typeof a.adjustment === "number" && a.adjustment !== 0
    );

    if (toProcess.length === 0) {
      return res.status(200).json({
        success: true,
        message:  "No changes to apply",
        updated:  [],
        skipped:  adjustments.length,
      });
    }

    const updated = [];
    const errors  = [];

    // Batch-fetch every material up front instead of issuing one
    // findById per item in parallel — the old loop fired N round
    // trips per request.
    const ids = toProcess
      .map((a) => a._id)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const materials = await RawMaterial.find({ _id: { $in: ids } });
    const byId = new Map(materials.map((m) => [m._id.toString(), m]));

    await Promise.all(
      toProcess.map(async (item) => {
        try {
          const material = byId.get(String(item._id));
          if (!material) {
            errors.push({ id: item._id, error: "Not found" });
            return;
          }

          const oldStock  = material.stock;
          const newStock  = Math.max(0, oldStock + item.adjustment);

          material.stock = newStock;

          // Running balance log
          material.stockMovements.push({
            date:     new Date(),
            type:     "STOCK_ADJUST",
            quantity: item.adjustment,
            balance:  newStock,
          });
          await material.save();

          const reason = item.reason?.trim() || globalReason;

          // Create proper ledger record
          if (item.adjustment > 0) {
            // Positive adjustment → inward. Audit row creation is
            // non-fatal (schema may require purchaseOrder), but we
            // log so silent drops don't go unnoticed.
            try {
              await MaterialInward.create({
                rawMaterial:   material._id,
                purchaseOrder: item.purchaseOrderId || undefined,
                quantity:      item.adjustment,
                inwardDate:    new Date(),
                remarks:       `Stock adjustment: ${reason}`,
              });
            } catch (inwardErr) {
              console.warn(
                `[bulk-adjust] MaterialInward audit row failed for ${material._id}: ${inwardErr.message}`
              );
            }
          } else {
            // Negative adjustment → outward
            await MaterialOutward.create({
              rawMaterial: material._id,
              quantity:    Math.abs(item.adjustment),
              type:        "STOCK_ADJUST",
              outwardDate: new Date(),
              unitPrice:   material.price || 0,
              remarks:     `Stock adjustment: ${reason}`,
            });
          }

          updated.push({
            id:         material._id,
            name:       material.name,
            category:   material.category,
            oldStock,
            newStock,
            adjustment: item.adjustment,
          });
        } catch (err) {
          errors.push({ id: item._id, error: err.message });
        }
      })
    );

    res.status(200).json({
      success: true,
      message: `Updated ${updated.length} material(s)`,
      updated,
      skipped: adjustments.length - toProcess.length,
      errors:  errors.length ? errors : undefined,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  10. LOW STOCK  (legacy)
// ══════════════════════════════════════════════════════════════
router.get(
  "/get-low-stock-materials",
  catchAsyncErrors(async (req, res, next) => {
    const materials = await RawMaterial.find({
      $expr: { $lte: ["$stock", "$minStock"] },
    })
      .populate("supplier", "name")
      .sort({ stock: 1 });
    res.status(200).json({ success: true, materials });
  })
);

// ══════════════════════════════════════════════════════════════
//  10b. LOW STOCK  (auto-draft PO source)
//       GET /materials/low-stock
//
//  Returns materials at or below their min-stock threshold, each
//  decorated with a `suggestedQty` so the Flutter draft-PO sheet
//  can render a ready-to-submit form without further math.
//
//  Quantity heuristic: max(minStock * 2 - stock, minStock).
//  This refills back to ~2x the floor while always ordering at
//  least one full reorder cycle. Pure UI suggestion — the user
//  edits the value in the PO sheet before submitting.
//
//  Materials with no supplier are excluded from `materials` and
//  surfaced as `skippedNoSupplier` so the page can show a footer
//  count instead of silently swallowing them.
// ══════════════════════════════════════════════════════════════
router.get(
  "/low-stock",
  catchAsyncErrors(async (_req, res) => {
    const docs = await RawMaterial.find({
      $expr: { $lte: ["$stock", "$minStock"] },
      minStock: { $gt: 0 },
    })
      .populate("supplier", "name")
      .select("name stock minStock price supplier")
      .sort({ stock: 1 })
      .lean();

    const materials = [];
    let skippedNoSupplier = 0;

    for (const m of docs) {
      if (!m.supplier || !m.supplier._id) {
        skippedNoSupplier += 1;
        continue;
      }
      const suggestedQty = Math.max(m.minStock * 2 - m.stock, m.minStock);
      materials.push({
        _id:          m._id,
        name:         m.name,
        stock:        m.stock,
        minStock:     m.minStock,
        price:        m.price || 0,
        suggestedQty,
        supplier:     { _id: m.supplier._id, name: m.supplier.name },
      });
    }

    res.status(200).json({
      success: true,
      materials,
      skippedNoSupplier,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  11. MATERIAL FOR NEW ELASTIC  (legacy)
// ══════════════════════════════════════════════════════════════
router.get(
  "/materialForNewElastic",
  catchAsyncErrors(async (req, res, next) => {
    const [warp, rubber, weft, covering] = await Promise.all([
      RawMaterial.find({ category: "warp" }).sort({ name: 1 }),
      RawMaterial.find({ category: "Rubber" }).sort({ name: 1 }),
      RawMaterial.find({ category: "weft" }).sort({ name: 1 }),
      RawMaterial.find({ category: "covering" }).sort({ name: 1 }),
    ]);
    res.status(200).json({ warp, weft, rubber, covering });
  })
);

// ══════════════════════════════════════════════════════════════
//  BULK UPDATE PRICES
//  POST /materials/bulk-update-prices
//
//  Body:
//  {
//    updates: [{ _id, price }],   // only materials whose price changed
//    reason: "Monthly revision"   // shown in price history
//  }
//
//  • Skips materials where price hasn't actually changed
//  • Appends a priceHistory entry for each change
//  • Returns { success, updated: N, skipped: N, results: [...] }
// ══════════════════════════════════════════════════════════════
router.post(
  "/bulk-update-prices",
  catchAsyncErrors(async (req, res, next) => {
    const { updates = [], reason = "Bulk price update" } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return next(new ErrorHandler("updates array is required", 400));
    }

    // Validate all entries first
    for (const u of updates) {
      if (!u._id) return next(new ErrorHandler("Each update must have _id", 400));
      if (u.price === undefined || u.price === null || isNaN(Number(u.price))) {
        return next(new ErrorHandler(`Invalid price for material ${u._id}`, 400));
      }
      if (Number(u.price) < 0) {
        return next(new ErrorHandler(`Price cannot be negative for ${u._id}`, 400));
      }
    }

    const results  = [];
    let   skipped  = 0;

    // Process in parallel
    await Promise.all(
      updates.map(async (u) => {
        const material = await RawMaterial.findById(u._id).select("name price priceHistory");
        if (!material) { skipped++; return; }

        const newPrice = Number(u.price);
        const oldPrice = Number(material.price);

        // Skip if price hasn't changed
        if (newPrice === oldPrice) { skipped++; return; }

        await RawMaterial.findByIdAndUpdate(u._id, {
          $set:  { price: newPrice },
          $push: {
            priceHistory: {
              price:     newPrice,
              oldPrice,
              changedAt: new Date(),
              reason:    reason.trim() || "Bulk price update",
            },
          },
        });

        results.push({
          _id:      u._id,
          name:     material.name,
          oldPrice,
          newPrice,
          change:   +(newPrice - oldPrice).toFixed(4),
        });
      })
    );

    res.status(200).json({
      success: true,
      message: `Updated ${results.length} price(s)`,
      updated: results.length,
      skipped,
      results,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  PROJECTED STOCKOUT  (predictive low-stock)
//  GET /materials/projected-stockout?lookbackDays=30&horizonDays=7
//
//  For each material that is NOT already below its min-stock
//  floor (those are handled by /low-stock), project a stockout
//  date using its trailing daily consumption rate:
//
//      dailyRate     = Σ outward(quantity, last lookbackDays)
//                      / lookbackDays
//      daysToStockout = stock / dailyRate
//
//  Materials whose `daysToStockout < horizonDays` are returned
//  with a `suggestedQty` sized so the next reorder lands above
//  the floor after one trailing horizon's worth of consumption:
//
//      suggestedQty = max(minStock * 2 - stock + dailyRate * horizonDays,
//                         minStock)
//
//  Materials with reversed outward rows are excluded from the
//  consumption sum (the original write was rolled back).
// ══════════════════════════════════════════════════════════════
router.get(
  "/projected-stockout",
  catchAsyncErrors(async (req, res) => {
    const lookback  = Math.max(1, parseInt(req.query.lookbackDays, 10) || 30);
    const horizon   = Math.max(1, parseInt(req.query.horizonDays,  10) || 7);

    const since = new Date(Date.now() - lookback * 86_400_000);

    // Materials still in safe territory — strict > so we don't
    // double-count what /low-stock already surfaces.
    const mats = await RawMaterial.find({
      $expr: { $gt: ["$stock", "$minStock"] },
      stock:    { $gt: 0 },
      minStock: { $gt: 0 },
    })
      .populate("supplier", "name")
      .select("name stock minStock price supplier")
      .lean();

    if (mats.length === 0) {
      return res.json({ success: true, materials: [], count: 0 });
    }

    // One aggregation over MaterialOutward, bucketed per material.
    const totals = await MaterialOutward.aggregate([
      { $match: {
          rawMaterial: { $in: mats.map((m) => m._id) },
          outwardDate: { $gte: since },
          reversed:    { $ne: true },
        } },
      { $group: { _id: '$rawMaterial', total: { $sum: '$quantity' } } },
    ]);
    const consumedById = new Map(
      totals.map((t) => [String(t._id), t.total])
    );

    const out = [];
    for (const m of mats) {
      const consumed  = consumedById.get(String(m._id)) || 0;
      if (consumed <= 0) continue;
      const dailyRate = consumed / lookback;
      const daysToStockout = m.stock / dailyRate;
      if (daysToStockout >= horizon) continue;
      if (!m.supplier || !m.supplier._id) continue;

      const suggestedQty = Math.max(
        m.minStock * 2 - m.stock + dailyRate * horizon,
        m.minStock
      );

      out.push({
        _id:           m._id,
        name:          m.name,
        stock:         m.stock,
        minStock:      m.minStock,
        price:         m.price || 0,
        dailyRate:     parseFloat(dailyRate.toFixed(2)),
        daysToStockout: parseFloat(daysToStockout.toFixed(1)),
        suggestedQty:  parseFloat(suggestedQty.toFixed(2)),
        supplier:      { _id: m.supplier._id, name: m.supplier.name },
      });
    }
    out.sort((a, b) => a.daysToStockout - b.daysToStockout);

    res.json({
      success: true,
      lookbackDays: lookback,
      horizonDays:  horizon,
      materials:    out,
      count:        out.length,
    });
  })
);

module.exports = router;
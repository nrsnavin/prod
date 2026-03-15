"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/Materialnward");
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

    material.stockMovements = (material.stockMovements || [])
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 30);

    const inwards = await MaterialInward.find({ rawMaterial: id })
      .populate("purchaseOrder", "poNo status")
      .sort({ inwardDate: -1 })
      .limit(50)
      .lean();

    const outwards = await MaterialOutward.find({ rawMaterial: id })
      .populate("job", "jobOrderNo")
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

    const material = await RawMaterial.findByIdAndUpdate(_id, update, {
      new: true, runValidators: true,
    });
    if (!material) return next(new ErrorHandler("Raw material not found", 404));

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

    const [material, po] = await Promise.all([
      RawMaterial.findById(rawMaterialId),
      PurchaseOrder.findById(purchaseOrderId),
    ]);

    if (!material) return next(new ErrorHandler("Raw material not found", 404));
    if (!po)       return next(new ErrorHandler("Purchase order not found", 404));

    material.stock += Number(quantity);
    material.stockMovements.push({
      date:     new Date(),
      type:     "PO_INWARD",
      quantity: Number(quantity),
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

    await Promise.all(
      toProcess.map(async (item) => {
        try {
          const material = await RawMaterial.findById(item._id);
          if (!material) {
            errors.push({ id: item._id, error: "Not found" });
            return;
          }

          const oldStock  = material.stock;
          const newStock  = Math.max(0, oldStock + item.adjustment);

          material.stock = newStock;
          material.stockMovements.push({
            date:     new Date(),
            type:     "STOCK_ADJUST",
            quantity: item.adjustment,
            balance:  newStock,
            reason:   item.reason?.trim() || globalReason,
          });

          await material.save();

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
//  10. STOCK ADJUSTMENT HISTORY
//      GET /materials/adjust-history
//      ?page=1 &limit=50 &days=90 &category=<cat> &search=<n>
//
//  Returns every STOCK_ADJUST movement across all materials,
//  newest first, with full material info per entry.
//  Groups entries by calendar date so the Flutter UI can
//  render date-section headers.
// ══════════════════════════════════════════════════════════════
router.get(
  "/adjust-history",
  catchAsyncErrors(async (req, res, next) => {
    const {
      page     = 1,
      limit    = 50,
      days     = 90,
      category,
      search,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
    const limitNum = Math.min(200, parseInt(limit, 10) || 50);
    const daysNum  = Math.max(1, parseInt(days, 10)  || 90);
    const since    = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);

    // Build match filter on the material-level fields
    const matFilter = {};
    if (category && category !== "All") matFilter.category = category;
    if (search)                          matFilter.name = { $regex: search, $options: "i" };

    const pipeline = [
      // 1. Filter by material-level fields first
      { $match: matFilter },

      // 2. Unwind stockMovements (keep the parent doc for each movement)
      { $unwind: { path: "$stockMovements", preserveNullAndEmptyArrays: false } },

      // 3. Only STOCK_ADJUST type within the requested date window
      {
        $match: {
          "stockMovements.type": "STOCK_ADJUST",
          "stockMovements.date": { $gte: since },
        },
      },

      // 4. Project just what we need
      {
        $project: {
          _id:          0,
          materialId:   "$_id",
          materialName: "$name",
          category:     "$category",
          currentStock: "$stock",   // current stock at query time
          date:         "$stockMovements.date",
          adjustment:   "$stockMovements.quantity",
          balance:      "$stockMovements.balance",  // stock after this adjustment
          reason:       "$stockMovements.reason",
        },
      },

      // 5. Sort newest first
      { $sort: { date: -1 } },
    ];

    // Total count for pagination
    const countPipeline = [...pipeline, { $count: "total" }];
    const [countResult] = await RawMaterial.aggregate(countPipeline);
    const total = countResult?.total ?? 0;

    // Paginated data
    const dataPipeline = [
      ...pipeline,
      { $skip:  (pageNum - 1) * limitNum },
      { $limit: limitNum },
    ];
    const adjustments = await RawMaterial.aggregate(dataPipeline);

    res.status(200).json({
      success: true,
      total,
      page:    pageNum,
      limit:   limitNum,
      pages:   Math.ceil(total / limitNum),
      days:    daysNum,
      adjustments,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  11. LOW STOCK  (legacy)
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
//  13. MATERIAL FOR NEW ELASTIC  (legacy)
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

module.exports = router;
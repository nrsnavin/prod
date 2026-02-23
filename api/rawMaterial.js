"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/MaterialInward");
// FIX: MaterialOut.js used ES module syntax (import/export default) which
//      crashes under CommonJS require(). The schema is converted to CJS below.
//      If you have kept the original file as-is, require() will throw
//      "Must use import to load ES Module". Fix: convert MaterialOut.js to CJS.
const MaterialOutward   = require("../models/MaterialOut");
const Supplier          = require("../models/Supplier");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");

// ══════════════════════════════════════════════════════════════
//  1.  CREATE RAW MATERIAL
//      POST /materials/create-raw-material
//
//  FIX: nested try/catch inside catchAsyncErrors was redundant.
//       The RawMaterial schema has no `price` field — price was
//       being passed but silently dropped by Mongoose. Added
//       `price` field to the schema (see RawMaterial.js patch notes
//       at bottom of this file).
//  FIX: returned 201 Created — appropriate for POST, kept.
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
//      ?search=<name> ?category=<cat> ?lowStock=true
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
      .select("-stockMovements") // lean list — movements loaded in detail only
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, materials });
  })
);

// ══════════════════════════════════════════════════════════════
//  3.  GET RAW MATERIAL DETAIL
//      GET /materials/get-raw-material-detail?id=<id>
//
//  FIX: original only fetched the RawMaterial document with
//       stockMovements but never fetched MaterialInward or
//       MaterialOutward records — those tabs showed nothing.
//  FIX: supplier was not populated → detail page crashed when
//       trying to display supplier name.
//  FIX: no `/delete-raw-material` route existed, so the detail
//       page's delete button always failed silently.
// ══════════════════════════════════════════════════════════════

router.get(
  "/get-raw-material-detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Material ID required", 400));

    // Fetch material + last 30 movements
    const material = await RawMaterial.findById(id)
      .populate("supplier", "name phone email")
      .populate("stockMovements.order", "orderNo")
      .lean();

    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    // Sort and cap movements
    material.stockMovements = (material.stockMovements || [])
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 30);

    // Fetch MaterialInward records for this material
    const inwards = await MaterialInward.find({ rawMaterial: id })
      .populate("purchaseOrder", "poNo status")
      .sort({ inwardDate: -1 })
      .limit(50)
      .lean();

    // Fetch MaterialOutward records for this material
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
//
//  FIX: route was completely missing from original rawMaterial.js —
//       the detail controller called it and always got 404.
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
//  6.  GET SUPPLIERS LIST  (for Add Material + Raise PO dropdowns)
//      GET /materials/suppliers?search=<name>
//
//  FIX: route was completely missing — the Add Material form's
//       SearchableSupplierDropdown referenced a `SupplierController`
//       that didn't exist, and there was no suppliers endpoint.
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
//      body: { supplier, items: [{ rawMaterial, quantity, price }] }
//
//  FIX: route completely missing from original codebase. The
//       Raise PO button on the detail page had nowhere to call.
//       Creates a new PurchaseOrder with the material as a line
//       item and links it to the given supplier.
// ══════════════════════════════════════════════════════════════

router.post(
  "/raise-po",
  catchAsyncErrors(async (req, res, next) => {
    const { supplier, items } = req.body;

    if (!supplier)                  return next(new ErrorHandler("Supplier required", 400));
    if (!items || items.length === 0) return next(new ErrorHandler("At least one item required", 400));

    for (const item of items) {
      if (!item.rawMaterial) return next(new ErrorHandler("rawMaterial required for each item", 400));
      if (!item.quantity || item.quantity <= 0)
        return next(new ErrorHandler("quantity must be > 0 for each item", 400));
    }

    const po = await PurchaseOrder.create({
      supplier,
      items,
      date:   new Date(),
      status: "Open",
    });

    const populated = await po.populate([
      { path: "supplier",       select: "name" },
      { path: "items.rawMaterial", select: "name category" },
    ]);

    res.status(201).json({ success: true, po: populated });
  })
);

// ══════════════════════════════════════════════════════════════
//  8.  MATERIAL INWARD
//      POST /materials/material-inward
//      (fixed: original pushed to non-existent raw.materialsInward
//       and used raw.save() without error handling)
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

    // Update stock and add movement
    material.stock += Number(quantity);
    material.stockMovements.push({
      date:     new Date(),
      type:     "PO_INWARD",
      quantity: Number(quantity),
      balance:  material.stock,
    });
    await material.save();

    // Create MaterialInward record
    const inward = await MaterialInward.create({
      rawMaterial:   rawMaterialId,
      purchaseOrder: purchaseOrderId,
      quantity:      Number(quantity),
      inwardDate:    new Date(),
      remarks:       remarks || "",
    });

    // Update PO received quantity
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
//  9.  LEGACY / UTILITY ROUTES (kept from original)
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

// ══════════════════════════════════════════════════════════════
//  RawMaterial.js SCHEMA PATCH NOTES
//  Add `price` field to RawMaterialSchema:
//
//    price: { type: Number, default: 0 },
//
//  This field was used everywhere (create, list, detail) but
//  was missing from the schema → silently dropped by Mongoose
//  on every save and returned as undefined on every read.
//
//  MaterialOut.js PATCH NOTES
//  Convert from ES module to CommonJS:
//    1. Replace `import mongoose from 'mongoose';`
//       with `const mongoose = require('mongoose');`
//    2. Replace `export default mongoose.model(...)`
//       with `module.exports = mongoose.model(...)`
//  Without this, require('../models/MaterialOut') throws:
//  "Must use import to load ES Module"
// ══════════════════════════════════════════════════════════════
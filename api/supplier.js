'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  supplier.js  —  Supplier + Purchase Order + Material Inward routes
//
//  KEY FIX:
//    POST /inward-stock  now increments RawMaterial.stock for every item
//    received. Previously the route updated PO receivedQuantity and created
//    MaterialInward records but NEVER touched RawMaterial.stock — so stock
//    counts never changed on goods receipt. Fixed using bulkWrite $inc.
//
//    Also added: over-receipt guard (received qty cannot exceed pending)
//    and full validation pass BEFORE any DB writes (all-or-nothing).
// ══════════════════════════════════════════════════════════════════════════

const express        = require("express");
const router         = express.Router();

const Supplier       = require("../models/Supplier");
const PurchaseOrder  = require("../models/PurchaseOrder");
const MaterialInward = require("../models/Materialnward.js");
const RawMaterial    = require("../models/RawMaterial");   // ← added for stock update

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
// const { isAuthenticated, isAdmin } = require("../middleware/auth");


// ─────────────────────────────────────────────────────────────────────────
// HELPER: derive PO status from its items
// ─────────────────────────────────────────────────────────────────────────
function deriveStatus(items) {
  if (!items || items.length === 0) return "Open";
  const allDone = items.every((i) => (i.receivedQuantity || 0) >= (i.quantity || 0));
  const anyDone = items.some( (i) => (i.receivedQuantity || 0) > 0);
  if (allDone) return "Completed";
  if (anyDone) return "Partial";
  return "Open";
}


// ─────────────────────────────────────────────────────────────────────────
// POST /create-supplier
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/create-supplier",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const supplier = await Supplier.create(req.body);
      res.status(201).json({ success: true, supplier });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// POST /create-po
// Body: { supplier, items: [{ rawMaterial, price, quantity }] }
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/create-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { supplier, items } = req.body;
      if (!supplier)
        return next(new ErrorHandler("Supplier is required", 400));
      if (!items || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));

      const last     = await PurchaseOrder.findOne({}, { poNo: 1 }).sort({ poNo: -1 });
      const nextPoNo = last ? (last.poNo || 1000) + 1 : 1001;

      const po = await PurchaseOrder.create({
        supplier,
        items: items.map((i) => ({
          rawMaterial:      i.rawMaterial,
          price:            i.price    || 0,
          quantity:         i.quantity || 0,
          receivedQuantity: 0,
        })),
        poNo:   nextPoNo,
        status: "Open",
      });

      const populated = await PurchaseOrder.findById(po._id)
        .populate("supplier",           "name phoneNumber gstin")
        .populate("items.rawMaterial",  "name unit");

      res.status(201).json({ success: true, po: populated });
    } catch (error) {
      console.log(error.message);
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// GET /get-pos
// Query: page, limit, status, supplierId, search (poNo)
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/get-pos",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const page  = Number(req.query.page)  || 1;
      const limit = Number(req.query.limit) || 20;
      const skip  = (page - 1) * limit;

      const filter = {};
      if (req.query.status)     filter.status   = req.query.status;
      if (req.query.supplierId) filter.supplier  = req.query.supplierId;
      if (req.query.search) {
        const num = Number(req.query.search);
        if (!isNaN(num)) filter.poNo = num;
      }

      const [pos, total] = await Promise.all([
        PurchaseOrder.find(filter)
          .populate("supplier",          "name")
          .populate("items.rawMaterial", "name unit")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        PurchaseOrder.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        pos,
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasMore:    page * limit < total,
        },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// GET /get-po-detail?id=
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/get-po-detail",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const po = await PurchaseOrder.findById(req.query.id)
        .populate("supplier",          "name phoneNumber gstin email address contactPerson")
        .populate("items.rawMaterial", "name unit");

      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

      const inwardHistory = await MaterialInward.find({ purchaseOrder: po._id })
        .populate("rawMaterial", "name unit")
        .sort({ inwardDate: -1 });

      res.status(200).json({ success: true, po, inwardHistory });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// PUT /edit-po
// ─────────────────────────────────────────────────────────────────────────
router.put(
  "/edit-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const po = await PurchaseOrder.findById(req.body._id);
      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));
      if (po.status === "Completed")
        return next(new ErrorHandler("Completed POs cannot be edited", 400));

      const existingQtyMap = {};
      po.items.forEach((item) => {
        existingQtyMap[item.rawMaterial.toString()] = item.receivedQuantity || 0;
      });

      po.supplier = req.body.supplier || po.supplier;
      po.items    = (req.body.items || []).map((i) => ({
        rawMaterial:      i.rawMaterial,
        price:            i.price    || 0,
        quantity:         i.quantity || 0,
        receivedQuantity: existingQtyMap[i.rawMaterial] || 0,
      }));
      po.status = deriveStatus(po.items);
      await po.save();

      const populated = await PurchaseOrder.findById(po._id)
        .populate("supplier",          "name phoneNumber gstin")
        .populate("items.rawMaterial", "name unit");

      res.status(200).json({ success: true, po: populated });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// POST /clone-po
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/clone-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const source = await PurchaseOrder.findById(req.body.id);
      if (!source) return next(new ErrorHandler("Source PO not found", 404));

      const last     = await PurchaseOrder.findOne({}, { poNo: 1 }).sort({ poNo: -1 });
      const nextPoNo = last ? (last.poNo || 1000) + 1 : 1001;

      const cloned = await PurchaseOrder.create({
        supplier: source.supplier,
        items: source.items.map((i) => ({
          rawMaterial:      i.rawMaterial,
          price:            i.price,
          quantity:         i.quantity,
          receivedQuantity: 0,
        })),
        poNo:   nextPoNo,
        status: "Open",
      });

      const populated = await PurchaseOrder.findById(cloned._id)
        .populate("supplier",          "name phoneNumber gstin")
        .populate("items.rawMaterial", "name unit");

      res.status(201).json({ success: true, po: populated });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// POST /inward-stock
// Body: { poId, items: [{ rawMaterial, quantity, inwardDate?, remarks? }] }
//
// ✅ FIX: increments RawMaterial.stock for every received item.
//
// Flow (all-or-nothing: validate everything first, then write):
//   1. Load PO, reject if Completed
//   2. For each item:
//        a. Must exist on this PO
//        b. quantity must not exceed pending (ordered − already received)
//   3. Update PO receivedQuantity + derive new status, save PO
//   4. bulkWrite RawMaterial.$inc on stock  ← THE FIX
//   5. insertMany MaterialInward records
//   6. Return summary
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/inward-stock",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { poId, items } = req.body;

      if (!poId)
        return next(new ErrorHandler("PO ID is required", 400));
      if (!Array.isArray(items) || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));

      // ── Load PO ────────────────────────────────────────────────────
      const po = await PurchaseOrder.findById(poId);
      if (!po)
        return next(new ErrorHandler("Purchase Order not found", 404));

      if (po.status === "Completed") {
        return next(
          new ErrorHandler(
            "This PO is already Completed. No further inward allowed.", 400
          )
        );
      }

      // ── Filter out zero-qty rows up front ──────────────────────────
      const activeItems = items.filter(
        (i) => i.quantity && Number(i.quantity) > 0
      );
      if (activeItems.length === 0) {
        return next(
          new ErrorHandler(
            "All quantities are zero. Enter at least one positive quantity.", 400
          )
        );
      }

      // ── VALIDATION PASS (before any writes) ───────────────────────
      for (const inItem of activeItems) {
        const poItem = po.items.find(
          (p) => p.rawMaterial.toString() === inItem.rawMaterial.toString()
        );

        if (!poItem) {
          return next(
            new ErrorHandler(
              `Material ${inItem.rawMaterial} is not part of PO #${po.poNo}`, 400
            )
          );
        }

        const pending =
          (poItem.quantity || 0) - (poItem.receivedQuantity || 0);

        if (Number(inItem.quantity) > pending) {
          return next(
            new ErrorHandler(
              `Cannot receive ${inItem.quantity} — only ${pending} units ` +
              `are still pending for material ${inItem.rawMaterial}`, 400
            )
          );
        }
      }

      // ── WRITE PASS ────────────────────────────────────────────────
      const inwardDocs  = [];
      const bulkOps     = [];  // RawMaterial bulkWrite operations

      for (const inItem of activeItems) {
        const qty    = Number(inItem.quantity);
        const poItem = po.items.find(
          (p) => p.rawMaterial.toString() === inItem.rawMaterial.toString()
        );

        // 1. Update PO received quantity
        poItem.receivedQuantity = (poItem.receivedQuantity || 0) + qty;

        // 2. Prepare stock increment for RawMaterial  ← THE FIX
        bulkOps.push({
          updateOne: {
            filter: { _id: inItem.rawMaterial },
            update: {
              // Increment stock by the received quantity
              $inc: { stock: qty },
              // Append a movement record for full audit trail
              $push: {
                stockMovements: {
                  date:     inItem.inwardDate
                              ? new Date(inItem.inwardDate)
                              : new Date(),
                  type:     "PO_INWARD",
                  quantity: qty,
                  order:    po._id,
                },
              },
            },
          },
        });

        // 3. Prepare MaterialInward document
        inwardDocs.push({
          rawMaterial:   inItem.rawMaterial,
          purchaseOrder: poId,
          quantity:      qty,
          inwardDate:    inItem.inwardDate
                           ? new Date(inItem.inwardDate)
                           : new Date(),
          remarks:       inItem.remarks ? inItem.remarks.trim() : "",
        });
      }

      // Save PO with new receivedQuantity values and derived status
      po.status = deriveStatus(po.items);
      await po.save();

      // Increment stock on all affected raw materials in one round-trip
      await RawMaterial.bulkWrite(bulkOps);

      // Bulk-insert inward records
      const created = await MaterialInward.insertMany(inwardDocs);

      return res.status(201).json({
        success:       true,
        message:       `Stock inward recorded. PO is now ${po.status}.`,
        inwardCount:   created.length,
        inwardRecords: created,
        poStatus:      po.status,
      });
    } catch (error) {
      console.error("[inward-stock]", error.message);
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// GET /get-inward-history?poId=
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/get-inward-history",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const records = await MaterialInward.find({ purchaseOrder: req.query.poId })
        .populate("rawMaterial", "name unit")
        .sort({ inwardDate: -1 });
      res.status(200).json({ success: true, records });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// GET /get-suppliers
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/get-suppliers",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const page  = Number(req.query.page)  || 1;
      const limit = Number(req.query.limit) || 20;
      const skip  = (page - 1) * limit;
      const keyword = req.query.search
        ? { name: { $regex: req.query.search, $options: "i" } }
        : {};

      const [suppliers, total] = await Promise.all([
        Supplier.find(keyword).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Supplier.countDocuments(keyword),
      ]);

      res.status(200).json({
        success: true,
        suppliers,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// GET /get-supplier-detail?id=
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/get-supplier-detail",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const supplier = await Supplier.findById(req.query.id);
      if (!supplier)
        return next(new ErrorHandler("Supplier not found", 404));
      res.status(200).json({ success: true, supplier });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// PUT /edit-supplier
// ─────────────────────────────────────────────────────────────────────────
router.put(
  "/edit-supplier",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const supplier = await Supplier.findByIdAndUpdate(
        req.body._id, req.body, { new: true }
      );
      if (!supplier)
        return next(new ErrorHandler("Supplier not found", 404));
      res.status(200).json({ success: true, supplier });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


// ─────────────────────────────────────────────────────────────────────────
// DELETE /delete-supplier?id=
// ─────────────────────────────────────────────────────────────────────────
router.delete(
  "/delete-supplier",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const supplier = await Supplier.findById(req.query.id);
      if (!supplier)
        return next(new ErrorHandler("Supplier not found", 404));
      supplier.isActive = false;
      await supplier.save();
      res.status(200).json({ success: true, message: "Supplier deleted successfully" });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);


module.exports = router;
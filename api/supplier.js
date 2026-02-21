const express = require("express");
const router = express.Router();

const Supplier = require("../models/Supplier");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const PurchaseOrder = require("../models/PurchaseOrder");
const MaterialInward = require("../models/Materialnward.js");



router.post(
    "/create-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.create(req.body);

            res.status(201).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);






// ─────────────────────────────────────────────────────────────
// HELPER: derive PO status from its items
// ─────────────────────────────────────────────────────────────
function deriveStatus(items) {
  if (!items || items.length === 0) return "Open";
  const allDone = items.every((i) => i.receivedQuantity >= i.quantity);
  const anyDone = items.some((i) => i.receivedQuantity > 0);
  if (allDone) return "Completed";
  if (anyDone) return "Partial";
  return "Open";
}

// ─────────────────────────────────────────────────────────────
// POST /create-po
// Body: { supplier, items: [{ rawMaterial, price, quantity }] }
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { supplier, items } = req.body;

      if (!supplier) return next(new ErrorHandler("Supplier is required", 400));
      if (!items || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));

      // Auto-increment poNo: find the highest existing poNo
      const last = await PurchaseOrder.findOne({}, { poNo: 1 }).sort({
        poNo: -1,
      });
      const nextPoNo = last ? (last.poNo || 1000) + 1 : 1001;

      const po = await PurchaseOrder.create({
        supplier,
        items: items.map((i) => ({
          rawMaterial: i.rawMaterial,
          price: i.price || 0,
          quantity: i.quantity || 0,
          receivedQuantity: 0,
        })),
        poNo: nextPoNo,
        status: "Open",
      });

      const populated = await PurchaseOrder.findById(po._id)
        .populate("supplier", "name phoneNumber gstin")
        .populate("items.rawMaterial", "name unit");

      res.status(201).json({ success: true, po: populated });
    } catch (error) {
        console.log(error.message);
      return next(new ErrorHandler(error.message, 400));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// GET /get-pos
// Query: page, limit, status, supplierId, search (poNo)
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-pos",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.supplierId) filter.supplier = req.query.supplierId;
      if (req.query.search) {
        const num = Number(req.query.search);
        if (!isNaN(num)) filter.poNo = num;
      }

      const [pos, total] = await Promise.all([
        PurchaseOrder.find(filter)
          .populate("supplier", "name")
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
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// GET /get-po-detail?id=
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-po-detail",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const po = await PurchaseOrder.findById(req.query.id)
        .populate("supplier", "name phoneNumber gstin email address contactPerson")
        .populate("items.rawMaterial", "name unit");

      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

      // Fetch all inward history for this PO
      const inwardHistory = await MaterialInward.find({ purchaseOrder: po._id })
        .populate("rawMaterial", "name unit")
        .sort({ inwardDate: -1 });

      res.status(200).json({ success: true, po, inwardHistory });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /edit-po
// Body: { _id, supplier, items: [{ rawMaterial, price, quantity }] }
// Rules: Can only edit Open POs. receivedQuantity is preserved.
// ─────────────────────────────────────────────────────────────
router.put(
  "/edit-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const po = await PurchaseOrder.findById(req.body._id);
      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

      if (po.status === "Completed") {
        return next(
          new ErrorHandler("Completed POs cannot be edited", 400)
        );
      }

      // Preserve existing receivedQuantity per rawMaterial
      const existingQtyMap = {};
      po.items.forEach((item) => {
        existingQtyMap[item.rawMaterial.toString()] =
          item.receivedQuantity || 0;
      });

      po.supplier = req.body.supplier || po.supplier;
      po.items = (req.body.items || []).map((i) => ({
        rawMaterial: i.rawMaterial,
        price: i.price || 0,
        quantity: i.quantity || 0,
        receivedQuantity: existingQtyMap[i.rawMaterial] || 0,
      }));
      po.status = deriveStatus(po.items);
      await po.save();

      const populated = await PurchaseOrder.findById(po._id)
        .populate("supplier", "name phoneNumber gstin")
        .populate("items.rawMaterial", "name unit");

      res.status(200).json({ success: true, po: populated });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// POST /clone-po
// Body: { id }  →  duplicates PO with new poNo, resets status & receivedQty
// ─────────────────────────────────────────────────────────────
router.post(
  "/clone-po",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const source = await PurchaseOrder.findById(req.body.id);
      if (!source)
        return next(new ErrorHandler("Source PO not found", 404));

      const last = await PurchaseOrder.findOne({}, { poNo: 1 }).sort({
        poNo: -1,
      });
      const nextPoNo = last ? (last.poNo || 1000) + 1 : 1001;

      const cloned = await PurchaseOrder.create({
        supplier: source.supplier,
        items: source.items.map((i) => ({
          rawMaterial: i.rawMaterial,
          price: i.price,
          quantity: i.quantity,
          receivedQuantity: 0, // always reset
        })),
        poNo: nextPoNo,
        status: "Open",
      });

      const populated = await PurchaseOrder.findById(cloned._id)
        .populate("supplier", "name phoneNumber gstin")
        .populate("items.rawMaterial", "name unit");

      res.status(201).json({ success: true, po: populated });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// POST /inward-stock
// Body: { poId, items: [{ rawMaterial, quantity, remarks? }] }
// Creates MaterialInward records + updates PO receivedQuantity + status
// ─────────────────────────────────────────────────────────────
router.post(
  "/inward-stock",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { poId, items } = req.body;

      if (!poId) return next(new ErrorHandler("PO ID is required", 400));
      if (!items || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));

      const po = await PurchaseOrder.findById(poId);
      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

      if (po.status === "Completed") {
        return next(
          new ErrorHandler(
            "This PO is already Completed. No further inward allowed.",
            400
          )
        );
      }

      // Build inward records + update receivedQuantity on PO items
      const inwardDocs = [];
      for (const inItem of items) {
        if (!inItem.quantity || inItem.quantity <= 0) continue;

        const poItem = po.items.find(
          (p) => p.rawMaterial.toString() === inItem.rawMaterial
        );

        if (!poItem) {
          return next(
            new ErrorHandler(
              `Material ${inItem.rawMaterial} not found in this PO`,
              400
            )
          );
        }

        poItem.receivedQuantity =
          (poItem.receivedQuantity || 0) + inItem.quantity;

        inwardDocs.push({
          rawMaterial: inItem.rawMaterial,
          purchaseOrder: poId,
          quantity: inItem.quantity,
          inwardDate: inItem.inwardDate || Date.now(),
          remarks: inItem.remarks || "",
        });
      }

      // Derive new status
      po.status = deriveStatus(po.items);
      await po.save();

      // Bulk create inward records
      const created = await MaterialInward.insertMany(inwardDocs);

      res.status(201).json({
        success: true,
        message: `Stock inward recorded. PO status: ${po.status}`,
        inwardRecords: created,
        poStatus: po.status,
      });
    } catch (error) {
      console.log(error.message);
      return next(new ErrorHandler(error.message, 400));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// GET /get-inward-history?poId=
// ─────────────────────────────────────────────────────────────
router.get(
  "/get-inward-history",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const records = await MaterialInward.find({
        purchaseOrder: req.query.poId,
      })
        .populate("rawMaterial", "name unit")
        .sort({ inwardDate: -1 });

      res.status(200).json({ success: true, records });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);



router.get(
    "/get-suppliers",
    catchAsyncErrors(async (req, res, next) => {
        try {
            console.log("Fetching suppliers with query:", req.query);
            const page = Number(req.query.page) || 1;
            const limit = Number(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            const keyword = req.query.search
                ? {
                    name: { $regex: req.query.search, $options: "i" },
                }
                : {};

            const suppliers = await Supplier.find(keyword)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit);

            const total = await Supplier.countDocuments(keyword);

            console.log("Total suppliers:", total);

            res.status(200).json({
                success: true,
                suppliers,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.get(
    "/get-supplier-detail",
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findById(req.query.id);

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            res.status(200).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.put(
    "/edit-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findByIdAndUpdate(
                req.body._id,
                req.body,
                { new: true }
            );

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            res.status(200).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);


router.delete(
    "/delete-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findById(req.query.id);

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            supplier.isActive = false;
            await supplier.save();

            res.status(200).json({
                success: true,
                message: "Supplier deleted successfully",
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);



module.exports = router;





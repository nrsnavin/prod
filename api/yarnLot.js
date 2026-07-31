"use strict";

// ══════════════════════════════════════════════════════════════
//  YARN LOTS
//
//  Dyed lots of a raw material, tracked as their own buckets so a
//  warping batch can be tied to the exact yarn it was warped from.
//  See models/YarnLot.js for why lot balances and RawMaterial.stock
//  are separate counters that are not expected to agree.
// ══════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const YarnLot = require("../models/YarnLot");
const RawMaterial = require("../models/RawMaterial");
const WarpingBatch = require("../models/WarpingBatch");
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { escapeRegex } = require("../utils/escapeRegex");
const { creditLot } = require("../services/yarnLotService");
const { isAdmin } = require("../middleware/auth");

const oid = (v) => mongoose.Types.ObjectId.isValid(v);

// ── GET /yarn-lots/list ───────────────────────────────────────
// Lots for the picker and the material's Lots tab.
//   ?material= restrict to one raw material
//   ?status=   open | exhausted | quarantined | closed | all  (default open)
//   ?issuable= "true" → only lots with something left to draw
//   ?search=   lot number or shade
router.get("/list", catchAsyncErrors(async (req, res, next) => {
  const { material, status = "open", search = "", issuable } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  // Capped: the picker asks for a page, but a stray ?limit=100000 from a
  // script would drag every lot in the business through one response.
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const filter = {};
  if (material) {
    if (!oid(material)) return next(new ErrorHandler("Invalid material id", 400));
    filter.rawMaterial = material;
  }
  if (status && status !== "all") filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(String(search).trim()), "i");
    filter.$or = [{ lotNo: rx }, { shade: rx }];
  }
  // The balance is a virtual, so it cannot be filtered on in the query.
  // $expr compares the two stored fields directly instead.
  if (String(issuable) === "true") {
    filter.$expr = { $gt: [{ $subtract: ["$receivedQty", "$consumedQty"] }, 0] };
  }

  const [lots, total] = await Promise.all([
    YarnLot.find(filter)
      .populate("rawMaterial", "name category")
      .populate("supplier", "name")
      .sort({ receivedDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    YarnLot.countDocuments(filter),
  ]);

  res.json({
    success: true,
    lots,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}));

// ── POST /yarn-lots/create ────────────────────────────────────
// Open a lot by hand. Inward normally does this automatically, but yarn
// that was already on the rack when lot tracking started has no inward
// row to hang off, and the floor still needs it in the picker.
router.post("/create", isAdmin("admin", "production", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const { rawMaterial, lotNo, quantity, shade, dyer, supplier, remarks, receivedDate } = req.body;

  if (!rawMaterial || !oid(rawMaterial)) {
    return next(new ErrorHandler("A valid rawMaterial is required", 400));
  }
  if (!String(lotNo || "").trim()) {
    return next(new ErrorHandler("lotNo is required", 400));
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return next(new ErrorHandler("quantity must be a positive number", 400));
  }
  if (supplier && !oid(supplier)) {
    return next(new ErrorHandler("Invalid supplier id", 400));
  }

  const material = await RawMaterial.findById(rawMaterial).select("name");
  if (!material) return next(new ErrorHandler("Raw material not found", 404));

  const lot = await creditLot({
    rawMaterial,
    lotNo,
    quantity: qty,
    shade,
    dyer,
    supplier,
    receivedDate: receivedDate ? new Date(receivedDate) : undefined,
  });

  if (remarks) {
    lot.remarks = String(remarks).trim();
    await lot.save();
  }

  res.status(201).json({ success: true, lot });
}));

// ── PATCH /yarn-lots/:id/status ───────────────────────────────
// Hold a lot back or release it. Quarantine is the one that matters:
// it is how a shade complaint stops the rest of a bad lot reaching the
// floor while everyone works out what to do with it.
router.patch("/:id/status", isAdmin("admin", "production"), catchAsyncErrors(async (req, res, next) => {
  if (!oid(req.params.id)) return next(new ErrorHandler("Invalid lot id", 400));

  const { status, remarks } = req.body;
  const allowed = ["open", "quarantined", "closed"];
  if (!allowed.includes(status)) {
    return next(new ErrorHandler(
      `status must be one of ${allowed.join(", ")}`, 400
    ));
  }

  const lot = await YarnLot.findById(req.params.id);
  if (!lot) return next(new ErrorHandler("Yarn lot not found", 404));

  // "exhausted" is bookkeeping, not a decision — it is set and cleared by
  // the quantity moves themselves, so re-opening an empty lot by hand
  // would just be undone by the next issue. Reflect the balance instead.
  lot.status = status === "open" && lot.balance <= 0 ? "exhausted" : status;
  if (remarks !== undefined) lot.remarks = String(remarks).trim();
  await lot.save();

  res.json({ success: true, lot });
}));

// ── GET /yarn-lots/:id/trace ──────────────────────────────────
// Where did this lot go? The question asked when a customer complains
// about a shade band, working forward from the lot number on the bag to
// every job — and so every customer — it reached.
router.get("/:id/trace", catchAsyncErrors(async (req, res, next) => {
  if (!oid(req.params.id)) return next(new ErrorHandler("Invalid lot id", 400));

  const lot = await YarnLot.findById(req.params.id)
    .populate("rawMaterial", "name category")
    .populate("supplier", "name");
  if (!lot) return next(new ErrorHandler("Yarn lot not found", 404));

  const batches = await WarpingBatch.find({ "allocations.yarnLot": lot._id })
    .populate({
      path: "job",
      select: "jobOrderNo status order",
      populate: { path: "order", select: "orderNo customer po", populate: { path: "customer", select: "name" } },
    })
    .sort({ createdAt: -1 })
    .lean();

  // A cancelled batch drew nothing in the end, but it stays in the trail:
  // "we nearly used it here" is a real answer when someone is working out
  // how far a bad lot spread.
  const trail = batches.map((b) => {
    const mine = (b.allocations || []).filter(
      (a) => String(a.yarnLot) === String(lot._id)
    );
    return {
      batchId: b._id,
      batchNo: b.batchNo,
      status: b.status,
      beamNos: b.beamNos || [],
      issuedDate: b.issuedDate,
      completedDate: b.completedDate,
      quantity: mine.reduce((s, a) => s + (Number(a.quantity) || 0), 0),
      job: b.job ? { _id: b.job._id, jobOrderNo: b.job.jobOrderNo, status: b.job.status } : null,
      order: b.job?.order
        ? {
            _id: b.job.order._id,
            orderNo: b.job.order.orderNo,
            po: b.job.order.po,
            customer: b.job.order.customer?.name || null,
          }
        : null,
    };
  });

  res.json({
    success: true,
    lot,
    batches: trail,
    // Drawn against the lot right now, across live batches. Excludes
    // cancelled ones, whose yarn was credited back.
    issuedQty: trail
      .filter((t) => t.status !== "cancelled")
      .reduce((s, t) => s + t.quantity, 0),
  });
}));

// ── GET /yarn-lots/:id ────────────────────────────────────────
// Declared after /:id/trace and /:id/status so those literal segments
// are not swallowed by this parameterised route.
router.get("/:id", catchAsyncErrors(async (req, res, next) => {
  if (!oid(req.params.id)) return next(new ErrorHandler("Invalid lot id", 400));
  const lot = await YarnLot.findById(req.params.id)
    .populate("rawMaterial", "name category unit")
    .populate("supplier", "name");
  if (!lot) return next(new ErrorHandler("Yarn lot not found", 404));
  res.json({ success: true, lot });
}));

module.exports = router;

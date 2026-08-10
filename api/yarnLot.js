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
const { creditLot, unplacedQuantity, appendLotMovement } = require("../services/yarnLotService");
const { appendStockMovement } = require("../utils/stockLedger");
const { costOf } = require("../utils/materialValuation");
const { describeLotMovements } = require("../utils/lotLedger");
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

  const material = await RawMaterial.findById(rawMaterial).select("name stock");
  if (!material) return next(new ErrorHandler("Raw material not found", 404));

  // A lot opened by hand assigns stock that already exists; it does not
  // conjure any. Without this the quantity was free text, so a material
  // holding 10 kg could carry a lot claiming 500 — and every screen
  // downstream would read that as fact.
  const unplaced = await unplacedQuantity(material);
  if (unplaced <= 0) {
    return next(new ErrorHandler(
      `All of ${material.name}'s stock (${material.stock}) is already assigned to lots. ` +
      `Receive or adjust stock in before opening another.`,
      400
    ));
  }
  if (qty > unplaced) {
    return next(new ErrorHandler(
      `Only ${unplaced} of ${material.name} is not yet assigned to a lot — ` +
      `cannot open a lot for ${qty}.`,
      400
    ));
  }

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

// ══════════════════════════════════════════════════════════════
//  POST /yarn-lots/:id/adjust   { delta, reason }
//
//  Correct one lot's balance — a recount, damage, spillage.
//
//  The lot and the material's aggregate stock move TOGETHER, inside one
//  transaction. Lot balances are a subdivision of stock, so moving one
//  without the other puts the two permanently out of step, and nothing
//  afterwards can say which of them is right.
//
//  This is deliberately NOT how a batch issue behaves: issuing draws a
//  lot and leaves RawMaterial.stock alone, because that stock was
//  already debited at order approval and debiting it again would count
//  the same yarn twice. An adjustment is different — it is a statement
//  that the physical quantity is not what the system thought, and that
//  is true of both figures at once. See models/YarnLot.js.
// ══════════════════════════════════════════════════════════════
router.post(
  "/:id/adjust",
  isAdmin("admin", "production", "accounts"),
  catchAsyncErrors(async (req, res, next) => {
    if (!oid(req.params.id)) return next(new ErrorHandler("Invalid lot id", 400));

    const delta = Number(req.body?.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return next(new ErrorHandler("delta must be a non-zero number", 400));
    }
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3) {
      // An adjustment has no document behind it. Without a reason the
      // ledger row is a number nobody can explain, which is the thing
      // this ledger exists to prevent.
      return next(new ErrorHandler("A reason (min 3 chars) is required", 400));
    }

    const session = await mongoose.startSession();
    try {
      let out = null;
      await session.withTransaction(async () => {
        const lot = await YarnLot.findById(req.params.id).session(session);
        if (!lot) throw new ErrorHandler("Yarn lot not found", 404);

        const balance = (lot.receivedQty || 0) - (lot.consumedQty || 0);
        if (delta < 0 && balance + delta < 0) {
          throw new ErrorHandler(
            `Lot ${lot.lotNo} holds only ${balance} — cannot take ${Math.abs(delta)} off it`,
            409
          );
        }

        // A shortfall is recorded as MORE consumed, a gain as MORE
        // received. Both keep receivedQty >= consumedQty and leave the
        // lot's own arithmetic intact, which zeroing one side would not.
        if (delta < 0) lot.consumedQty = (lot.consumedQty || 0) + Math.abs(delta);
        else lot.receivedQty = (lot.receivedQty || 0) + delta;

        const after = (lot.receivedQty || 0) - (lot.consumedQty || 0);
        // Follow the balance where it lands, both ways.
        if (after <= 0 && lot.status === "open") lot.status = "exhausted";
        if (after > 0 && lot.status === "exhausted") lot.status = "open";
        await lot.save({ session });

        await appendLotMovement(lot._id, {
          type: "ADJUST",
          quantity: delta,
          balance: after,
          reason,
          by: req.user?._id,
        }, session);

        // The aggregate moves with it.
        const material = await RawMaterial.findById(lot.rawMaterial).session(session);
        if (material) {
          const before = Number(material.stock) || 0;
          material.stock = Math.max(0, before + delta);
          // The aggregate floors at zero, so it can move by less than
          // the lot did — a lot correction of −40 against 25 on hand
          // moves 25. The row records what moved and, beside it, what
          // was asked for; recording the ask as though it happened left
          // a ledger whose balances did not follow from its quantities.
          const applied = material.stock - before;
          await material.save({ session });
          await appendStockMovement(material._id, {
            type: "STOCK_ADJUST",
            quantity: applied,
            requested: applied === delta ? undefined : delta,
            balance: material.stock,
            reason: `Lot ${lot.lotNo}: ${reason}`,
            unitCost: costOf(material),
          }, session);
        }

        out = {
          lotId: String(lot._id),
          lotNo: lot.lotNo,
          balance: after,
          status: lot.status,
          materialStock: material ? material.stock : null,
        };
      });
      res.json({ success: true, ...out });
    } finally {
      await session.endSession();
    }
  })
);

// ── GET /yarn-lots/:id ────────────────────────────────────────
// Declared after /:id/trace and /:id/status so those literal segments
// are not swallowed by this parameterised route.
router.get("/:id", catchAsyncErrors(async (req, res, next) => {
  if (!oid(req.params.id)) return next(new ErrorHandler("Invalid lot id", 400));
  const lot = await YarnLot.findById(req.params.id)
    // The lot's own ledger — select:false on the schema, and this detail
    // view is the one place that wants it.
    .select("+movements")
    .populate("rawMaterial", "name category unit")
    .populate("supplier", "name")
    .populate("movements.warpingBatch", "batchNo status")
    .populate("movements.by", "name");
  if (!lot) return next(new ErrorHandler("Yarn lot not found", 404));

  // Newest first, and said in words. A running total cannot be audited;
  // this is what explains the balance beside it.
  const movements = describeLotMovements(lot.movements, lot.balance);

  res.json({
    success: true,
    lot: { ...lot.toJSON(), movements },
  });
}));

module.exports = router;

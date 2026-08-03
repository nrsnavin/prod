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
const mongoose       = require("mongoose");
const router         = express.Router();

const Supplier       = require("../models/Supplier");
const PurchaseOrder  = require("../models/PurchaseOrder");
const MaterialInward = require("../models/MaterialInward.js");
const RawMaterial    = require("../models/RawMaterial");   // ← added for stock update

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { escapeRegex } = require("../utils/escapeRegex");
const { isAuthenticated } = require("../middleware/auth");
const { stampFingerprint, ACTION_CODES } = require("../utils/fingerprint");
const { nextNumber } = require("../utils/sequence");
const { claimKey, isDuplicateKeyError, isClaimed } = require("../utils/idempotency");
const { creditLot } = require("../services/yarnLotService");
const { appendStockMovement } = require("../utils/stockLedger");
const PdfTemplate = require("../models/PdfTemplate");
const { renderTemplatePdf } = require("../services/pdf/templateRenderer");
const { starterTemplate }   = require("../services/pdf/docTypes");
const { getPdfBranding }     = require("../services/documentSettings");
const { poToContext }        = require("../services/pdf/poContext");
const { assertVersion } = require("../utils/versioning");

// Race-free PO number: atomic counter, seeded once from the current max.
// (The old read-max-then-+1 could give two concurrent creates the same poNo.)
async function nextPoNumber() {
  return nextNumber("poNo", async () => {
    const last = await PurchaseOrder.findOne({}, { poNo: 1 }).sort({ poNo: -1 });
    return last?.poNo || 1000;
  });
}
const { requireReason } = require("../utils/auditReason");

// Every supplier / PO / material-inward route requires a logged-in
// user. Auth was previously commented out, leaving these endpoints
// reachable anonymously — including the inward-stock route that
// mutates RawMaterial.stock. isAdmin gating is deliberately not
// applied at the router level because the admin Flutter app's
// staff roles (accounts, purchasing) also reach these routes.
router.use(isAuthenticated);


// ─────────────────────────────────────────────────────────────────────────
// OVER-RECEIPT
//
// A supplier sending slightly more than ordered is normal — a full bag
// instead of a part one, a roll that weighed heavy. Refusing it outright
// only pushed the difference into a stock adjustment, which credits the
// same yarn while losing the link to the PO that brought it in.
//
// So a delivery may exceed the line's ordered quantity. Up to this
// fraction over, no explanation is asked for; past it, someone has to
// say why, and that reason is kept on the inward row.
// ─────────────────────────────────────────────────────────────────────────
const OVER_RECEIPT_TOLERANCE = 0.10;
const MIN_EXCESS_REASON = 5;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
    const { name, phoneNumber, email, address, gstin } = req.body || {};
    if (!name || !String(name).trim()) {
      return next(new ErrorHandler("name is required", 400));
    }
    if (![phoneNumber, email].some((v) => v && String(v).trim())) {
      return next(new ErrorHandler(
        "at least one of phoneNumber or email is required", 400));
    }
    try {
      const supplier = await Supplier.create({
        name:        String(name).trim(),
        phoneNumber: phoneNumber ? String(phoneNumber).trim() : undefined,
        email:       email       ? String(email).trim()       : undefined,
        address:     address     ? String(address).trim()     : undefined,
        gstin:       gstin       ? String(gstin).trim()       : undefined,
      });
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
      const { supplier, items, expectedDate, notes } = req.body;
      if (!supplier)
        return next(new ErrorHandler("Supplier is required", 400));
      if (!Array.isArray(items) || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));

      // Reject zero/negative line quantities so the PO doesn't carry
      // dead rows that confuse receipt + status derivation.
      for (const [idx, item] of items.entries()) {
        if (!item || !item.rawMaterial) {
          return next(new ErrorHandler(
            `items[${idx}].rawMaterial is required`, 400));
        }
        const q = Number(item.quantity);
        if (!Number.isFinite(q) || q <= 0) {
          return next(new ErrorHandler(
            `items[${idx}].quantity must be a positive number`, 400));
        }
      }

      const nextPoNo = await nextPoNumber();

      const parsedDate = expectedDate ? new Date(expectedDate) : undefined;
      const po = await PurchaseOrder.create({
        supplier,
        items: items.map((i) => ({
          rawMaterial:      i.rawMaterial,
          price:            i.price    || 0,
          quantity:         i.quantity || 0,
          receivedQuantity: 0,
        })),
        expectedDate: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : undefined,
        notes:        typeof notes === "string" ? notes.trim() : "",
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
// PUT /edit-po  — edit an Open PO (items / expectedDate / notes).
// Blocked once anything has been received. Requires an audit reason and
// stamps a PO_UPDATED fingerprint on the PO.
// ─────────────────────────────────────────────────────────────────────────
router.put(
  "/edit-po",
  catchAsyncErrors(async (req, res, next) => {
    const { poId, items, expectedDate, notes } = req.body;
    if (!poId) return next(new ErrorHandler("poId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const po = await PurchaseOrder.findById(poId);
    if (!po) return next(new ErrorHandler("Purchase order not found", 404));
    // Optimistic lock: two admins editing the same PO — the second save
    // gets a 409 instead of silently overwriting the first.
    assertVersion(po, req);
    if (po.status !== "Open") {
      return next(new ErrorHandler(`Only Open purchase orders can be edited (current: "${po.status}").`, 400));
    }
    if ((po.items || []).some((i) => (i.receivedQuantity || 0) > 0)) {
      return next(new ErrorHandler("Cannot edit a PO that already has receipts.", 400));
    }

    const before = {
      items: po.items.map((i) => ({ rawMaterial: i.rawMaterial?.toString(), quantity: i.quantity, price: i.price })),
      expectedDate: po.expectedDate,
      notes: po.notes,
    };

    if (Array.isArray(items) && items.length > 0) {
      for (const [idx, item] of items.entries()) {
        if (!item || !item.rawMaterial) return next(new ErrorHandler(`items[${idx}].rawMaterial is required`, 400));
        const q = Number(item.quantity);
        if (!Number.isFinite(q) || q <= 0) return next(new ErrorHandler(`items[${idx}].quantity must be a positive number`, 400));
      }
      po.items = items.map((i) => ({
        rawMaterial: i.rawMaterial, price: Number(i.price) || 0, quantity: Number(i.quantity) || 0, receivedQuantity: 0,
      }));
    }
    if (expectedDate !== undefined) {
      const d = expectedDate ? new Date(expectedDate) : undefined;
      po.expectedDate = d && !isNaN(d.getTime()) ? d : undefined;
    }
    if (notes !== undefined) po.notes = String(notes).trim();

    stampFingerprint(po, ACTION_CODES.PO_UPDATED, {
      req,
      meta: { auditReason, poNo: po.poNo, before, after: {
        items: po.items.map((i) => ({ rawMaterial: i.rawMaterial?.toString(), quantity: i.quantity, price: i.price })),
        expectedDate: po.expectedDate, notes: po.notes,
      } },
    });
    po.markModified("fingerprints");
    po.increment(); // bump __v so concurrent editors get a 409
    await po.save();

    const populated = await PurchaseOrder.findById(po._id)
      .populate("supplier", "name phoneNumber gstin")
      .populate("items.rawMaterial", "name unit");
    res.status(200).json({ success: true, message: "Purchase order updated", po: populated });
  })
);


// ─────────────────────────────────────────────────────────────────────────
// DELETE /delete-po  — soft-delete (status → Cancelled) an Open PO with no
// receipts. Requires an audit reason; stamps a PO_DELETED fingerprint.
// ─────────────────────────────────────────────────────────────────────────
router.delete(
  "/delete-po",
  catchAsyncErrors(async (req, res, next) => {
    const poId = req.query.poId || req.query.id;
    if (!poId) return next(new ErrorHandler("poId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

    const po = await PurchaseOrder.findById(poId);
    if (!po) return next(new ErrorHandler("Purchase order not found", 404));
    if (po.status === "Cancelled") return next(new ErrorHandler("PO is already cancelled", 400));
    if ((po.items || []).some((i) => (i.receivedQuantity || 0) > 0)) {
      return next(new ErrorHandler("Cannot delete a PO that already has receipts. Handle the received stock first.", 400));
    }

    const previousStatus = po.status;
    po.status = "Cancelled";
    stampFingerprint(po, ACTION_CODES.PO_DELETED, {
      req,
      meta: { auditReason, poNo: po.poNo, previousStatus },
    });
    po.markModified("fingerprints");
    await po.save();

    res.status(200).json({ success: true, message: "Purchase order deleted", id: po._id });
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
      else                      filter.status   = { $ne: "Cancelled" }; // hide soft-deleted by default
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
        .populate("items.rawMaterial", "name unit")
        .lean();

      if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

      const inwardHistory = await MaterialInward.find({ purchaseOrder: po._id })
        .populate("rawMaterial", "name unit")
        .sort({ inwardDate: -1 });

      // ── What is received, and what is still to come ────────────────
      // Stated here rather than left to the client to subtract.
      //
      // This route used to hand back the raw document, whose lines carry
      // `receivedQuantity`. The goods-received screen read `received` —
      // the name the pending-PO ageing report maps — so it was always
      // undefined, `?? 0` made it nothing received, and the pending
      // column printed the full order quantity no matter how much had
      // arrived. No error, no blank: a confident wrong number saying
      // nothing had come in about goods sitting in the store.
      //
      // Both names are emitted so neither client breaks, and `pending`
      // is computed once, here, so there is no third place for the same
      // subtraction to be written differently again.
      po.items = (po.items || []).map((it) => {
        const ordered  = Number(it.quantity) || 0;
        const received = Number(it.receivedQuantity) || 0;
        return {
          ...it,
          received,
          // Floored at zero: over-delivery within tolerance is allowed,
          // and "-8 pending" is not a quantity anyone can act on.
          pending: Math.max(0, ordered - received),
        };
      });

      res.status(200).json({ success: true, po, inwardHistory });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────
// GET /po/:id/pdf
//
// Renders the purchase order as a PDF using the visual template designed in
// Settings → PDF Designer. Uses the admin's saved 'purchase-order' template
// when enabled, otherwise the built-in starter layout.
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/po/:id/pdf",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)) {
      return next(new ErrorHandler("Invalid purchase order id", 400));
    }

    const po = await PurchaseOrder.findById(id)
      .populate("supplier", "name phoneNumber gstin email address contactPerson")
      .populate("items.rawMaterial", "name unit")
      // What the PO was raised for, when it came out of a job's material
      // shortfall. Printed on the supplier's copy so the purchase stays
      // answerable long after the screen that created it is closed.
      .populate("forJob", "jobOrderNo")
      .populate("forOrder", "orderNo")
      .lean();
    if (!po) return next(new ErrorHandler("Purchase Order not found", 404));

    const [branding, saved] = await Promise.all([
      getPdfBranding(),
      PdfTemplate.findOne({ docType: "purchase-order" }).lean(),
    ]);
    const template = saved && saved.enabled ? saved : starterTemplate("purchase-order");

    const context = poToContext(po, branding);
    const pdf = await renderTemplatePdf(template, context);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="PO-${po.poNo != null ? po.poNo : id}.pdf"`
    );
    return res.send(pdf);
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

      const nextPoNo = await nextPoNumber();

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
// Body: { poId, items: [{ rawMaterial, quantity, inwardDate?, remarks?,
//                         lotNo?, shade? }] }
//
// A row carrying a lot number also credits a YarnLot bucket, so the yarn
// can be issued to a warping batch by lot later on.
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
      // excessReason at the top level covers the whole submit; a row may
      // override it with its own.
      const { poId, items, requestId, excessReason } = req.body;

      // Idempotency: a retried inward (flaky network, double-tap) must
      // not credit stock twice. Fast path here; the claim inside the
      // transaction below is the guarantee under race.
      if (requestId && (await isClaimed(requestId))) {
        return res.status(200).json({
          success: true, duplicate: true,
          message: "Already recorded (duplicate submit ignored)",
        });
      }

      if (!poId)
        return next(new ErrorHandler("PO ID is required", 400));
      if (!Array.isArray(items) || items.length === 0)
        return next(new ErrorHandler("At least one item is required", 400));
      if (items.length > 500)
        return next(new ErrorHandler("items exceeds the 500-item limit per request", 400));

      // ── Load PO ────────────────────────────────────────────────────
      // `let`: the transaction below re-reads this inside its session, so
      // a retried attempt works from committed state rather than from a
      // copy something else may already have changed.
      let po = await PurchaseOrder.findById(poId);
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
      // Excess per line, carried into the write pass so the arithmetic
      // is done once and the inward row records what was actually over.
      const excessByMaterial = new Map();

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

        const ordered  = Number(poItem.quantity) || 0;
        const already  = Number(poItem.receivedQuantity) || 0;
        const totalAfter = already + Number(inItem.quantity);
        // Measured against what was ORDERED, not what is still pending.
        // Against pending, a PO for 100 already 90 received would call a
        // 12-unit delivery a 20% overshoot when it is 2% over the order —
        // and the tolerance is about the delivery against the order.
        const excess = Math.max(0, totalAfter - ordered);
        const allowanceFree = ordered * OVER_RECEIPT_TOLERANCE;

        if (excess > 0) {
          const reason = String(inItem.excessReason || excessReason || "").trim();
          if (excess > allowanceFree && reason.length < MIN_EXCESS_REASON) {
            return next(new ErrorHandler(
              `Receiving ${totalAfter} against ${ordered} ordered is ` +
              `${excess} over — past the ` +
              `${Math.round(OVER_RECEIPT_TOLERANCE * 100)}% tolerance ` +
              `(${round2(allowanceFree)}). Give a reason of at least ` +
              `${MIN_EXCESS_REASON} characters to receive it.`,
              400
            ));
          }
          excessByMaterial.set(String(inItem.rawMaterial), {
            excess: round2(excess),
            // Inside the tolerance a reason is optional, but keep one if
            // it was offered — it costs nothing and helps later.
            reason: excess > allowanceFree ? reason : reason || "",
          });
        }
      }

      // ── WRITE PASS ────────────────────────────────────────────────
      const inwardDocs   = [];
      const stockCredits = [];  // applied inside the transaction below

      for (const inItem of activeItems) {
        const qty    = Number(inItem.quantity);

        // 1. The PO's received quantity is applied inside the
        //    transaction, on a document re-read there. It used to be
        //    incremented here, on the copy loaded before the session
        //    opened — and withTransaction RETRIES its callback on a
        //    transient error or an unknown commit result. Mongoose had
        //    already cleared the dirty flags on the first attempt, so
        //    the retry saved nothing: the stock and the audit rows
        //    landed but the receipt never reached the PO, which then
        //    stayed Open, kept reporting the delivered quantity as
        //    still on order, and let it be bought again.

        // 2. Credit the stock. Done per item with the post-increment
        //    document returned, rather than in one bulkWrite, because the
        //    movement row needs the resulting balance — pushed alongside
        //    the $inc it had no way to know it and left the Balance
        //    column empty on every PO receipt.
        //
        //    The $inc is still atomic, so the balance recorded here is
        //    the real one even if another receipt lands at the same time.
        stockCredits.push({ rawMaterial: inItem.rawMaterial, qty, inItem });

        // 3. Prepare MaterialInward document
        const over = excessByMaterial.get(String(inItem.rawMaterial));
        inwardDocs.push({
          rawMaterial:   inItem.rawMaterial,
          purchaseOrder: poId,
          quantity:      qty,
          inwardDate:    inItem.inwardDate
                           ? new Date(inItem.inwardDate)
                           : new Date(),
          remarks:       inItem.remarks ? inItem.remarks.trim() : "",
          lotNo:         inItem.lotNo ? String(inItem.lotNo).trim() : "",
          excessQuantity: over?.excess || 0,
          excessReason:   over?.reason || "",
        });
      }

      // All three writes (PO, RawMaterial stock, MaterialInward audit
      // rows) must land or roll back together. Without a transaction
      // a failing insertMany used to leave stock credited but no audit
      // trail, or vice versa.
      const session = await mongoose.startSession();
      let created;
      try {
        await session.withTransaction(async () => {
          // Claim the idempotency key first: a concurrent replay's
          // claim throws E11000 and aborts its transaction before any
          // stock moves.
          if (requestId) await claimKey(session, requestId, "inward-stock");

          // Re-read inside the session so every attempt starts from the
          // committed state and applies the increments itself. Nothing
          // about this callback may depend on a mutation made before
          // it — a retry replays it from the top.
          po = await PurchaseOrder.findById(poId).session(session);
          if (!po) throw new ErrorHandler("Purchase Order not found", 404);

          for (const inItem of activeItems) {
            const poItem = po.items.find(
              (p) => p.rawMaterial.toString() === inItem.rawMaterial.toString()
            );
            if (!poItem) {
              throw new ErrorHandler(
                `Material ${inItem.rawMaterial} is not part of PO #${po.poNo}`, 400
              );
            }
            poItem.receivedQuantity =
              (Number(poItem.receivedQuantity) || 0) + Number(inItem.quantity);
          }

          po.status = deriveStatus(po.items);
          // Audit: who received what against this PO, when.
          stampFingerprint(po, ACTION_CODES.PO_STOCK_INWARD, {
            req,
            meta: {
              poNo: po.poNo,
              items: activeItems.map((i) => {
                const over = excessByMaterial.get(String(i.rawMaterial));
                return {
                  rawMaterial: String(i.rawMaterial),
                  quantity: Number(i.quantity),
                  lotNo: i.lotNo ? String(i.lotNo) : undefined,
                  // An over-receipt belongs in the audit trail, not just
                  // on the inward row — it is the kind of thing someone
                  // reviews the PO to find.
                  excess: over?.excess || undefined,
                  excessReason: over?.reason || undefined,
                };
              }),
              newStatus: deriveStatus(po.items),
            },
          });
          po.markModified("fingerprints");
          await po.save({ session });
          for (const credit of stockCredits) {
            const updated = await RawMaterial.findOneAndUpdate(
              { _id: credit.rawMaterial },
              { $inc: { stock: credit.qty } },
              { new: true, session }
            );
            await appendStockMovement(credit.rawMaterial, {
              date: credit.inItem.inwardDate
                ? new Date(credit.inItem.inwardDate)
                : new Date(),
              type:     "PO_INWARD",
              quantity: credit.qty,
              balance:  updated ? updated.stock : undefined,
              // Not `order` — that field is ref:"Order", and handing it a
              // PurchaseOrder id resolved to nothing, which is why this
              // used to record no reference at all and every goods
              // receipt on the ledger was unexplained. `purchaseOrder`
              // is the field that fits, with the number snapshotted
              // beside it so the row survives the PO being deleted.
              purchaseOrder: po._id,
              refNo:         po.poNo != null ? String(po.poNo) : "",
            }, session);
          }
          created = await MaterialInward.insertMany(inwardDocs, { session });

          // Credit the dye lots, so this yarn can later be issued to a
          // warping batch by lot. Inside the transaction with everything
          // else: unlike the standalone /materials/material-inward route,
          // this path can roll the whole receipt back, so there is no
          // reason to settle for best-effort here.
          for (let i = 0; i < activeItems.length; i++) {
            const item = activeItems[i];
            if (!item.lotNo) continue;
            await creditLot({
              rawMaterial:  item.rawMaterial,
              lotNo:        item.lotNo,
              quantity:     Number(item.quantity),
              shade:        item.shade,
              supplier:     po.supplier,
              inward:       created[i]?._id,
              receivedDate: inwardDocs[i].inwardDate,
            }, session);
          }
        });
      } catch (err) {
        if (isDuplicateKeyError(err) && requestId) {
          return res.status(200).json({
            success: true, duplicate: true,
            message: "Already recorded (duplicate submit ignored)",
          });
        }
        throw err;
      } finally {
        await session.endSession();
      }

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
        ? { name: { $regex: escapeRegex(req.query.search), $options: "i" } }
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
// Whitelist the client-settable fields; spreading the raw body let a
// caller inject arbitrary/internal fields.
const SUPPLIER_FIELDS = [
  "name", "gstin", "phoneNumber", "email", "address", "contactPerson", "isActive",
];
router.put(
  "/edit-supplier",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const update = {};
      for (const f of SUPPLIER_FIELDS) {
        if (req.body[f] !== undefined) update[f] = req.body[f];
      }
      const supplier = await Supplier.findByIdAndUpdate(
        req.body._id, update, { new: true, runValidators: true }
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


// ─────────────────────────────────────────────────────────────────────────
// PO RECEIPT AGING REPORT
// GET /supplier/po-receipt-aging
//
// Every Open/Partial PO with outstanding (ordered − received) line
// quantities, bucketed by age since the PO was raised:
//   fresh: 0–7d · watch: 8–30d · late: 31–60d · critical: 60d+
//
// One row per PO; per-item pending detail nested so the admin app
// can expand. Sorted oldest-first (most overdue at the top).
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/po-receipt-aging",
  catchAsyncErrors(async (req, res, next) => {
    const pos = await PurchaseOrder.find({
      status: { $in: ["Open", "Partial"] },
    })
      .populate("supplier", "name phoneNumber")
      .populate("items.rawMaterial", "name category")
      .sort({ createdAt: 1 })
      .lean();

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const bucketOf = (days) =>
      days <= 7 ? "fresh" : days <= 30 ? "watch" : days <= 60 ? "late" : "critical";

    const rows = [];
    for (const po of pos) {
      const pendingItems = (po.items || [])
        .map((i) => ({
          rawMaterialId:   i.rawMaterial?._id ?? i.rawMaterial,
          rawMaterialName: i.rawMaterial?.name ?? "—",
          ordered:         Number(i.quantity) || 0,
          received:        Number(i.receivedQuantity) || 0,
          pending: Math.max(
            0,
            (Number(i.quantity) || 0) - (Number(i.receivedQuantity) || 0)
          ),
        }))
        .filter((i) => i.pending > 0);

      if (pendingItems.length === 0) continue;

      const ageDays = Math.floor((now - new Date(po.createdAt).getTime()) / DAY);
      rows.push({
        poId:          po._id,
        poNo:          po.poNo,
        supplierName:  po.supplier?.name ?? "—",
        supplierPhone: po.supplier?.phoneNumber ?? "",
        status:        po.status,
        createdAt:     po.createdAt,
        ageDays,
        bucket:        bucketOf(ageDays),
        totalPending:  pendingItems.reduce((s, i) => s + i.pending, 0),
        pendingItems,
      });
    }

    const summary = { fresh: 0, watch: 0, late: 0, critical: 0 };
    for (const r of rows) summary[r.bucket]++;

    res.json({ success: true, count: rows.length, summary, data: rows });
  })
);


module.exports = router;
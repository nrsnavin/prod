"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/MaterialInward");
const MaterialOutward   = require("../models/MaterialOut.cjs");
const Supplier          = require("../models/Supplier");
const Order             = require("../models/Order");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { escapeRegex } = require("../utils/escapeRegex");
const { appendStockMovement, normaliseMovements } = require("../utils/stockLedger");
const YarnLot           = require("../models/YarnLot");
const { creditLot, drawFromLot, unplacedQuantity } = require("../services/yarnLotService");
const {
  maybeFireCriticalStockout,
  maybeFirePriceChangeAlert,
  maybeFirePoReceivedForCritical,
} = require("../utils/inventoryAlerts");
const { enqueue } = require("../utils/outbox");

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
    if (search)              filter.name = { $regex: escapeRegex(search), $options: "i" };
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
      // stockMovements is select:false on the schema — this detail view is
      // the one place that wants it, and it trims to the newest 50 below.
      .select("+stockMovements")
      .populate("supplier", "name phone email")
      .populate("stockMovements.order", "orderNo")
      // The receipt's cause. `order` is ref:"Order" and could never hold
      // it — which is why every goods receipt on this ledger used to be
      // unexplained.
      .populate("stockMovements.purchaseOrder", "poNo status")
      .lean();

    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    // Sort stockMovements newest-first, keep last 50, then normalise.
    //
    // Normalising is what makes the ledger readable for rows already in
    // the database: order approvals were written with a positive quantity
    // even though they debit stock, and PO receipts recorded no balance
    // at all. Both are fixed at the writers now, but years of history
    // would still read wrongly without this. See utils/stockLedger.js.
    material.stockMovements = normaliseMovements(
      (material.stockMovements || [])
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 50),
      material.stock
    );

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

    // Dye lots, open ones first so the rack's usable stock reads at the
    // top. Virtuals are needed for `balance`, so this is not .lean().
    const lots = await YarnLot.find({ rawMaterial: id })
      .sort({ status: 1, receivedDate: -1 })
      .limit(100);

    // Stock that exists but sits in no lot — what a hand-opened lot may
    // draw on, and the number the Lots panel reports as unplaced.
    const unplacedQty = await unplacedQuantity(material);

    // ── Receipts recorded before the ledger had a PO field ──────────
    // Those rows carry no reference at all, so a customer's entire
    // existing history reads as unexplained goods receipts. Fixing only
    // new writes would leave the ledger exactly as reported.
    //
    // MaterialInward is the authoritative record of the same events and
    // does carry the PO, so the row can be matched back to it. The match
    // is on the same DAY and the same quantity — not the same instant.
    // The two are written milliseconds apart by different code (the
    // movement takes `new Date()` in the route, the inward takes the
    // model's Date.now default), so an exact timestamp match finds
    // nothing. That was worth checking rather than assuming.
    //
    // Only when exactly one inward matches. Two receipts of the same
    // quantity on the same day are genuinely indistinguishable, and
    // naming one of them would be inventing a fact to fill a column.
    const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    for (const mv of material.stockMovements) {
      if (mv.type !== "PO_INWARD" || mv.reference) continue;
      const sameEvent = inwards.filter(
        (iw) =>
          Number(iw.quantity) === Math.abs(Number(mv.quantity)) &&
          iw.inwardDate &&
          dayOf(iw.inwardDate) === dayOf(mv.date)
      );
      if (sameEvent.length !== 1) continue;
      const po = sameEvent[0].purchaseOrder;
      if (!po?.poNo) continue;
      mv.reference = `PO #${po.poNo}`;
      mv.referenceKind = "purchaseOrder";
      mv.referenceId = String(po._id);
      // Said plainly: matched from the inward history, not recorded on
      // the row at the time. A reconstruction and a record are not the
      // same claim, and the UI marks it as such.
      mv.referenceDerived = true;
    }

    res.status(200).json({
      success: true,
      material: { ...material, inwards, outwards, lots, unplacedQty },
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
    const { _id } = req.body;
    if (!_id) return next(new ErrorHandler("Material ID required", 400));

    // Whitelist the fields a client may set. Spreading the raw body
    // let a caller overwrite the audit ledgers (stockMovements,
    // priceHistory) or totalConsumption wholesale — build an explicit
    // update instead. The append-only priceHistory is managed below.
    const ALLOWED = ["name", "category", "supplier", "price", "minStock", "stock"];
    const update = {};
    for (const f of ALLOWED) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }
    const priceReason = req.body.priceReason;

    const existing = await RawMaterial.findById(_id);
    if (!existing) return next(new ErrorHandler("Raw material not found", 404));

    // Snapshot for the inventory-alert fire-and-forget below.
    const _alertSnap = {
      oldStock:  Number(existing.stock) || 0,
      oldPrice:  Number(existing.price) || 0,
      reason:    String(req.body.reason || priceReason || "Manual edit").trim(),
    };

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
          reason:   priceReason?.trim() || "Manual edit",
        },
      };
    }

    const material = await RawMaterial.findByIdAndUpdate(_id, update, {
      new: true, runValidators: true,
    });

    res.status(200).json({ success: true, material });

    // Fire-and-forget alerts after the response — never blocks the
    // user-facing PUT.
    (async () => {
      const newPrice = Number(material.price);
      const newStock = Number(material.stock);
      if (newPrice !== _alertSnap.oldPrice) {
        await maybeFirePriceChangeAlert({
          material,
          oldPrice: _alertSnap.oldPrice,
          newPrice,
          reason:   _alertSnap.reason,
        });
      }
      if (newStock !== _alertSnap.oldStock) {
        // Durable path: the dispatcher re-checks the skip rules and
        // retries on WhatsApp hiccups (fire-and-forget lost the alert
        // on any crash). No session — the update above was atomic.
        await enqueue(null, "inventory.stockoutCheck", {
          materialId: material._id.toString(),
          oldStock:   _alertSnap.oldStock,
          newStock,
          reason:     `Manual edit: ${_alertSnap.reason}`,
        });
      }
    })();
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
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

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

    const _stockBefore = Number(material.stock) || 0;
    material.stock += qtyNum;
    await material.save();
    await appendStockMovement(material._id, {
      type:     "PO_INWARD",
      // Which purchase order these goods came in against. Without it the
      // ledger row says only that stock went up.
      purchaseOrder: po._id,
      refNo:         po.poNo != null ? String(po.poNo) : "",
      quantity: qtyNum,
      balance:  material.stock,
    });

    const lotNo = req.body.lotNo ? String(req.body.lotNo).trim() : "";

    const inward = await MaterialInward.create({
      rawMaterial:   rawMaterialId,
      purchaseOrder: purchaseOrderId,
      quantity:      Number(quantity),
      inwardDate:    new Date(),
      remarks:       remarks || "",
      lotNo,
    });

    // Credit the dye lot, so the yarn can be issued to a warping batch
    // by lot later. Only when a lot number was given — undyed or
    // untracked material simply has no bucket.
    //
    // Deliberately not fatal. Stock has already been credited by the
    // time we get here and this route is not transactional, so throwing
    // would leave the operator retrying an inward that partly happened.
    // The lot number is on the MaterialInward row either way, which is
    // the durable record — the bucket can be rebuilt from it.
    let lot = null;
    let lotError = null;
    if (lotNo) {
      try {
        lot = await creditLot({
          rawMaterial:  rawMaterialId,
          lotNo,
          quantity:     qtyNum,
          shade:        req.body.shade,
          dyer:         req.body.dyer,
          supplier:     material.supplier,
          inward:       inward._id,
          receivedDate: inward.inwardDate,
        });
      } catch (err) {
        lotError = err.message;
        console.warn(`Lot credit failed for inward ${inward._id}:`, err.message);
      }
    }

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

    res.status(201).json({ success: true, inward, lot, lotError });

    (async () => {
      let supplierName = null;
      try {
        const populated = await po.populate({ path: "supplier", select: "name" });
        supplierName = populated?.supplier?.name || null;
      } catch { /* supplier name is flavour */ }
      await maybeFirePoReceivedForCritical({
        material,
        stockBefore: _stockBefore,
        stockAfter:  Number(material.stock),
        quantity:    qtyNum,
        supplierName,
      });
    })();
  })
);

// ══════════════════════════════════════════════════════════════
//  9.  BULK STOCK ADJUSTMENT  ← NEW
//      POST /materials/bulk-adjust-stock
//
//  Body:
//  {
//    adjustments: [
//      { _id: "...", adjustment: 50,  reason: "Physical count",
//        lotNo: "D-4471", shade: "Ecru" },   ← credits that dye lot
//      { _id: "...", adjustment: -10, reason: "Damaged",
//        yarnLot: "<lot id>" },              ← draws that dye lot down
//      { _id: "...", adjustment: 0  }   ← skipped automatically
//    ],
//    globalReason: "Monthly stock audit"   ← fallback reason
//  }
//
//  The lot fields are optional. Given, the lot ledger moves with the
//  aggregate inside the same transaction; omitted, only the aggregate
//  moves and the lot balances are left as they were.
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

    if (adjustments.length > 500) {
      return next(new ErrorHandler("adjustments exceeds the 500-item limit per request", 400));
    }

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

    // One SHORT transaction per item — the stock write and its ledger
    // row land or roll back together, and concurrent adjusts of the
    // same material become write conflicts (retried by withTransaction)
    // instead of silent lost updates. Per-item scope preserves this
    // route's partial-success contract: one bad row doesn't void the
    // rest of the batch. Sequential on purpose — parallel ops can't
    // share a Mongo session.
    const session = await mongoose.startSession();
    try {
      for (const item of toProcess) {
        if (!mongoose.Types.ObjectId.isValid(item._id)) {
          errors.push({ id: item._id, error: "Invalid id" });
          continue;
        }
        try {
          let row = null; // collected inside, pushed after commit —
                          // withTransaction may retry the callback on
                          // write conflict, so no side-effects inside.
          await session.withTransaction(async () => {
            // Read INSIDE the transaction so the delta applies to the
            // current stock, not a snapshot from before the batch.
            const material = await RawMaterial.findById(item._id).session(session);
            if (!material) throw new Error("Not found");

            const oldStock = material.stock;
            const newStock = Math.max(0, oldStock + item.adjustment);
            material.stock = newStock;

            await material.save({ session });
            // Running balance log
            const reason = item.reason?.trim() || globalReason;

            await appendStockMovement(material._id, {
              type:     "STOCK_ADJUST",
              // An adjustment has no document behind it — the reason the
              // person typed IS the explanation, and it was being
              // computed on the next line and then thrown away.
              reason,
              quantity: item.adjustment,
              balance:  newStock,
            }, session);

            // ── The dye lot, when the adjustment names one ────────────
            // A manual adjustment used to bypass lot tracking entirely,
            // so every count correction pushed the lot ledger further
            // out of step with the aggregate it is supposed to break
            // down. Both directions are handled inside this transaction,
            // so the lot move and the stock write cannot disagree.
            //
            // Still optional: untracked or undyed material has no lot to
            // name, and an adjustment for stock nobody can place should
            // not be blocked on inventing one.
            const lotNo = item.lotNo ? String(item.lotNo).trim() : "";
            let lotRef = null;
            let lotLabel = lotNo;

            if (item.adjustment > 0) {
              if (lotNo) {
                const lot = await creditLot({
                  rawMaterial: material._id,
                  lotNo,
                  quantity:    item.adjustment,
                  shade:       item.shade,
                  supplier:    material.supplier,
                }, session);
                lotRef = lot?._id || null;
              }
              await MaterialInward.create([{
                rawMaterial:   material._id,
                purchaseOrder: item.purchaseOrderId || undefined,
                quantity:      item.adjustment,
                inwardDate:    new Date(),
                remarks:       `Stock adjustment: ${reason}`,
                lotNo,
              }], { session });
            } else {
              // Removing stock draws the lot down. drawFromLot refuses
              // to overdraw, so a write-off larger than the lot holds
              // fails the item rather than driving the lot negative.
              if (item.yarnLot) {
                if (!mongoose.Types.ObjectId.isValid(item.yarnLot)) {
                  throw new Error("Invalid yarn lot id");
                }
                const lot = await drawFromLot(
                  item.yarnLot, Math.abs(item.adjustment), session
                );
                lotRef   = lot._id;
                lotLabel = lot.lotNo;
              }
              await MaterialOutward.create([{
                rawMaterial: material._id,
                quantity:    Math.abs(item.adjustment),
                type:        "STOCK_ADJUST",
                outwardDate: new Date(),
                unitPrice:   material.price || 0,
                remarks:     `Stock adjustment: ${reason}`,
                yarnLot:     lotRef || undefined,
                lotNo:       lotLabel,
              }], { session });
            }

            // Outbox: the stockout alert commits WITH the adjustment —
            // no fire-and-forget; the dispatcher re-checks the skip
            // rules (min-stock floor, open PO) and delivers with retry.
            if (item.adjustment < 0) {
              await enqueue(session, "inventory.stockoutCheck", {
                materialId: material._id.toString(),
                oldStock, newStock,
                reason: `Stock adjustment: ${item.reason?.trim() || globalReason}`,
              });
            }

            row = {
              id:         material._id,
              name:       material.name,
              category:   material.category,
              oldStock,
              newStock,
              adjustment: item.adjustment,
              lotNo:      lotLabel || null,
            };
          });
          if (row) updated.push(row);
        } catch (err) {
          errors.push({ id: item._id, error: err.message });
        }
      }
    } finally {
      await session.endSession();
    }

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
//  GET /materials/replenishment-forecast?horizonDays=14&lookbackDays=30
//
//  Forecast-driven replenishment. Combines:
//    • on-hand stock
//    • committed demand — Open orders' rawMaterialRequired (deducts on
//      approval), i.e. near-term consumption already in the pipeline
//    • a run-rate from historical ORDER_APPROVAL outward movements
//  …to project each material's stock over the horizon and flag those
//  that dip below their safety floor. Each flag carries a suggestedQty
//  and its default supplier, grouped by supplier so the admin can draft
//  one PO per vendor. Deterministic; an optional Claude summary explains
//  the "why now". Nothing is ordered automatically.
// ══════════════════════════════════════════════════════════════
router.get(
  "/replenishment-forecast",
  catchAsyncErrors(async (req, res) => {
    const horizonDays  = Math.min(Math.max(Number(req.query.horizonDays)  || 14, 1), 120);
    const lookbackDays = Math.min(Math.max(Number(req.query.lookbackDays) || 30, 7), 180);
    const now   = new Date();
    const since = new Date(now.getTime() - lookbackDays * 86_400_000);

    const [materials, consumptionAgg, openOrders] = await Promise.all([
      RawMaterial.find({}).select("-stockMovements").populate("supplier", "name").lean(),
      MaterialOutward.aggregate([
        { $match: { type: "ORDER_APPROVAL", reversed: { $ne: true }, createdAt: { $gte: since } } },
        { $group: { _id: "$rawMaterial", used: { $sum: "$quantity" } } },
      ]),
      Order.find({ status: "Open" }).select("rawMaterialRequired").lean(),
    ]);

    // Run-rate per material (units/day) over the lookback window.
    const usedById = new Map(consumptionAgg.map((r) => [String(r._id), r.used]));
    // Committed demand from the Open-order pipeline.
    const committedById = new Map();
    for (const o of openOrders) {
      for (const rm of o.rawMaterialRequired || []) {
        const id = String(rm.rawMaterial);
        committedById.set(id, (committedById.get(id) || 0) + (Number(rm.quantity) || 0));
      }
    }

    const flagged = [];
    let skippedNoSupplier = 0;

    for (const m of materials) {
      const id        = String(m._id);
      const onHand    = Number(m.stock) || 0;
      const minStock  = Number(m.minStock) || 0;
      const runRate   = (usedById.get(id) || 0) / lookbackDays;                 // units/day
      const committed = committedById.get(id) || 0;
      const projConsumption = committed + runRate * horizonDays;
      const projStock = onHand - projConsumption;

      // Only surface materials that dip to/below their safety floor within
      // the horizon (or have nonzero demand and no floor set).
      const willBreach = projStock < Math.max(minStock, 0) && projConsumption > 0;
      if (!willBreach) continue;

      if (!m.supplier || !m.supplier._id) { skippedNoSupplier += 1; continue; }

      // Days until on-hand (net of committed) runs out at the run-rate.
      const daysToStockout = runRate > 0 ? Math.max(0, (onHand - committed) / runRate) : null;
      const stockoutDate = daysToStockout != null && daysToStockout <= 365
        ? new Date(now.getTime() + daysToStockout * 86_400_000) : null;

      // Refill to cover projected consumption + the safety floor.
      const suggestedQty = Math.ceil(Math.max(0, projConsumption + minStock - onHand));
      if (suggestedQty <= 0) continue;

      flagged.push({
        _id: id, name: m.name, category: m.category, unit: m.unit || "",
        price: Number(m.price) || 0,
        onHand, minStock,
        runRatePerDay: Math.round(runRate * 100) / 100,
        committedDemand: Math.round(committed),
        projectedConsumption: Math.round(projConsumption),
        projectedStock: Math.round(projStock),
        daysToStockout: daysToStockout != null ? Math.round(daysToStockout) : null,
        projectedStockoutDate: stockoutDate ? stockoutDate.toISOString().slice(0, 10) : null,
        suggestedQty,
        estimatedCost: Math.round(suggestedQty * (Number(m.price) || 0)),
        severity: projStock < 0 ? "critical" : "warn",
        supplier: { _id: String(m.supplier._id), name: m.supplier.name },
      });
    }

    // Worst first: stockout soonest, then biggest shortfall.
    flagged.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return (a.daysToStockout ?? 1e9) - (b.daysToStockout ?? 1e9);
    });

    // Group by supplier so the UI can draft one PO per vendor.
    const bySupplierMap = new Map();
    for (const f of flagged) {
      const key = f.supplier._id;
      if (!bySupplierMap.has(key)) bySupplierMap.set(key, { supplier: f.supplier, lines: [], estimatedCost: 0 });
      const g = bySupplierMap.get(key);
      g.lines.push(f);
      g.estimatedCost += f.estimatedCost;
    }
    const bySupplier = [...bySupplierMap.values()];

    const totals = {
      flagged: flagged.length,
      critical: flagged.filter((f) => f.severity === "critical").length,
      suppliers: bySupplier.length,
      estimatedCost: flagged.reduce((s, f) => s + f.estimatedCost, 0),
    };

    // Optional Claude "why now" narrative.
    let aiSummary = null, aiGenerated = false;
    const claude = anthropic();
    if (claude && flagged.length > 0) {
      try {
        const facts = flagged.slice(0, 8).map((f) =>
          `${f.name}: on-hand ${f.onHand}, run-rate ${f.runRatePerDay}/day, committed ${f.committedDemand}, ` +
          `projected ${f.projectedStock} by day ${horizonDays}${f.projectedStockoutDate ? `, stockout ~${f.projectedStockoutDate}` : ""} → order ${f.suggestedQty}`
        ).join("\n");
        const msg = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 350,
          system:
            "You are a procurement planner for an elastic (narrow-fabric) plant. Given a raw-material " +
            "replenishment forecast, write 2-3 short bullet lines starting with '- ': which materials are " +
            "most urgent and why, and any consolidation worth doing (same supplier). Plain text, no preamble.",
          messages: [{ role: "user", content: `Horizon ${horizonDays} days.\n${facts}\n\nSummarise the replenishment need.` }],
        });
        aiSummary = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        aiGenerated = true;
      } catch (err) {
        console.warn("[replenishment-forecast] AI failed:", err?.message);
      }
    }

    res.json({
      success: true, horizonDays, lookbackDays,
      totals, materials: flagged, bySupplier, skippedNoSupplier,
      aiSummary, aiGenerated,
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

    if (updates.length > 500) {
      return next(new ErrorHandler("updates exceeds the 500-item limit per request", 400));
    }

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

        maybeFirePriceChangeAlert({
          material,
          oldPrice,
          newPrice,
          reason: reason || "Bulk price update",
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

// ─────────────────────────────────────────────────────────────
//  GET /materials/reorder-suggestions
//
//  Every material at/below its minimum, grouped by default
//  supplier, with a suggested order quantity that tops stock
//  back up to 2× minStock (a simple min/max policy). The web
//  app turns each supplier group into a one-click PO draft.
// ─────────────────────────────────────────────────────────────
router.get(
  "/reorder-suggestions",
  catchAsyncErrors(async (req, res) => {
    const low = await RawMaterial.find({ $expr: { $lte: ["$stock", "$minStock"] } })
      .populate("supplier", "name")
      .select("name category stock minStock price supplier")
      .sort({ stock: 1 })
      .lean();

    const groups = new Map();
    let suggestedCount = 0;
    for (const m of low) {
      const suggestedQty = Math.max(0, m.minStock * 2 - m.stock);
      // Skip items with nothing to reorder — happens when minStock is
      // unset (0), which would otherwise put a zero-qty line into the PO
      // draft and get rejected by /create-po.
      if (suggestedQty <= 0) continue;
      suggestedCount += 1;
      const key = m.supplier?._id?.toString() ?? "none";
      if (!groups.has(key)) {
        groups.set(key, {
          supplierId: m.supplier?._id ?? null,
          supplierName: m.supplier?.name ?? "No default supplier",
          items: [],
          estimatedValue: 0,
        });
      }
      const g = groups.get(key);
      g.items.push({
        materialId: m._id,
        name: m.name,
        category: m.category,
        stock: m.stock,
        minStock: m.minStock,
        price: m.price,
        suggestedQty,
      });
      g.estimatedValue += suggestedQty * (m.price || 0);
    }

    res.json({
      success: true,
      count: suggestedCount,
      suppliers: [...groups.values()].map((g) => ({
        ...g,
        estimatedValue: Math.round(g.estimatedValue * 100) / 100,
      })),
    });
  })
);

module.exports = router;
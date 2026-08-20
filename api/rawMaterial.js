"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
// From utils, NOT the model: tests automock the model, which would
// stub canonicalCategory into rejecting every valid category.
const { MATERIAL_CATEGORIES, MATERIAL_POSITIONS, canonicalCategory } =
  require("../utils/materialCategories");
const MaterialGroup     = require("../models/MaterialGroup");
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
const { receiveAtCost, costOf } = require("../utils/materialValuation");
const { countUsage } = require("../utils/masterUsage");
const YarnLot           = require("../models/YarnLot");
const { creditLot, drawFromLot, unplacedQuantity } = require("../services/yarnLotService");
const {
  maybeFireCriticalStockout,
  maybeFirePriceChangeAlert,
  maybeFirePoReceivedForCritical,
} = require("../utils/inventoryAlerts");
const { enqueue } = require("../utils/outbox");
const {
  dailyDemand,
  demandPattern,
  position,
  applyPurchaseRules,
  SERVICE_LEVELS,
  DEFAULT_SERVICE_LEVEL,
} = require("../services/replenishment");

const {
  observationsFrom,
  buildIndex,
  resolveLeadTime,
} = require("../services/leadTimeLearning");

const DAY_MS = 86_400_000;

/**
 * Settle the two classifications independently.
 *
 * They USED to settle against each other: `category` held the group's
 * name, so sending either wrote both. That fusion is what has been
 * undone. They now answer different questions and neither derives from
 * the other:
 *
 *   category — the system's fixed vocabulary. Validated against
 *              MATERIAL_CATEGORIES and stored in the canonical
 *              spelling, so "rubber" from the phone and "Rubber" from
 *              the web land on the same value and the recipe picker's
 *              literal match finds both.
 *
 *   group    — the mill's own classification. Optional. Any live
 *              group, no relationship to category at all.
 *
 * ── Why an unknown category is refused here but not in the schema ──
 * The schema has to keep loading rows written under the old scheme,
 * which hold group names. Refusing at the write path means new and
 * edited data converges on the five while old data still opens. A
 * material whose category is a legacy group name keeps it until
 * somebody saves that material, and then has to pick a real one.
 *
 * @returns {{ error: string } | { group: ObjectId|null, category: string }}
 */
async function resolveClassification({ group, category }) {
  const canon = canonicalCategory(category);
  if (!canon) {
    const sent = String(category ?? "").trim();
    return {
      error: sent
        ? `"${sent}" is not a material category. Choose one of: ` +
          `${MATERIAL_CATEGORIES.join(", ")}. To track your own ` +
          `classifications, use material groups instead.`
        : `A category is required — one of: ${MATERIAL_CATEGORIES.join(", ")}`,
    };
  }

  if (group === undefined || group === null || group === "") {
    return { group: null, category: canon };
  }

  if (!mongoose.Types.ObjectId.isValid(group)) {
    return { error: "group must be a valid id" };
  }
  const doc = await MaterialGroup.findById(group).select("name archived").lean();
  if (!doc) return { error: "That material group does not exist" };
  if (doc.archived) {
    return { error: `"${doc.name}" is archived — restore it before filing materials under it.` };
  }
  return { group: doc._id, category: canon };
}

// ══════════════════════════════════════════════════════════════
//  1.  CREATE RAW MATERIAL
//      POST /materials/create-raw-material
// ══════════════════════════════════════════════════════════════
router.post(
  "/create-raw-material",
  catchAsyncErrors(async (req, res, next) => {
    const { name, category, group, stock, minStock, supplier, price, unit } = req.body;

    if (!name || !supplier) {
      return next(new ErrorHandler("name and supplier are required", 400));
    }

    const resolved = await resolveClassification({ group, category });
    if (resolved.error) return next(new ErrorHandler(resolved.error, 400));

    // The group's defaults fill blanks at CREATE only, and are copied
    // onto the material rather than read through. A material's own
    // figures have to keep working when the group's change — otherwise
    // editing a group silently restates the minimum stock of every
    // material in it, which is not what editing a default means.
    let defaults = { unit: "", minStock: 0 };
    if (resolved.group) {
      const g = await MaterialGroup.findById(resolved.group)
        .select("defaultUnit defaultMinStock").lean();
      defaults = { unit: g?.defaultUnit || "", minStock: Number(g?.defaultMinStock) || 0 };
    }

    const material = await RawMaterial.create({
      name,
      category: resolved.category,
      group:    resolved.group,
      unit:     String(unit ?? "").trim() || defaults.unit || "kg",
      stock:    stock    || 0,
      minStock: minStock !== undefined && minStock !== null && minStock !== ""
        ? minStock
        : defaults.minStock,
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
//  GET /categories — the fixed vocabulary, from one place
//
//  Not a convenience. This list lived in eight places that disagreed:
//  the web knew four values, the phone knew five, and this server
//  matched four literals by exact case — which is how a material
//  entered on the phone as "Chemicals" became invisible on the web.
//
//  Both clients read it here now, so a change is a change everywhere.
//  `positions` is the subset the elastic recipe pickers want: the
//  three that say WHERE in the cloth, without the two that say what
//  the material is.
//
//  Unauthenticated-adjacent on purpose (the router's own gate still
//  applies): it is a constant, carries nothing about this mill, and a
//  picker that cannot populate is worse than one anybody can read.
// ══════════════════════════════════════════════════════════════
router.get(
  "/categories",
  catchAsyncErrors(async (_req, res) => {
    res.json({
      success: true,
      categories: MATERIAL_CATEGORIES,
      positions: MATERIAL_POSITIONS,
    });
  })
);

// ══════════════════════════════════════════════════════════════
router.get(
  "/get-raw-materials",
  catchAsyncErrors(async (req, res, next) => {
    const { search, category, group, lowStock } = req.query;

    const filter = {};
    // Archived materials are out of the pickers by default — that is
    // the whole point of archiving one. `$ne: true` rather than
    // `false`, because rows written before the field existed have no
    // value and must read as active.
    if (req.query.includeArchived !== "true") filter.archived = { $ne: true };

    // Filter by group id (what the web now sends) or by category name
    // (what mobile and every older client send). The name match is
    // case-INSENSITIVE: a chip labelled "Rubber" must find the rows a
    // client wrote as "rubber", which is the split this whole feature
    // exists to end and which an exact match would preserve forever.
    if (group && mongoose.Types.ObjectId.isValid(group)) {
      const g = await MaterialGroup.findById(group).select("name").lean();
      filter.$or = g
        ? [{ group: g._id }, { category: new RegExp(`^${escapeRegex(g.name)}$`, "i") }]
        : [{ group }];
    } else if (category) {
      filter.category = new RegExp(`^${escapeRegex(String(category))}$`, "i");
    }

    if (search)              filter.name = { $regex: escapeRegex(search), $options: "i" };
    if (lowStock === "true") filter.$expr = { $lte: ["$stock", "$minStock"] };

    const materials = await RawMaterial.find(filter)
      .populate("supplier", "name")
      .populate("group", "name colour kind")
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

    // What this shelf is worth. `avgCost` is 0 for material that has
    // not been received since averaging existed, and costOf falls back
    // to the latest purchase price for those — which is what they were
    // valued at before, so nothing on screen jumps on the day this
    // ships. Derived here rather than in each client so the material
    // page, the report and the phone all agree on one figure.
    const unitCost = costOf(material);

    res.status(200).json({
      success: true,
      material: {
        ...material,
        unitCost,
        stockValue: Math.round((Number(material.stock) || 0) * unitCost * 100) / 100,
        inwards, outwards, lots, unplacedQty,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  4.  DELETE RAW MATERIAL
//      DELETE /materials/delete-raw-material?id=<id>
//
//  Deletes only a material nothing has ever used. Anything else is
//  ARCHIVED instead — see utils/masterUsage.js for why, at length.
//
//  Briefly: this route had no guard at all. Deleting a yarn named by
//  an order requirement, a PO line, a goods receipt, a dye lot or an
//  elastic's recipe left every one of those documents pointing at
//  nothing, and the screens that read them showing a blank where a
//  yarn name belongs. The history is the business's record of what
//  happened; it is not the master's to take with it.
//
//  The caller is told which it was, and where the material is used, so
//  "delete" quietly becoming "archive" is never a surprise.
// ══════════════════════════════════════════════════════════════
router.delete(
  "/delete-raw-material",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Material ID required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid material id", 400));
    }

    const material = await RawMaterial.findById(id);
    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    const usage = await countUsage("RawMaterial", material._id);

    if (usage.used) {
      // Already archived: say so plainly rather than reporting a second
      // archive as though something had happened.
      if (material.archived) {
        return res.status(200).json({
          success:  true,
          archived: true,
          deleted:  false,
          usage:    usage.places,
          message:
            `"${material.name}" is used by ${usage.summary}, so it cannot be deleted. ` +
            `It is already archived and hidden from the pickers.`,
        });
      }

      material.archived   = true;
      material.archivedAt = new Date();
      await material.save();

      return res.status(200).json({
        success:  true,
        archived: true,
        deleted:  false,
        usage:    usage.places,
        message:
          `"${material.name}" is used by ${usage.summary}, so it was archived ` +
          `instead of deleted — hidden from the pickers, with every existing ` +
          `record still pointing at it.`,
      });
    }

    // Never used: nothing to orphan, so a typo entered five minutes ago
    // is still a typo and can go.
    await material.deleteOne();
    res.status(200).json({
      success:  true,
      archived: false,
      deleted:  true,
      message:  `"${material.name}" deleted — nothing had used it.`,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  4b. ARCHIVE / RESTORE RAW MATERIAL
//      PATCH /materials/:id/archive   { archived: true|false }
//
//  The deliberate version of what the delete route falls back to.
//  Nothing is removed: the material stops appearing in the pickers
//  (override with ?includeArchived=true) and every reference to it
//  still resolves, so history reads exactly as it did.
//
//  Guard: a material an open order still needs cannot be archived.
//  Hiding it would take it out of the MRP and the reorder suggestions
//  at the moment somebody has to buy it — the same reason a customer
//  with live orders is protected.
// ══════════════════════════════════════════════════════════════
router.patch(
  "/:id/archive",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid material id", 400));
    }
    const wantArchived = req.body?.archived !== false; // default: archive

    const material = await RawMaterial.findById(id).select("_id name archived stock");
    if (!material) return next(new ErrorHandler("Raw material not found", 404));

    if (wantArchived) {
      const live = await Order.countDocuments({
        "rawMaterialRequired.rawMaterial": material._id,
        status: { $nin: ["Completed", "Cancelled"] },
      });
      if (live > 0) {
        return next(new ErrorHandler(
          `Cannot archive "${material.name}" — ${live} open order${live === 1 ? "" : "s"} still ` +
          `require${live === 1 ? "s" : ""} it. Complete or cancel them first.`,
          400
        ));
      }
    }

    material.archived   = wantArchived;
    material.archivedAt = wantArchived ? new Date() : undefined;
    await material.save();

    res.json({
      success:    true,
      materialId: material._id,
      name:       material.name,
      archived:   material.archived,
      message:    wantArchived
        ? `"${material.name}" archived — hidden from the pickers`
        : `"${material.name}" restored to active lists`,
    });
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
    const ALLOWED = ["name", "supplier", "price", "minStock", "stock", "unit"];
    const update = {};
    for (const f of ALLOWED) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }
    const priceReason = req.body.priceReason;

    const existing = await RawMaterial.findById(_id);
    if (!existing) return next(new ErrorHandler("Raw material not found", 404));

    // `category` and `group` are settled together, never separately.
    // Both go through the resolver even when only one was sent, so an
    // edit cannot slip an unvalidated category in as a plain field.
    //
    // `group` is passed as sent, INCLUDING when it is absent: the two
    // are independent now, so changing a material's category must not
    // silently move or clear which group it is filed under. An edit
    // that omits `group` keeps the existing link.
    if (req.body.category !== undefined || req.body.group !== undefined) {
      const resolved = await resolveClassification({
        group: req.body.group !== undefined ? req.body.group : existing.group,
        category: req.body.category ?? existing.category,
      });
      if (resolved.error) return next(new ErrorHandler(resolved.error, 400));
      update.category = resolved.category;
      update.group    = resolved.group;
    }

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

    // What this consignment cost. The PO line is the authority — it is
    // the price that was agreed for these goods — and the material's
    // own latest price is the fallback for a receipt against a line
    // that never carried one.
    const poLine = po.items.find(
      (i) => i.rawMaterial.toString() === String(rawMaterialId)
    );
    const unitPrice = Math.max(
      0,
      Number(poLine?.price ?? material.price) || 0
    );

    // Credit the stock and move the weighted average in one atomic
    // update. This used to be `material.stock += qty; material.save()`,
    // which loses one of two receipts landing together — and now that a
    // receipt also moves what the stock is WORTH, a lost update would
    // corrupt money and not just a count.
    const credited = await receiveAtCost(material._id, qtyNum, unitPrice);
    // Keep the in-memory document in step: the alert below and the
    // response both read it.
    material.stock   = credited?.stock   ?? _stockBefore + qtyNum;
    material.avgCost = credited?.avgCost ?? material.avgCost;

    await appendStockMovement(material._id, {
      type:     "PO_INWARD",
      // Which purchase order these goods came in against. Without it the
      // ledger row says only that stock went up.
      purchaseOrder: po._id,
      refNo:         po.poNo != null ? String(po.poNo) : "",
      quantity: qtyNum,
      balance:  material.stock,
      unitCost: unitPrice,
    });

    const lotNo = req.body.lotNo ? String(req.body.lotNo).trim() : "";

    const inward = await MaterialInward.create({
      rawMaterial:   rawMaterialId,
      purchaseOrder: purchaseOrderId,
      quantity:      Number(quantity),
      inwardDate:    new Date(),
      remarks:       remarks || "",
      lotNo,
      unitPrice,
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

            const oldStock = Number(material.stock) || 0;
            const newStock = Math.max(0, oldStock + item.adjustment);
            // What the stock actually moved by. Stock floors at zero, so
            // writing 50 off against 30 on hand moves 30 — and every row
            // below used to record the 50 anyway: the ledger's arithmetic
            // did not close, the outward row over-stated consumption
            // straight into the order P&L, and the lot draw asked for
            // yarn the lot never held. The requested figure is still
            // recorded, beside the applied one, so the gap is visible.
            const applied  = newStock - oldStock;
            // Nothing to take. Silently writing a zero-quantity outward
            // row and reporting success would tell the person their
            // write-off went through when no stock moved at all.
            if (applied === 0) {
              throw new Error(
                `Nothing to adjust — ${material.name} already holds ${oldStock}`
              );
            }
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
              quantity: applied,
              requested: applied === item.adjustment ? undefined : item.adjustment,
              balance:  newStock,
              // An adjustment never moves the average — a count that
              // finds 5 kg missing has not changed what the rest of it
              // cost — but the row still says what the missing yarn was
              // worth, which is the number a write-off is judged on.
              unitCost: costOf(material),
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

            // `applied` throughout, not `item.adjustment` — the lot and
            // the outward row have to move by the same amount the stock
            // did, or the lot ledger and the P&L drift away from the
            // aggregate they are supposed to break down.
            if (applied > 0) {
              if (lotNo) {
                const lot = await creditLot({
                  rawMaterial: material._id,
                  lotNo,
                  quantity:    applied,
                  shade:       item.shade,
                  supplier:    material.supplier,
                }, session);
                lotRef = lot?._id || null;
              }
              await MaterialInward.create([{
                rawMaterial:   material._id,
                purchaseOrder: item.purchaseOrderId || undefined,
                quantity:      applied,
                inwardDate:    new Date(),
                remarks:       `Stock adjustment: ${reason}`,
                lotNo,
                // Found stock is not a purchase, so it is valued at what
                // the rest of the stock cost and deliberately does NOT
                // move the average — see utils/materialValuation.js.
                unitPrice:     costOf(material),
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
                  item.yarnLot, Math.abs(applied), session,
                  // Not a batch issue — say on the lot's ledger that a
                  // person wrote this off, and why.
                  { reason }
                );
                lotRef   = lot._id;
                lotLabel = lot.lotNo;
              }
              await MaterialOutward.create([{
                rawMaterial: material._id,
                quantity:    Math.abs(applied),
                type:        "STOCK_ADJUST",
                outwardDate: new Date(),
                // The weighted average, not the latest purchase price —
                // this row is what the order P&L costs the yarn at.
                unitPrice:   costOf(material),
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
              // What was actually applied. The caller used to be handed
              // back the figure it sent, so a clamped write-off looked
              // to the UI exactly like one that went through in full.
              adjustment: applied,
              // Only when they differ, so the ordinary case is unchanged
              // and the exceptional one is impossible to miss.
              requested:  applied === item.adjustment ? undefined : item.adjustment,
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
//  GET /materials/replenishment-forecast
//      ?lookbackDays=60 &coverDays=30 &serviceLevel=95
//
//  WHAT TO BUY, AND THE LAST DAY IT CAN LEAVE.
//
//  The reorder-point model — see services/replenishment.js for the
//  arithmetic and the reasoning. This route's job is to gather the four
//  inputs honestly, which is where the previous version went wrong:
//
//  1. COMMITTED DEMAND WAS ALWAYS ZERO. It read `rm.quantity` off
//     Order.rawMaterialRequired, whose field is `requiredWeight`. The
//     endpoint advertised the Open-order pipeline as one of its three
//     inputs and that input contributed nothing, ever.
//
//  2. STOCK ON ORDER WAS IGNORED. A raised, unreceived PO is stock that
//     is coming; nothing looked at purchase orders, so the same
//     shortfall was recommended again every time the page was opened.
//
//  3. HALF THE CONSUMPTION WAS INVISIBLE. The run-rate counted
//     ORDER_APPROVAL draws only. Yarn issued against a job during the
//     run (JOB_CONSUMPTION) moved the rate not at all.
//
//  4. ARCHIVED MATERIALS WERE STILL RECOMMENDED. `find({})`, no filter.
//
//  5. THERE WAS NO LEAD TIME ANYWHERE, so "order this" never meant
//     "order this BY a date" — which is the only actionable output a
//     replenishment report has.
//
//  Deterministic throughout. The optional Claude summary explains the
//  ranking in words; it does not choose a number and cannot change one.
// ══════════════════════════════════════════════════════════════
router.get(
  "/replenishment-forecast",
  catchAsyncErrors(async (req, res) => {
    // A longer default window than the old 30 days: safety stock is
    // driven by the spread of daily demand, and a month of a mill's
    // draws is too few days to estimate a spread from.
    const lookbackDays = Math.min(Math.max(Number(req.query.lookbackDays) || 60, 7), 365);
    const coverDays    = Math.min(Math.max(Number(req.query.coverDays)    || 30, 1), 180);
    const serviceLevel = SERVICE_LEVELS[Number(req.query.serviceLevel)]
      ? Number(req.query.serviceLevel)
      : DEFAULT_SERVICE_LEVEL;

    // Kept so existing callers (and the web page) do not break; it no
    // longer drives the decision, because the reorder point is set by
    // the lead time rather than by an arbitrary look-ahead.
    const horizonDays = Math.min(Math.max(Number(req.query.horizonDays) || 14, 1), 120);

    // Return the materials that DON'T need ordering too.
    //
    // The buying list is the point of this endpoint, so by default it
    // returns only what breaches its reorder point. But that made the
    // whole model invisible whenever nothing did — and with no lead
    // times set, which is where every mill starts, almost nothing does.
    // The page then showed an empty state, which reads as "the system
    // has nothing to say" rather than "everything is comfortable, and
    // here is why".
    //
    // Off by default so the buying list stays a buying list.
    const includeHealthy = req.query.includeHealthy === '1'
      || req.query.includeHealthy === 'true';

    const now   = new Date();
    const since = new Date(now.getTime() - lookbackDays * DAY_MS);

    // Learning window: a year of deliveries. Long enough for a
    // seasonal pattern, short enough that a supplier's behaviour from
    // two mills ago is not still setting today's safety stock.
    const learnSince = new Date(now.getTime() - 365 * DAY_MS);

    const [materials, draws, openOrders, openPos, receipts, historicPos] = await Promise.all([
      // Archived materials are retired — out of every picker, and out of
      // the buying list too.
      RawMaterial.find({ archived: { $ne: true } })
        .select("-stockMovements")
        .populate("supplier", "name leadTimeDays minOrderQty packSize")
        .lean(),

      // BOTH ways yarn leaves stock. STOCK_ADJUST is excluded on
      // purpose: a write-off or a count correction is not demand, and
      // treating it as such would have the system buy yarn to replace
      // stock that was never consumed.
      MaterialOutward.find({
        type: { $in: ["ORDER_APPROVAL", "JOB_CONSUMPTION"] },
        reversed: { $ne: true },
        createdAt: { $gte: since },
      }).select("rawMaterial quantity createdAt outwardDate").lean(),

      // Not yet approved, so not yet drawn — this is demand still to
      // come out of stock.
      Order.find({ status: "Open" }).select("rawMaterialRequired").lean(),

      // Raised and not fully received: stock that is on its way.
      PurchaseOrder.find({ status: { $in: ["Open", "Partial"] } })
        .select("items")
        .lean(),

      // ── The ground truth the lead time is LEARNED from ────────
      // A goods receipt names the PO it came against, so
      // inwardDate − po.date is an observed lead time for that
      // supplier and material. Every delivery adds one; there is no
      // training step and no model file, because the estimate IS the
      // data, recomputed on read.
      MaterialInward.find({
        purchaseOrder: { $ne: null },
        inwardDate: { $gte: learnSince },
      }).select("purchaseOrder rawMaterial inwardDate createdAt").lean(),

      PurchaseOrder.find({ date: { $gte: new Date(learnSince.getTime() - 400 * DAY_MS) } })
        .select("date supplier")
        .lean(),
    ]);

    // ── What the deliveries say ───────────────────────────────
    const poById = new Map(historicPos.map((p) => [String(p._id), p]));
    const observations = observationsFrom(receipts, poById, { now, windowDays: 365 });
    const learned = buildIndex(observations);

    // ── Demand series, per material ───────────────────────────
    const drawsById = new Map();
    for (const d of draws) {
      const id = String(d.rawMaterial);
      if (!drawsById.has(id)) drawsById.set(id, []);
      drawsById.get(id).push({
        at: d.outwardDate || d.createdAt,
        quantity: Number(d.quantity) || 0,
      });
    }

    // ── Committed: `requiredWeight`, which is what the field is called
    const committedById = new Map();
    for (const o of openOrders) {
      for (const rm of o.rawMaterialRequired || []) {
        if (!rm?.rawMaterial) continue;
        const id = String(rm.rawMaterial);
        committedById.set(id, (committedById.get(id) || 0) + (Number(rm.requiredWeight) || 0));
      }
    }

    // ── On order: raised minus received, never negative ───────
    const onOrderById = new Map();
    for (const po of openPos) {
      for (const it of po.items || []) {
        if (!it?.rawMaterial) continue;
        const id = String(it.rawMaterial);
        // An over-receipt (allowed, within tolerance) must not become a
        // negative inbound that inflates the shortfall.
        const outstanding = Math.max(
          0,
          (Number(it.quantity) || 0) - (Number(it.receivedQuantity) || 0)
        );
        onOrderById.set(id, (onOrderById.get(id) || 0) + outstanding);
      }
    }

    const flagged = [];
    let skippedNoSupplier = 0;

    for (const m of materials) {
      const id = String(m._id);
      const materialDraws = drawsById.get(id) || [];
      const demand = dailyDemand(materialDraws, lookbackDays, now);

      // A typed figure wins over a learned one — somebody may know
      // something the history cannot. The learned figure is reported
      // alongside either way, so a manual entry the deliveries
      // contradict is visible rather than silently obeyed.
      const supplierId = m.supplier?._id ? String(m.supplier._id) : null;
      const lead = resolveLeadTime({
        materialLeadTime: m.leadTimeDays,
        supplierLeadTime: m.supplier?.leadTimeDays,
        observed: {
          material: learned.material.get(`${supplierId || '-'}:${id}`) || null,
          supplier: supplierId ? learned.supplier.get(supplierId) || null : null,
        },
      });

      const pos = position({
        onHand:    Number(m.stock) || 0,
        onOrder:   onOrderById.get(id) || 0,
        committed: committedById.get(id) || 0,
        minStock:  Number(m.minStock) || 0,
        leadTimeDays: lead.days,
        // Measured spread of the delivery time. Zero when there is no
        // history, which collapses the safety-stock formula back to
        // the fixed-lead-time one exactly.
        leadTimeSd: lead.sd,
        coverDays,
        serviceLevel,
        demand,
        now,
      });

      const needsOrder = pos.shouldOrder && pos.suggestedQty > 0;
      if (!needsOrder && !includeHealthy) continue;

      // A line nobody can act on is noise on a BUYING list — but it is
      // still a material whose position somebody may want to inspect,
      // so it is only dropped when the buying list is what was asked
      // for.
      if (!m.supplier || !m.supplier._id) {
        if (needsOrder) skippedNoSupplier += 1;
        if (!includeHealthy) continue;
      }

      const orderQty = applyPurchaseRules(pos.suggestedQty, {
        minOrderQty: m.supplier?.minOrderQty,
        packSize:    m.supplier?.packSize,
      });

      flagged.push({
        _id: id,
        name: m.name,
        category: m.category,
        unit: m.unit || "kg",
        price: Number(m.price) || 0,
        ...pos,

        // Where the lead time came from, and what the deliveries say.
        // A buyer who cannot see this cannot tell a measured 14 days
        // from a typed one, and the two deserve different trust.
        leadTimeSource: lead.source,
        leadTimeObserved: lead.learned
          ? {
              median: lead.learned.median,
              sd: lead.learned.sd,
              deliveries: lead.learned.n,
              confidence: lead.learned.confidence,
              fastest: lead.learned.min,
              slowest: lead.learned.max,
            }
          : null,
        // True when a typed lead time and the measured one are five or
        // more days apart. Not corrected automatically — surfaced, so
        // somebody decides.
        leadTimeDisagrees: lead.disagrees,

        // What the demand looks like, so a buyer can weigh the figure.
        // An intermittent yarn's safety stock is dominated by its zero
        // days and the suggestion reads high; saying so is better than
        // quietly switching formula behind their back.
        demandPattern: demandPattern(demand, materialDraws.length),
        drawsInWindow: materialDraws.length,

        // Legacy names, so the existing web page keeps rendering.
        onHand: pos.onHand,
        runRatePerDay: pos.dailyDemand,
        committedDemand: pos.committed,
        projectedStock: pos.netStock,
        daysToStockout: pos.daysOfCover != null ? Math.round(pos.daysOfCover) : null,

        suggestedQty: orderQty,
        rawSuggestedQty: pos.suggestedQty,
        estimatedCost: Math.round(orderQty * (Number(m.price) || 0)),
        // Says which of these is a line to act on, as its own field
        // rather than something a reader has to infer from a quantity.
        needsOrder,
        supplier: m.supplier?._id
          ? {
              _id: String(m.supplier._id),
              name: m.supplier.name,
              leadTimeDays: Number(m.supplier.leadTimeDays) || 0,
            }
          : null,
      });
    }

    // Everything below — the ordering, the per-supplier grouping, the
    // totals — is about the BUYING LIST, so it reads only the lines
    // that need ordering. A healthy material rides along for inspection
    // and must not appear in a draft PO or an estimated spend.
    const toBuy = flagged.filter((f) => f.needsOrder && f.supplier);

    // Late first — an order that cannot arrive in time is a different
    // and more urgent thing than one merely below its reorder point.
    // Then by how few days of cover are left.
    toBuy.sort((a, b) => {
      if (a.alreadyLate !== b.alreadyLate) return a.alreadyLate ? -1 : 1;
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      const ac = a.daysOfCover ?? -1;   // no demand at all sorts LAST,
      const bc = b.daysOfCover ?? -1;   // but a certain stockout does not
      if (ac < 0 || bc < 0) return ac < 0 ? 1 : -1;
      return ac - bc;
    });

    // One PO per vendor.
    const bySupplierMap = new Map();
    for (const f of toBuy) {
      const key = f.supplier._id;
      if (!bySupplierMap.has(key)) {
        bySupplierMap.set(key, { supplier: f.supplier, lines: [], estimatedCost: 0 });
      }
      const g = bySupplierMap.get(key);
      g.lines.push(f);
      g.estimatedCost += f.estimatedCost;
    }
    const bySupplier = [...bySupplierMap.values()];

    // Lead time is the input the whole model rests on, and it defaults
    // to zero. A mill that has set none gets the old behaviour and no
    // explanation of why nothing is ever flagged early — so say it.
    const noLeadTime = materials.filter(
      (m) => !(m.leadTimeDays ?? m.supplier?.leadTimeDays)
    ).length;

    const totals = {
      flagged: toBuy.length,
      critical: toBuy.filter((f) => f.severity === "critical").length,
      late: toBuy.filter((f) => f.alreadyLate).length,
      suppliers: bySupplier.length,
      estimatedCost: toBuy.reduce((s, f) => s + f.estimatedCost, 0),
      // Only meaningful when the healthy ones were asked for.
      reviewed: includeHealthy ? flagged.length : undefined,
    };

    const warnings = [];
    if (noLeadTime > 0) {
      warnings.push(
        `${noLeadTime} material(s) have no lead time set, on themselves or their supplier. ` +
        `Their reorder point is the manual minimum stock only, and no "order by" date can ` +
        `be worked out — set a lead time on the supplier to get one.`
      );
    }
    if (skippedNoSupplier > 0) {
      warnings.push(
        `${skippedNoSupplier} material(s) need reordering but have no supplier, so they ` +
        `cannot be put on a purchase order.`
      );
    }

    // ── The narrative ─────────────────────────────────────────
    // Explains the ranking; it does not decide it. Every number above
    // is already fixed by the time this runs, and a failure here loses
    // the prose and nothing else.
    let aiSummary = null, aiGenerated = false;
    const claude = anthropic();
    if (claude && toBuy.length > 0) {
      try {
        const facts = toBuy.slice(0, 8).map((f) =>
          `${f.name}: net ${f.netStock} ${f.unit} (on hand ${f.onHand}, on order ${f.onOrder}, ` +
          `committed ${f.committed}), uses ${f.dailyDemand}/day, lead time ${f.leadTimeDays}d, ` +
          `reorder point ${f.reorderPoint}, ${f.daysOfCover ?? "?"} days cover` +
          `${f.orderByDate ? `, order by ${f.orderByDate}` : ""}` +
          `${f.alreadyLate ? " (ALREADY LATE)" : ""} → buy ${f.suggestedQty}`
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
      success: true,
      horizonDays, lookbackDays, coverDays, serviceLevel,
      totals,
      // Everything that was assessed — the buying list when
      // includeHealthy is off, every material when it is on.
      materials: flagged,
      bySupplier, skippedNoSupplier,
      // The model rests on lead time and it defaults to zero. A mill
      // that has set none gets a reorder point of just its manual
      // minimum and no "order by" date — worth saying out loud rather
      // than letting the page look quietly empty.
      warnings,
      aiSummary, aiGenerated,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  11. MATERIAL FOR NEW ELASTIC  (legacy)
// ══════════════════════════════════════════════════════════════
//  Four buckets, matched CASE-INSENSITIVELY and by group link as well
//  as by name.
//
//  This used to be four find({ category: "warp" }) queries matching the
//  literal string — note "Rubber" capitalised and the other three not.
//  Two consequences, both silent:
//
//    • Editing a group's name case in the master emptied the matching
//      picker. No error, no empty-state message — the elastic form just
//      offered no warp yarns, and the recipe went in blank.
//    • The mobile app has always offered a "Chemicals" category the web
//      never had. Those materials matched none of the four and were
//      invisible to this endpoint entirely.
//
//  The buckets themselves stay hardcoded on purpose: an elastic has
//  exactly four composition slots, and they are a property of the cloth
//  rather than of the group list. What is no longer hardcoded is which
//  materials fall into each — that comes from the groups, so renaming
//  one in Settings moves its materials here too.
const RECIPE_BUCKETS = Object.freeze({
  warp:     ['warp'],
  weft:     ['weft'],
  covering: ['covering'],
  // Named "rubber" in the response for the elastic form's warp-spandex
  // slot; "spandex" accepted too, because that is what the floor calls
  // it and a mill that renamed the group should not lose the picker.
  rubber:   ['rubber', 'spandex'],
});

router.get(
  "/materialForNewElastic",
  catchAsyncErrors(async (req, res, next) => {
    const groups = await MaterialGroup.find({ archived: { $ne: true } })
      .select("_id name")
      .lean();

    // A group belongs to a bucket when its name CONTAINS the keyword,
    // folded to lowercase — so "Warp", "warp yarn" and "Warp Spandex"
    // all reach the warp picker, and a rename that keeps the word
    // keeps working.
    const bucketFor = (name) => {
      const n = String(name || "").toLowerCase();
      for (const [bucket, keywords] of Object.entries(RECIPE_BUCKETS)) {
        if (keywords.some((k) => n.includes(k))) return bucket;
      }
      return null;
    };

    const idsByBucket = { warp: [], weft: [], covering: [], rubber: [] };
    const namesByBucket = { warp: [], weft: [], covering: [], rubber: [] };
    for (const g of groups) {
      const bucket = bucketFor(g.name);
      if (!bucket) continue;
      idsByBucket[bucket].push(g._id);
      namesByBucket[bucket].push(g.name);
    }

    // Matched by group link OR by category name, and the name match is
    // a case-insensitive regex rather than an equality — a material
    // that predates the migration carries only the string.
    const query = (bucket) => {
      const names = namesByBucket[bucket];
      const ids   = idsByBucket[bucket];
      const or = [];
      if (ids.length)   or.push({ group: { $in: ids } });
      if (names.length) {
        or.push({
          category: { $in: names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i")) },
        });
      }
      // No group carries this keyword — fall back to the literal the
      // endpoint always used, so a database with no groups seeded yet
      // behaves exactly as it did before.
      if (or.length === 0) {
        or.push({
          category: {
            $in: RECIPE_BUCKETS[bucket].map((k) => new RegExp(`^${escapeRegex(k)}$`, "i")),
          },
        });
      }
      return RawMaterial.find({ archived: { $ne: true }, $or: or }).sort({ name: 1 });
    };

    const [warp, rubber, weft, covering] = await Promise.all([
      query("warp"), query("rubber"), query("weft"), query("covering"),
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
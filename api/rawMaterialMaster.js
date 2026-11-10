"use strict";
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIALS — THE MATERIAL MASTER  (part of /api/v2/materials)
//
//    POST    /create-raw-material
//    GET     /categories
//    GET     /get-raw-materials
//    GET     /get-raw-material-detail
//    DELETE  /delete-raw-material
//    POST    /bulk/update
//    POST    /bulk/archive
//    PATCH   /:id/archive
//    PUT     /edit-raw-material
//
//  api/rawMaterial.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express           = require("express");
const { assertVersion, bumpVersion, explainMiss } = require("../utils/versioning");
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
// From utils, NOT the model: tests automock the model, which would
// stub canonicalCategory into rejecting every valid category.
const { MATERIAL_CATEGORIES, MATERIAL_POSITIONS, canonicalCategory } =
  require("../utils/materialCategories");
const MaterialGroup     = require("../models/MaterialGroup");
const MaterialInward    = require("../models/MaterialInward");
const MaterialOutward   = require("../models/MaterialOut.cjs");
const Supplier          = require("../models/Supplier");
const Order             = require("../models/Order");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { escapeRegex } = require("../utils/escapeRegex");
const { normaliseMovements } = require("../utils/stockLedger");
const { costOf } = require("../utils/materialValuation");
const { countUsage } = require("../utils/masterUsage");
const YarnLot           = require("../models/YarnLot");
const { unplacedQuantity } = require("../services/yarnLotService");
const { maybeFirePriceChangeAlert } = require("../utils/inventoryAlerts");
const { enqueue } = require("../utils/outbox");
const router = express.Router();

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
// ══════════════════════════════════════════════════════════════
//  BULK, FROM THE LIST'S SELECTION
//    POST /materials/bulk/update   { ids, supplier?, minStock?, group? }
//    POST /materials/bulk/archive  { ids, archived }
//
//  Each material is done on its own, under the same rules as its own
//  edit / archive, and reported on its own. The version is bumped on
//  every change, so an edit form open on one of them gets a 409 rather
//  than writing back what it loaded.
// ══════════════════════════════════════════════════════════════
const BULK_MAX = 200;
function bulkIds(body) {
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))] : [];
  if (ids.length === 0) return { error: new ErrorHandler("Select at least one material", 400) };
  if (ids.length > BULK_MAX) return { error: new ErrorHandler(`At most ${BULK_MAX} materials at a time`, 400) };
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return { error: new ErrorHandler("Invalid material id", 400) };
  return { ids };
}
const bulkSummary = (results) => ({
  done: results.filter((r) => r.ok).length,
  refused: results.filter((r) => !r.ok).length,
  results,
});

router.post(
  "/bulk/update",
  catchAsyncErrors(async (req, res, next) => {
    const { ids, error } = bulkIds(req.body);
    if (error) return next(error);
    const set = {};
    if (req.body.supplier !== undefined) {
      const sup = String(req.body.supplier || "");
      if (!mongoose.Types.ObjectId.isValid(sup) || !(await Supplier.exists({ _id: sup }))) {
        return next(new ErrorHandler("Choose a supplier that exists", 400));
      }
      set.supplier = sup;
    }
    if (req.body.minStock !== undefined && req.body.minStock !== "") {
      const v = Number(req.body.minStock);
      if (!Number.isFinite(v) || v < 0) return next(new ErrorHandler("Min stock must be 0 or more", 400));
      set.minStock = v;
    }
    const changeGroup = req.body.group !== undefined;
    if (!changeGroup && Object.keys(set).length === 0) {
      return next(new ErrorHandler("Nothing to change: give a supplier, a min stock or a group", 400));
    }

    const results = [];
    for (const id of ids) {
      const m = await RawMaterial.findById(id).select("_id name category group");
      if (!m) { results.push({ id, ok: false, reason: "Not found" }); continue; }
      const update = { ...set };
      if (changeGroup) {
        // Through the same resolver as an edit; the category stays as it is.
        const resolved = await resolveClassification({ group: req.body.group || null, category: m.category });
        if (resolved.error) { results.push({ id, name: m.name, ok: false, reason: resolved.error }); continue; }
        update.category = resolved.category;
        update.group = resolved.group;
      }
      await RawMaterial.updateOne({ _id: m._id }, { $set: update, $inc: { __v: 1 } });
      results.push({ id, name: m.name, ok: true });
    }
    res.json({ success: true, ...bulkSummary(results) });
  })
);

router.post(
  "/bulk/archive",
  catchAsyncErrors(async (req, res, next) => {
    const { ids, error } = bulkIds(req.body);
    if (error) return next(error);
    const wantArchived = req.body?.archived !== false;
    const results = [];
    for (const id of ids) {
      const m = await RawMaterial.findById(id).select("_id name archived");
      if (!m) { results.push({ id, ok: false, reason: "Not found" }); continue; }
      if (!!m.archived === wantArchived) { results.push({ id, name: m.name, ok: true, unchanged: true }); continue; }
      if (wantArchived) {
        const live = await Order.countDocuments({
          "rawMaterialRequired.rawMaterial": m._id,
          status: { $nin: ["Completed", "Cancelled"] },
        });
        if (live > 0) {
          results.push({ id, name: m.name, ok: false, reason: `${live} open order${live === 1 ? "" : "s"} still need it` });
          continue;
        }
      }
      await RawMaterial.updateOne(
        { _id: m._id },
        wantArchived
          ? { $set: { archived: true, archivedAt: new Date() }, $inc: { __v: 1 } }
          : { $set: { archived: false }, $unset: { archivedAt: 1 }, $inc: { __v: 1 } }
      );
      results.push({ id, name: m.name, ok: true });
    }
    res.json({ success: true, ...bulkSummary(results) });
  })
);

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
    // The form's version, when it sent one: a save made from a stale
    // screen is a 409, not a silent overwrite of someone else's edit.
    assertVersion(existing, req);

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

    // Conditional on the version READ above, always — not only when the
    // client sent one. The price-history row takes oldPrice from that
    // read, and the category was resolved against it; a save landing in
    // between would have been recorded against the wrong starting point.
    // Now it is a 409 and nothing is written.
    const material = await RawMaterial.findOneAndUpdate(
      { _id, __v: existing.__v },
      { ...update, ...bumpVersion() },
      { new: true, runValidators: true }
    );
    if (!material) await explainMiss(RawMaterial, _id, { body: { expectedVersion: existing.__v } }, "Raw material not found");

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

module.exports = router;

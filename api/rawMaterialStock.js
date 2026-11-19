"use strict";
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIALS — BUYING AND MOVING STOCK  (part of /api/v2/materials)
//
//    GET   /suppliers
//    POST  /raise-po
//    POST  /material-inward
//    POST  /bulk-adjust-stock
//    GET   /adjust-history
//    GET   /ledger
//    GET   /ledger.pdf
//
//  api/rawMaterial.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require("../utils/factoryDay");
const express           = require("express");
const { renderPdf } = require("../utils/renderPdf");
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/MaterialInward");
const MaterialOutward   = require("../models/MaterialOut.cjs");
const JobOrderForIssue  = require("../models/JobOrder");
const Supplier          = require("../models/Supplier");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { escapeRegex } = require("../utils/escapeRegex");
const { appendStockMovement } = require("../utils/stockLedger");
const { receiveAtCost, costOf, noteLatestPrice } = require("../utils/materialValuation");
const { creditLot, drawFromLot } = require("../services/yarnLotService");
const { maybeFirePoReceivedForCritical } = require("../utils/inventoryAlerts");
const { enqueue } = require("../utils/outbox");
const { claimKey, isDuplicateKeyError, isClaimed } = require("../utils/idempotency");
const { materialLedger, parseRange } = require("../services/materialLedger");
const { nextPoNumber, readPoLines, assertSupplier, deriveStatus } = require("../services/purchaseOrderRules");
const { round3 } = require("../utils/quantity");
const { asCallerError } = require("../utils/routeError");
const { getPdfBranding } = require("../services/documentSettings");
const router = express.Router();

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

    // Held to what every purchase order is (services/purchaseOrderRules.js).
    // This route made its own: the PO got NO NUMBER — only the purchase
    // order form allocated one — and its lines were stored as sent, so a
    // supplier that does not exist, a negative price, one material twice
    // and a "receivedQuantity" of the caller's choosing all went in.
    await assertSupplier(supplier);
    const lines = await readPoLines(items);

    const po = await PurchaseOrder.create({
      supplier, items: lines, date: new Date(), status: "Open",
      poNo: await nextPoNumber(),
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
    // To the gram, as the stock and the PO line are kept.
    const qtyNum = round3(quantity);
    if (!Number.isFinite(Number(quantity)) || qtyNum <= 0) {
      return next(
        new ErrorHandler("quantity must be a positive number", 400)
      );
    }

    // The same request sent twice (a double tap, a retry after a timeout)
    // is answered as the first was, and receives nothing a second time.
    const requestId = req.body.requestId ? String(req.body.requestId) : null;
    if (requestId && (await isClaimed(requestId))) {
      return res.status(200).json({ success: true, duplicate: true, message: "This receipt was already recorded" });
    }

    // ── One transaction ──────────────────────────────────────────────
    // The stock credit, its ledger row, the inward record and the PO's
    // received quantity commit together. They used to be four separate
    // writes, and the PO's received quantity was read, added to and
    // saved: two receipts against one PO at once both read the same
    // figure and one of them was lost. Read inside the transaction, the
    // second is retried after the first and adds to its total.
    let material, po, inward, _stockBefore, unitPrice;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (requestId) await claimKey(session, requestId, "material-inward");
        material = await RawMaterial.findById(rawMaterialId).session(session);
        po = await PurchaseOrder.findById(purchaseOrderId).session(session);
        if (!material) throw new ErrorHandler("Raw material not found", 404);
        if (!po)       throw new ErrorHandler("Purchase order not found", 404);
        if (po.status === "Cancelled") {
          throw new ErrorHandler("This purchase order is cancelled, so nothing was received against it.", 409);
        }

        _stockBefore = Number(material.stock) || 0;
        const poLine = po.items.find(
          (i) => i.rawMaterial.toString() === String(rawMaterialId)
        );
        // Against a PO means on it. A material that is not was received
        // anyway: its stock went up, on a receipt naming a PO that never
        // moved and could never be matched to a bill for it.
        if (!poLine) {
          throw new ErrorHandler(
            `${material.name} is not on PO ${po.poNo != null ? `#${po.poNo}` : "that purchase order"} — receive it against the PO it was ordered on`, 400);
        }
        // At the price it was bought at, so the weighted average moves
        // with what the yarn actually cost.
        unitPrice = Math.max(0, Number(poLine?.price ?? material.price) || 0);

        const credited = await receiveAtCost(material._id, qtyNum, unitPrice, session);
        material.stock   = credited?.stock   ?? _stockBefore + qtyNum;
        material.avgCost = credited?.avgCost ?? material.avgCost;

        // A receipt at a new rate is the latest purchase price, which is
        // what an elastic's cost sheet is priced at.
        if (await noteLatestPrice(material._id, poLine?.price,
          `Received on PO ${po.poNo != null ? `#${po.poNo}` : String(po._id)}`, session)) {
          material.price = Number(poLine.price);
        }

        await appendStockMovement(material._id, {
          type:     "PO_INWARD",
          purchaseOrder: po._id,
          refNo:         po.poNo != null ? String(po.poNo) : "",
          quantity: qtyNum,
          balance:  material.stock,
          unitCost: unitPrice,
        }, session);

        const lotNo = req.body.lotNo ? String(req.body.lotNo).trim() : "";
        [inward] = await MaterialInward.create([{
          rawMaterial:   rawMaterialId,
          purchaseOrder: purchaseOrderId,
          quantity:      qtyNum,
          inwardDate:    new Date(),
          remarks:       remarks || "",
          lotNo,
          unitPrice,
        }], { session });

        // To three places, and the status from the same rule the purchase
        // order form's receipt uses: 227.69 + 168.85 kg against 396.54
        // ordered was 396.53999999999996, and the PO stayed "Partial".
        poLine.receivedQuantity = round3((Number(poLine.receivedQuantity) || 0) + qtyNum);
        po.status = deriveStatus(po.items);
        po.increment(); // an edit opened before this receipt gets a 409, not an overwrite
        await po.save({ session });
      });
    } catch (err) {
      // A replay that raced the first past the fast path above.
      if (requestId && isDuplicateKeyError(err)) {
        return res.status(200).json({ success: true, duplicate: true, message: "This receipt was already recorded" });
      }
      throw err;
    } finally {
      await session.endSession();
    }

    // Credit the dye lot after the receipt is committed, so the yarn can
    // be issued to a warping batch by lot later. Not fatal: the lot
    // number is on the MaterialInward row, the durable record, and the
    // bucket can be rebuilt from it.
    const lotNo = inward.lotNo;
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

    res.status(201).json({ success: true, inward, lot, lotError });

    // Nothing waits on this: it catches whatever it meets
    // (tests/architecture/fireAndForgetCaught.test.js).
    (async () => {
      try {
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
      } catch (err) {
        console.warn(`[inward] alert for ${material?._id}: ${err?.message}`);
      }
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
    const adjustments = req.body?.adjustments;
    const globalReason = String(req.body?.globalReason ?? "").trim() || "Stock adjustment";

    if (!Array.isArray(adjustments) || adjustments.length === 0) {
      return next(new ErrorHandler("adjustments array is required", 400));
    }
    if (adjustments.length > 500) {
      return next(new ErrorHandler("adjustments exceeds the 500-item limit per request", 400));
    }

    // Only process items with a meaningful non-zero delta — to the gram,
    // as stock is kept. Added to the stock as typed, 250.7 − 0.3 left
    // 250.39999999999998; and because what was applied then differed from
    // what was asked by a hair, the answer said the write-off had been
    // cut short when it had not.
    const toProcess = adjustments
      .filter((a) => a && a._id && typeof a.adjustment === "number" && Number.isFinite(a.adjustment))
      .map((a) => ({ ...a, adjustment: round3(a.adjustment) }))
      .filter((a) => a.adjustment !== 0);

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
            const newStock = round3(Math.max(0, oldStock + item.adjustment));
            // What the stock actually moved by. Stock floors at zero, so
            // writing 50 off against 30 on hand moves 30 — and every row
            // below used to record the 50 anyway: the ledger's arithmetic
            // did not close, the outward row over-stated consumption
            // straight into the order P&L, and the lot draw asked for
            // yarn the lot never held. The requested figure is still
            // recorded, beside the applied one, so the gap is visible.
            const applied  = round3(newStock - oldStock);
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
            const reason = String(item.reason ?? "").trim() || globalReason;

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
              // Issued to a named job (the stores' spoken or typed line):
              // the job's own consumption, so its P&L carries the yarn.
              const jobRef = mongoose.Types.ObjectId.isValid(String(item.job || ""))
                ? await JobOrderForIssue.findById(item.job).select("jobOrderNo order").session(session).lean() : null;
              if (item.job && !jobRef) throw new Error("That job is not there");
              await MaterialOutward.create([{
                rawMaterial: material._id,
                quantity:    Math.abs(applied),
                type:        jobRef ? "JOB_CONSUMPTION" : "STOCK_ADJUST",
                job:         jobRef?._id,
                order:       jobRef?.order,
                outwardDate: new Date(),
                // The weighted average, not the latest purchase price —
                // this row is what the order P&L costs the yarn at.
                unitPrice:   costOf(material),
                remarks:     jobRef ? `Issued to J-${jobRef.jobOrderNo}: ${reason}` : `Stock adjustment: ${reason}`,
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
                reason: `Stock adjustment: ${reason}`,
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
          // What the caller can put right, in its own words; a fault of
          // ours is logged and not read out (utils/routeError.js).
          const shown = asCallerError(err);
          if (shown?.name === "CastError") {
            errors.push({ id: item._id, error: "A reference on this line (a purchase order, a lot or a job) is not a valid one" });
          } else if (shown instanceof ErrorHandler || shown?.name === "ValidationError") {
            errors.push({ id: item._id, error: shown.message });
          } else {
            console.error(`[bulk-adjust-stock] ${item._id}:`, err);
            errors.push({ id: item._id, error: "This one could not be adjusted — try it again" });
          }
        }
      }
    } finally {
      await session.endSession();
    }

    // Moved from a spoken or typed line: what went through scores the reading.
    if (mongoose.Types.ObjectId.isValid(String(req.body?.aiSuggestion || "")) && updated.length === 1) {
      const u = updated[0]; const it = toProcess.find((a) => String(a._id) === String(u.id));
      await require("../services/aiLedger").settle(req.body.aiSuggestion, {
        accepted: { action: it?.action || (u.adjustment < 0 ? "issue" : "receive"), quantity: Math.abs(u.adjustment), material: String(u.id), job: it?.job ? String(it.job) : null },
        decidedBy: req.user?._id, expectSurface: "stores-voice", ignoreMissing: true,
      }).catch(() => {});
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
// ══════════════════════════════════════════════════════════════
//  GET /materials/adjust-history?days=30&category=&search=&page=1&limit=100
//
//  Every stock adjustment made by hand, newest first, across all
//  materials — who wrote what off, and why. The admin app's History
//  page (behind its stock-adjust screen) has always asked for this
//  address, and there was nothing here: the page could only say it had
//  failed to load, and the adjustments could be read one material at a
//  time in its ledger and nowhere together.
//
//  Read off the movements kept on each material, which hold the newest
//  of them (utils/stockLedger.js): a window of days, not all of history.
// ══════════════════════════════════════════════════════════════
const ADJUST_HISTORY = { days: [1, 370, 30], page: [1, 100000, 1], limit: [1, 200, 100] };

router.get(
  "/adjust-history",
  catchAsyncErrors(async (req, res, next) => {
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const asked = {};
    for (const [key, [min, max, fallback]] of Object.entries(ADJUST_HISTORY)) {
      const raw = one(req.query[key]);
      const n = raw === undefined || raw === "" ? fallback : Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        return next(new ErrorHandler(`${key} must be a whole number from ${min} to ${max}`, 400));
      }
      asked[key] = n;
    }
    const since = new Date(Date.now() - asked.days * factoryDay.DAY);
    const adjusted = { type: "STOCK_ADJUST", date: { $gte: since } };

    const materials = { stockMovements: { $elemMatch: adjusted } };
    const category = one(req.query.category);
    if (typeof category === "string" && category && category !== "All") materials.category = category;
    const search = typeof one(req.query.search) === "string" ? one(req.query.search).trim().slice(0, 100) : "";
    if (search) materials.name = { $regex: escapeRegex(search), $options: "i" };

    const [found] = await RawMaterial.aggregate([
      { $match: materials },
      { $project: { name: 1, category: 1, stock: 1, stockMovements: 1 } },
      { $unwind: "$stockMovements" },
      { $match: { "stockMovements.type": adjusted.type, "stockMovements.date": adjusted.date } },
      { $sort: { "stockMovements.date": -1, _id: 1 } },
      {
        $facet: {
          total: [{ $count: "n" }],
          rows: [
            { $skip: (asked.page - 1) * asked.limit },
            { $limit: asked.limit },
            {
              $project: {
                _id: 0,
                materialId: "$_id",
                materialName: "$name",
                category: 1,
                currentStock: "$stock",
                date: "$stockMovements.date",
                // Signed: what stock moved by (a write-off is negative).
                adjustment: "$stockMovements.quantity",
                balance: "$stockMovements.balance",
                reason: { $ifNull: ["$stockMovements.reason", ""] },
              },
            },
          ],
        },
      },
    ]);

    const total = found?.total?.[0]?.n || 0;
    res.json({
      success: true,
      total,
      page: asked.page,
      pages: Math.max(1, Math.ceil(total / asked.limit)),
      adjustments: found?.rows || [],
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /materials/ledger?id=&from=&to=
//
//  Stock movements for one material over a date range, with a
//  running balance and the balances on either side of the window.
//
//  The material detail page used to show the newest 50 rows off
//  the embedded stockMovements array and nothing else — no way to
//  ask about a month that had scrolled off. This reads the
//  uncapped inward/outward logs instead. See services/materialLedger.js.
//
//  from/to are optional and inclusive of whole local days.
// ─────────────────────────────────────────────────────────────
router.get(
  "/ledger",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id || !mongoose.Types.ObjectId.isValid(id))
      return next(new ErrorHandler("Material ID required", 400));

    const range = parseRange(req.query);
    const ledger = await materialLedger(id, range);
    res.json({ success: true, ...ledger });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /materials/ledger.pdf?id=&from=&to=
//
//  The same ledger as a printable SAP-style sheet. Same query
//  parameters as /ledger, so the web app can point the print link
//  at exactly the range that is on screen.
// ─────────────────────────────────────────────────────────────
router.get(
  "/ledger.pdf",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id || !mongoose.Types.ObjectId.isValid(id))
      return next(new ErrorHandler("Material ID required", 400));

    const range = parseRange(req.query);
    const ledger = await materialLedger(id, range);
    ledger.branding = await getPdfBranding();
    const pdf = await renderPdf('materialLedger', ledger);

    // A filename that says which material and which period, because
    // these get saved in a folder and opened again weeks later.
    const slug = String(ledger.material.name || "material")
      .replace(/[^\w\d]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "material";
    const period = [
      range.from ? factoryDay.ymd(range.from) : "start",
      range.to ? factoryDay.ymd(range.to) : "today",
    ].join("_to_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="stock-ledger-${slug}-${period}.pdf"`
    );
    return res.send(pdf);
  })
);

module.exports = router;

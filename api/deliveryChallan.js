const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated } = require("../middleware/auth");
const { escapeRegex } = require("../utils/escapeRegex");

const DeliveryChallan = require("../models/DeliveryChallan");
const Order           = require("../models/Order");
const Elastic         = require("../models/Elastic");
const StockMovement   = require("../models/StockMovement");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { applyMovement } = require("../utils/elasticStock");
const Customer          = require("../models/Customer");
const { enqueue }       = require("../utils/outbox");
const { nextNumber }    = require("../utils/sequence");
const PdfTemplate       = require("../models/PdfTemplate");
const { renderTemplatePdf } = require("../services/pdf/templateRenderer");
const { starterTemplate }   = require("../services/pdf/docTypes");
const { getPdfBranding }     = require("../services/documentSettings");
const { dcToContext }        = require("../services/pdf/dcContext");

// Every DC route requires a logged-in user. isAdmin gating is left
// per-route at the admin app's call sites' discretion — accounts /
// dispatch staff also create DCs.
router.use(isAuthenticated);

function currentFinancialYear() {
  const now     = new Date();
  const month   = now.getMonth();
  const year    = now.getFullYear();
  const fyStart = month >= 3 ? year : year - 1;
  return `${String(fyStart).slice(-2)}/${String(fyStart + 1).slice(-2)}`;
}

// Race-free per-(type, financial-year) sequence via an atomic counter,
// seeded once from the max already in the collection. The old
// read-max-then-+1 pattern let two concurrent creates draw the same
// sequence — the unique dcNumber index then failed one of them.
async function nextSeq(type, financialYear) {
  return nextNumber(`dc:${type}:${financialYear}`, async () => {
    const last = await DeliveryChallan
      .findOne({ type, financialYear })
      .sort({ sequence: -1 })
      .select("sequence")
      .lean();
    return last?.sequence ?? 0;
  });
}

function buildDcNumber(type, financialYear, sequence) {
  const prefix = type === "elastic" ? "E" : "M";
  return `${prefix}-${financialYear}-${String(sequence).padStart(4, "0")}`;
}

// ─────────────────────────────────────────────────────────────
//  Reverse the source DC_OUT movements for one DC item.
//
//  P0-1: refund equals SUM(source DC_OUT.applied), not item.quantity.
//  Skipped silently when no DC_OUT exists (DC predates the ledger).
// ─────────────────────────────────────────────────────────────
async function _refundDcItem(session, dc, item, reasonContext, userId) {
  if (!item.elastic) return "no elastic on item";

  const originals = await StockMovement.find({
    refType: "DeliveryChallan",
    refId:   dc._id,
    elastic: item.elastic,
    type:    "DC_OUT",
  }).session(session);

  if (originals.length === 0) {
    return "no source DC_OUT";
  }

  const refund = -originals.reduce(
    (s, m) => s + Number(m.applied || 0),
    0
  );
  if (refund <= 0) return "zero refund";

  await applyMovement(session, {
    elasticId: item.elastic,
    type:      "DC_CANCEL_RETURN",
    quantity:  +refund,
    refType:   "DeliveryChallan",
    refId:     dc._id,
    reason:    `${reasonContext}; reversal of ${originals.map((m) => m._id).join(",")}`,
    by:        userId,
  });
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Restore a reservation that was consumed by this DC item.
//  PR E: paired with _refundDcItem on cancel / delete.
// ─────────────────────────────────────────────────────────────
async function _restoreReservation(session, dc, item, reasonContext, userId) {
  if (!item.elastic) return null;
  const qty = Number(item.consumedFromReservation || 0);
  if (qty <= 0) return null;
  if (!dc.order) return null;

  const order = await Order.findById(dc.order).session(session);
  if (!order) {
    console.warn(
      `[dc] cannot restore reservation — order ${dc.order} not found for DC ${dc._id}`
    );
    return null;
  }

  // Bump the elastic's reservedStock back up.
  const elasticDoc = await Elastic.findById(item.elastic).session(session);
  if (elasticDoc) {
    elasticDoc.reservedStock = (Number(elasticDoc.reservedStock) || 0) + qty;
    await elasticDoc.save({ session });
  }

  // Top up the matching reservation entry on the order, or push a
  // new one if it had been pruned.
  const entry = (order.reservations || []).find(
    (r) => r.elastic.toString() === item.elastic.toString()
  );
  if (entry) {
    entry.quantity = (Number(entry.quantity) || 0) + qty;
  } else {
    order.reservations.push({ elastic: item.elastic, quantity: qty });
  }
  await order.save({ session });

  // Info-row on the ledger so the timeline shows the restore.
  await applyMovement(session, {
    elasticId: item.elastic,
    type:      "RESERVATION_HOLD",
    quantity:  +qty,
    refType:   "Order",
    refId:     order._id,
    reason:    `${reasonContext}; reservation restored`,
    by:        userId,
  });

  return { elastic: item.elastic, quantity: qty };
}

router.get(
  "/order-info",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Order id is required", 400));

    const order = await Order.findById(id)
      .populate("customer", "name phoneNumber gstin contactName")
      .populate("elasticOrdered.elastic", "name weaveType");

    if (!order) return next(new ErrorHandler("Order not found", 404));

    res.json({
      success: true,
      orderNo:  order.orderNo,
      customer: {
        name:    order.customer?.name         ?? "",
        phone:   order.customer?.phoneNumber  ?? "",
        gstin:   order.customer?.gstin        ?? "",
        contact: order.customer?.contactName  ?? "",
      },
      elastics: (order.elasticOrdered ?? []).map((e) => ({
        elasticId:   e.elastic?._id,
        elasticName: e.elastic?.name      ?? "",
        weaveType:   e.elastic?.weaveType ?? "",
        orderedQty:  e.quantity           ?? 0,
      })),
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  CREATE DC
//
//  PR E: when the DC is linked to an Approved/InProgress order
//  AND that order has matching reservations, split each item:
//    consumeFromReservation = min(item.quantity, reservedQty)
//    consumeFromStock        = item.quantity − consumeFromReservation
//
//  Stock-side DC_OUT is posted for the stock portion only. The
//  reservation portion decrements Elastic.reservedStock + the
//  Order.reservations entry and posts a RESERVATION_RELEASE info-row.
//  Both numbers are stored on each item for traceability and so the
//  cancel/delete paths can correctly restore reservations.
//
//  Falls back to the pre-PR-E behaviour (entire quantity deducted
//  from free stock) when:
//    • DC has no order ref, or
//    • the order is not in Approved/InProgress, or
//    • the order has no reservation entry for this elastic.
// ─────────────────────────────────────────────────────────────
router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const {
      type,
      orderId, orderNo,
      customerName, customerPhone, customerGstin, customerAddress,
      dispatchDate,
      vehicleNo, driverName, transporter, lrNumber,
      items = [],
      remarks,
      requestId,
    } = req.body;

    // Idempotency: a retried create must not cut a second challan and
    // double-move stock. Fast path; the unique requestId index is the
    // guarantee under race (also avoids burning a DC number on replays).
    if (requestId) {
      const existing = await DeliveryChallan.findOne({ requestId }).lean();
      if (existing) {
        return res.status(200).json({
          success: true, duplicate: true, dc: existing,
          message: "Already recorded (duplicate submit ignored)",
        });
      }
    }

    if (!type || !["elastic", "machine_part"].includes(type)) {
      return next(new ErrorHandler("type must be 'elastic' or 'machine_part'", 400));
    }
    if (!customerName?.trim()) {
      return next(new ErrorHandler("customerName is required", 400));
    }
    if (!items.length) {
      return next(new ErrorHandler("At least one item is required", 400));
    }

    const processedItems = items.map((item) => ({
      ...item,
      quantity: Number(item.quantity) || 0,
      rate:     Number(item.rate)     || 0,
      amount:   (Number(item.quantity) || 0) * (Number(item.rate) || 0),
      // Default both split fields to zero; the create transaction
      // populates them when the parent order has reservations.
      consumedFromReservation: 0,
      consumedFromStock:       0,
    }));
    const totalQuantity = processedItems.reduce((s, i) => s + i.quantity, 0);
    const totalAmount   = processedItems.reduce((s, i) => s + i.amount,   0);

    const financialYear = currentFinancialYear();
    const sequence      = await nextSeq(type, financialYear);
    const dcNumber      = buildDcNumber(type, financialYear, sequence);

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const [dc] = await DeliveryChallan.create([{
          dcNumber,
          type,
          financialYear,
          sequence,
          ...(requestId ? { requestId } : {}),
          order:           orderId   || undefined,
          orderNo:         orderNo   || undefined,
          customerName:    customerName.trim(),
          customerPhone:   customerPhone   || "",
          customerGstin:   customerGstin   || "",
          customerAddress: customerAddress || "",
          dispatchDate:    dispatchDate ? new Date(dispatchDate) : new Date(),
          vehicleNo:       vehicleNo   || "",
          driverName:      driverName  || "",
          transporter:     transporter || "",
          lrNumber:        lrNumber    || "",
          items:           processedItems,
          totalQuantity,
          totalAmount,
          remarks:         remarks || "",
          status:          "draft",
        }], { session });

        const fp = buildFingerprint(ACTION_CODES.DC_CREATED, {
          entityId: dc._id,
          actor:    actorFromRequest(req),
          meta: {
            dcNumber:      dc.dcNumber,
            type:          dc.type,
            customerName:  dc.customerName,
            orderNo:       dc.orderNo  || null,
            totalQuantity: dc.totalQuantity,
            totalAmount:   dc.totalAmount,
            itemCount:     processedItems.length,
          },
        });
        dc.fingerprints.push(fp);

        if (dc.type === "elastic") {
          // Resolve the parent order once. Only Approved/InProgress
          // orders participate in reservation consumption — per
          // user-confirmed scope decision.
          let orderDoc = null;
          if (dc.order) {
            orderDoc = await Order.findById(dc.order).session(session);
            if (orderDoc && !["Approved", "InProgress"].includes(orderDoc.status)) {
              orderDoc = null; // ignore reservations on closed orders
            }
          }

          for (let i = 0; i < dc.items.length; i++) {
            const item = dc.items[i];
            if (!item.elastic) continue;

            // Compute the reservation split if applicable.
            let consumeFromReservation = 0;
            if (orderDoc) {
              const entry = (orderDoc.reservations || []).find(
                (r) => r.elastic.toString() === item.elastic.toString()
              );
              const reservedQty = entry ? Number(entry.quantity) || 0 : 0;
              consumeFromReservation = Math.min(
                Number(item.quantity) || 0,
                reservedQty
              );
            }
            const consumeFromStock =
              Math.max(0, Number(item.quantity || 0) - consumeFromReservation);

            // Stock portion via the helper (with clamp).
            if (consumeFromStock > 0) {
              await applyMovement(session, {
                elasticId: item.elastic,
                type:      "DC_OUT",
                quantity:  -consumeFromStock,
                refType:   "DeliveryChallan",
                refId:     dc._id,
                by:        req.user?._id,
              });
            }

            // Reservation portion: decrement reservedStock + the
            // matching order entry; emit RESERVATION_RELEASE.
            if (consumeFromReservation > 0 && orderDoc) {
              const elasticDoc = await Elastic.findById(item.elastic).session(session);
              if (elasticDoc) {
                const current = Number(elasticDoc.reservedStock) || 0;
                elasticDoc.reservedStock = Math.max(0, current - consumeFromReservation);
                await elasticDoc.save({ session });
              }

              const entry = (orderDoc.reservations || []).find(
                (r) => r.elastic.toString() === item.elastic.toString()
              );
              if (entry) {
                entry.quantity = Math.max(0, (Number(entry.quantity) || 0) - consumeFromReservation);
              }

              await applyMovement(session, {
                elasticId: item.elastic,
                type:      "RESERVATION_RELEASE",
                quantity:  +consumeFromReservation,
                refType:   "Order",
                refId:     orderDoc._id,
                reason:    `DC ${dc.dcNumber} consumed reservation`,
                by:        req.user?._id,
              });
            }

            // Persist the split on the item.
            dc.items[i].consumedFromReservation = consumeFromReservation;
            dc.items[i].consumedFromStock       = consumeFromStock;
          }

          if (orderDoc) {
            // Prune zero-quantity reservation entries.
            orderDoc.reservations = (orderDoc.reservations || []).filter(
              (r) => Number(r.quantity || 0) > 0
            );
            await orderDoc.save({ session });
          }
        }

        // Outbox: the late-dispatch alert commits WITH the challan —
        // delivered (with retry) by the dispatcher, which re-checks
        // the promised-vs-dispatch dates (utils/outboxHandlers.js).
        if (orderId) {
          await enqueue(session, "dc.delayedDeliveryCheck", {
            dcId:    dc._id.toString(),
            orderId: String(orderId),
          });
        }

        await dc.save({ session });
        resp = { dc, fingerprint: fp };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      // Race with a concurrent duplicate submit: the unique requestId
      // index aborted this transaction (nothing applied) — return the
      // winner's challan idempotently.
      if (err?.code === 11000 && requestId) {
        const existing = await DeliveryChallan.findOne({ requestId }).lean();
        if (existing) {
          return res.status(200).json({
            success: true, duplicate: true, dc: existing,
            message: "Already recorded (duplicate submit ignored)",
          });
        }
      }
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.get(
  "/list",
  catchAsyncErrors(async (req, res) => {
    const { type, status, search = "", page = 1, limit = 20 } = req.query;

    const filter = {};
    if (type)   filter.type   = type;
    if (status) filter.status = status;
    if (search.trim()) {
      const or = [
        { dcNumber:     { $regex: escapeRegex(search), $options: "i" } },
        { customerName: { $regex: escapeRegex(search), $options: "i" } },
      ];
      const asNum = Number(search);
      if (Number.isFinite(asNum)) {
        or.push({ orderNo: asNum });
      }
      filter.$or = or;
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const skip  = (Number(page) - 1) * safeLimit;
    const [dcs, total] = await Promise.all([
      DeliveryChallan.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .select("-items"),
      DeliveryChallan.countDocuments(filter),
    ]);

    res.json({ success: true, dcs, total, page: Number(page) });
  })
);

router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const dc = await DeliveryChallan.findById(req.query.id)
      .populate("order",         "orderNo status")
      .populate("items.elastic", "name weaveType")
      .lean();

    if (!dc) return next(new ErrorHandler("Delivery Challan not found", 404));

    const fingerprints = (dc.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ success: true, dc: { ...dc, fingerprints } });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /dc/:id/pdf
//
//  Renders the delivery challan as a PDF using the visual template
//  designed in Settings → PDF Designer. Uses the admin's saved template
//  when it's enabled, otherwise the built-in starter layout — so a DC
//  PDF always downloads, and a custom design takes over once enabled.
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/pdf",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)) {
      return next(new ErrorHandler("Invalid delivery challan id", 400));
    }

    const dc = await DeliveryChallan.findById(id)
      .populate("items.elastic", "name")
      .lean();
    if (!dc) return next(new ErrorHandler("Delivery Challan not found", 404));

    const [branding, saved] = await Promise.all([
      getPdfBranding(),
      PdfTemplate.findOne({ docType: "delivery-challan" }).lean(),
    ]);
    const template = saved && saved.enabled ? saved : starterTemplate("delivery-challan");

    const context = dcToContext(dc, branding);
    const pdf = await renderTemplatePdf(template, context);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="DC-${(dc.dcNumber || id).replace(/[^\w.-]/g, "_")}.pdf"`
    );
    return res.send(pdf);
  })
);

router.patch(
  "/update-status",
  catchAsyncErrors(async (req, res, next) => {
    const { id, status } = req.body;
    const valid = ["draft", "dispatched", "delivered", "cancelled"];
    if (!valid.includes(status)) {
      return next(new ErrorHandler("Invalid status", 400));
    }

    const actionCode = {
      dispatched: ACTION_CODES.DC_DISPATCHED,
      delivered:  ACTION_CODES.DC_DELIVERED,
      cancelled:  ACTION_CODES.DC_CANCELLED,
    }[status] || ACTION_CODES.DC_STATUS_UPDATED;

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const dc = await DeliveryChallan.findById(id).session(session);
        if (!dc) throw new ErrorHandler("Delivery Challan not found", 404);

        const previousStatus = dc.status;
        if (previousStatus === status) {
          throw new ErrorHandler(`DC is already ${status}`, 400);
        }

        dc.status = status;

        const fp = buildFingerprint(actionCode, {
          entityId: dc._id,
          actor:    actorFromRequest(req),
          meta: {
            dcNumber:       dc.dcNumber,
            previousStatus,
            newStatus:      status,
          },
        });
        dc.fingerprints.push(fp);
        await dc.save({ session });

        if (
          status === "cancelled" &&
          previousStatus !== "cancelled" &&
          dc.type === "elastic"
        ) {
          for (const item of (dc.items || [])) {
            // Stock-side refund (P0-1: applied, not requested).
            await _refundDcItem(
              session,
              dc,
              item,
              `DC ${dc.dcNumber} cancelled`,
              req.user?._id
            );
            // Restore the reservation portion if any.
            await _restoreReservation(
              session,
              dc,
              item,
              `DC ${dc.dcNumber} cancelled`,
              req.user?._id
            );
          }
        }

        resp = { dc, fingerprint: fp };
      });
      res.json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ─────────────────────────────────────────────────────────────
//  DELETE DC  (draft only)
//
//  Reverses the original DC_OUT(s) by applied amount, and restores
//  any reservation that was consumed at create time.
// ─────────────────────────────────────────────────────────────
router.delete(
  "/delete",
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const dc = await DeliveryChallan.findById(req.query.id).session(session);
        if (!dc) throw new ErrorHandler("Delivery Challan not found", 404);
        if (dc.status !== "draft") {
          throw new ErrorHandler("Only draft challans can be deleted", 400);
        }

        if (dc.type === "elastic") {
          for (const item of (dc.items || [])) {
            await _refundDcItem(
              session,
              dc,
              item,
              `Draft DC ${dc.dcNumber} deleted`,
              req.user?._id
            );
            await _restoreReservation(
              session,
              dc,
              item,
              `Draft DC ${dc.dcNumber} deleted`,
              req.user?._id
            );
          }
        }

        const fp = buildFingerprint(ACTION_CODES.DC_DELETED, {
          entityId: dc._id,
          actor:    actorFromRequest(req),
          meta: {
            dcNumber:     dc.dcNumber,
            type:         dc.type,
            customerName: dc.customerName,
            status:       dc.status,
          },
        });
        console.log(
          `[dc/delete] ${fp.shortId} ${fp.label} actor=${fp.actor?.name} dc=${dc.dcNumber}`
        );

        await dc.deleteOne({ session });
        resp = { fingerprint: fp };
      });
      res.json({ success: true, message: "Deleted", ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /dc/otd-stats?days=90
//
//  On-time delivery: order-linked, non-cancelled DCs dispatched
//  in the window, compared against the parent order's supplyDate.
// ─────────────────────────────────────────────────────────────
router.get(
  "/otd-stats",
  catchAsyncErrors(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dcs = await DeliveryChallan.find({
      order: { $ne: null },
      status: { $ne: "cancelled" },
      dispatchDate: { $gte: since },
    })
      .populate("order", "orderNo supplyDate")
      .select("dcNumber orderNo customerName dispatchDate order")
      .lean();

    let onTime = 0;
    const late = [];
    let considered = 0;
    for (const dc of dcs) {
      const due = dc.order?.supplyDate ? new Date(dc.order.supplyDate) : null;
      if (!due) continue;
      considered += 1;
      const dispatched = new Date(dc.dispatchDate);
      const lateDays = Math.ceil((dispatched - due) / (24 * 60 * 60 * 1000));
      if (lateDays <= 0) onTime += 1;
      else
        late.push({
          dcNumber: dc.dcNumber,
          orderNo: dc.order?.orderNo ?? dc.orderNo,
          customerName: dc.customerName,
          dueDate: due,
          dispatchDate: dc.dispatchDate,
          lateDays,
        });
    }
    late.sort((a, b) => b.lateDays - a.lateDays);

    res.json({
      success: true,
      days,
      considered,
      onTime,
      lateCount: late.length,
      otdPct: considered > 0 ? Math.round((onTime / considered) * 100) : null,
      late: late.slice(0, 20),
    });
  })
);

module.exports = router;

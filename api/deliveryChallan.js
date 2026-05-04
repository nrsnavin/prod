const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const DeliveryChallan = require("../models/Deliverychallan ");
const Order           = require("../models/Order");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/** Returns "24/25" for April 2024 – March 2025, etc. */
function currentFinancialYear() {
  const now     = new Date();
  const month   = now.getMonth(); // 0-indexed; April = 3
  const year    = now.getFullYear();
  const fyStart = month >= 3 ? year : year - 1;
  return `${String(fyStart).slice(-2)}/${String(fyStart + 1).slice(-2)}`;
}

/** Next available sequence number for this type + FY combination. */
async function nextSeq(type, financialYear) {
  const last = await DeliveryChallan
    .findOne({ type, financialYear })
    .sort({ sequence: -1 })
    .select("sequence")
    .lean();
  return (last?.sequence ?? 0) + 1;
}

/** E-24/25-0001  or  M-24/25-0001 */
function buildDcNumber(type, financialYear, sequence) {
  const prefix = type === "elastic" ? "E" : "M";
  return `${prefix}-${financialYear}-${String(sequence).padStart(4, "0")}`;
}

// ─────────────────────────────────────────────────────────────
//  GET ORDER INFO (pre-fill helper for Flutter form)
//  GET /api/v2/dc/order-info?id=<orderId>
// ─────────────────────────────────────────────────────────────
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
//  POST /api/v2/dc/create
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
    } = req.body;

    // ── Basic validation ──────────────────────────────────────
    if (!type || !["elastic", "machine_part"].includes(type)) {
      return next(new ErrorHandler("type must be 'elastic' or 'machine_part'", 400));
    }
    if (!customerName?.trim()) {
      return next(new ErrorHandler("customerName is required", 400));
    }
    if (!items.length) {
      return next(new ErrorHandler("At least one item is required", 400));
    }

    // ── Compute amounts ───────────────────────────────────────
    const processedItems = items.map((item) => ({
      ...item,
      quantity: Number(item.quantity) || 0,
      rate:     Number(item.rate)     || 0,
      amount:   (Number(item.quantity) || 0) * (Number(item.rate) || 0),
    }));
    const totalQuantity = processedItems.reduce((s, i) => s + i.quantity, 0);
    const totalAmount   = processedItems.reduce((s, i) => s + i.amount,   0);

    // ── Generate DC number (atomic-safe for single instance) ──
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

        // 🪪 Fingerprint: DC_CREATED
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
        await dc.save({ session });

        resp = { dc, fingerprint: fp };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ─────────────────────────────────────────────────────────────
//  LIST DCs
//  GET /api/v2/dc/list?type=&status=&search=&page=&limit=
// ─────────────────────────────────────────────────────────────
router.get(
  "/list",
  catchAsyncErrors(async (req, res) => {
    const { type, status, search = "", page = 1, limit = 20 } = req.query;

    const filter = {};
    if (type)   filter.type   = type;
    if (status) filter.status = status;
    if (search.trim()) {
      filter.$or = [
        { dcNumber:     { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { orderNo:      !isNaN(search) ? Number(search) : undefined },
      ].filter((c) => Object.values(c)[0] !== undefined);
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const [dcs, total] = await Promise.all([
      DeliveryChallan.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(search ? 0 : Number(limit))
        .select("-items"), // omit items in list view
      DeliveryChallan.countDocuments(filter),
    ]);

    res.json({ success: true, dcs, total, page: Number(page) });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET DC DETAIL
//  GET /api/v2/dc/detail?id=
// ─────────────────────────────────────────────────────────────
router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const dc = await DeliveryChallan.findById(req.query.id)
      .populate("order",         "orderNo status")
      .populate("items.elastic", "name weaveType")
      .lean();

    if (!dc) return next(new ErrorHandler("Delivery Challan not found", 404));

    // 🪪 Newest-first feed for the timeline UI
    const fingerprints = (dc.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ success: true, dc: { ...dc, fingerprints } });
  })
);

// ─────────────────────────────────────────────────────────────
//  UPDATE STATUS
//  PATCH /api/v2/dc/update-status  { id, status }
// ─────────────────────────────────────────────────────────────
router.patch(
  "/update-status",
  catchAsyncErrors(async (req, res, next) => {
    const { id, status } = req.body;
    const valid = ["draft", "dispatched", "delivered", "cancelled"];
    if (!valid.includes(status)) {
      return next(new ErrorHandler("Invalid status", 400));
    }

    // Specialised action code per terminal status — keeps the
    // timeline scannable and lets the UI colour-code transitions.
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
          // No-op — still record an entry so the operator's intent
          // is captured (e.g. retry click), but skip the write
          throw new ErrorHandler(`DC is already ${status}`, 400);
        }

        dc.status = status;

        // 🪪 Status-change fingerprint
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
//  DELETE /api/v2/dc/delete?id=
// ─────────────────────────────────────────────────────────────
router.delete(
  "/delete",
  catchAsyncErrors(async (req, res, next) => {
    const dc = await DeliveryChallan.findById(req.query.id);
    if (!dc) return next(new ErrorHandler("Delivery Challan not found", 404));
    if (dc.status !== "draft") {
      return next(new ErrorHandler("Only draft challans can be deleted", 400));
    }

    // 🪪 Record DC_DELETED before the doc is gone so the action
    //    is preserved in server logs even though the embedded
    //    timeline disappears with the document.
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
    console.log(`[dc/delete] ${fp.shortId} ${fp.label} actor=${fp.actor?.name} dc=${dc.dcNumber}`);

    await dc.deleteOne();
    res.json({ success: true, message: "Deleted", fingerprint: fp });
  })
);

module.exports = router;
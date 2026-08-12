const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { requireReason } = require("../utils/auditReason");
const { escapeRegex } = require("../utils/escapeRegex");

const DeliveryChallan = require("../models/DeliveryChallan");
const Order           = require("../models/Order");
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
//  Undo one despatched DC item: goods back on the shelf, and the
//  promise the despatch discharged put back on the order.
//
//  Both halves are computed from the SAME source — the DC_OUT rows
//  this challan wrote — because they are two sides of one movement.
//  Reading the movements rather than the item is what makes the goods
//  refund correct when the original despatch was clamped by the zero
//  floor: it puts back what actually left, not what was asked for.
//
//  The promise only goes back if an order can hold it. An elastic
//  whose reservedStock is raised with no order entry behind it is
//  stock nobody can sell and no order is waiting for, so when the
//  order has gone or closed the goods return and the reservation does
//  not — reported, not silently dropped.
//
//  Skipped when no DC_OUT exists (a DC that predates the ledger).
// ─────────────────────────────────────────────────────────────
async function _reverseDcItem(session, dc, item, reasonContext, userId) {
  if (!item.elastic) return { skipped: "no elastic on item" };

  // BOTH movement types this challan can write, netted — not the
  // DC_OUT rows alone.
  //
  // A challan can be edited more than once, and each edit reverses and
  // re-applies, so after two edits the ledger holds three rows for one
  // line: DC_OUT, DC_CANCEL_RETURN, DC_OUT. Summing only the DC_OUTs
  // refunds every despatch the line has ever made, including the ones
  // already given back — a second edit invented stock that had never
  // existed, and a cancel after two edits returned more than the
  // opening balance.
  //
  // The net of every row IS what this challan currently has out, which
  // is exactly what a reversal owes. It is also self-correcting: run it
  // against an already-reversed line and the net is zero, so there is
  // nothing to give back and nothing is written.
  const rows = await StockMovement.find({
    refType: "DeliveryChallan",
    refId:   dc._id,
    elastic: item.elastic,
    type:    { $in: ["DC_OUT", "DC_CANCEL_RETURN"] },
  }).session(session);

  const outs = rows.filter((m) => m.type === "DC_OUT");
  if (outs.length === 0) return { skipped: "no source DC_OUT" };

  const refund = -rows.reduce((s, m) => s + Number(m.applied || 0), 0);

  // A despatch made before DC_OUT carried a reserved figure recorded
  // the split on the item instead. Fall back to it rather than reading
  // an absent field as "no reservation was consumed" — that would
  // strand the promise on every DC cut before this change.
  const ledgerReserved = rows.reduce(
    (s, m) => s + Number(m.reservedApplied || 0), 0
  );
  const reReserve = ledgerReserved !== 0
    ? -ledgerReserved
    : Number(item.consumedFromReservation || 0);

  // Whether the order can take the promise back.
  let order = null;
  if (reReserve > 0 && dc.order) {
    order = await Order.findById(dc.order).session(session);
    if (order && !["Approved", "InProgress"].includes(order.status)) order = null;
  }
  const restoring = order ? reReserve : 0;
  const strandedReservation = reReserve > 0 && !order ? reReserve : 0;

  if (refund <= 0 && restoring <= 0) return { skipped: "zero refund" };

  await applyMovement(session, {
    elasticId:        item.elastic,
    type:             "DC_CANCEL_RETURN",
    quantity:         +refund,
    reservedQuantity: +restoring,
    refType:          "DeliveryChallan",
    refId:            dc._id,
    reason: strandedReservation > 0
      ? `${reasonContext}; goods returned, ${strandedReservation} reservation not restored (order closed or gone)`
      : `${reasonContext}; reversal of ${outs.map((m) => m._id).join(",")}`,
    by:               userId,
  });

  // The order's own entry, kept in step with the elastic's balance.
  if (order && restoring > 0) {
    const entry = (order.reservations || []).find(
      (r) => r.elastic.toString() === item.elastic.toString()
    );
    if (entry) {
      entry.quantity = (Number(entry.quantity) || 0) + restoring;
    } else {
      // Pruned when it hit zero on despatch; it is owed again now.
      order.reservations.push({ elastic: item.elastic, quantity: restoring });
    }
    await order.save({ session });
  }

  if (strandedReservation > 0) {
    console.warn(
      `[dc] DC ${dc.dcNumber}: returned ${refund} to stock but did not restore ` +
      `${strandedReservation} of reservation — order ${dc.order} is closed or missing.`
    );
  }

  return { refund, restored: restoring, strandedReservation };
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
//  Everything on the challan leaves the building, so the whole
//  quantity comes off stock — always, in one DC_OUT.
//
//  When the DC is linked to an Approved/InProgress order holding a
//  reservation for the elastic, that despatch also DISCHARGES the
//  promise, up to what was reserved:
//    consumeFromReservation = min(item.quantity, reservedQty)
//    consumeFromStock       = item.quantity − consumeFromReservation
//  Both figures are stored on the item: they say how much of this
//  shipment was against a promise and how much came out of free
//  stock, which is what the order and the sales team each want to
//  know. They are NOT two piles to ship from — that reading is what
//  made a fully reserved order despatch without stock moving at all.
//
//  With no reservation to discharge (no order ref, a closed order, or
//  no entry for this elastic) the goods still leave; there is simply
//  no promise to settle.
// ─────────────────────────────────────────────────────────────
/**
 * Take the goods out and settle the promise, for every line on a DC.
 *
 * Extracted from /create so that /update can re-apply exactly what
 * create applied. Two copies of reservation splitting is precisely how
 * the two drift, and a despatch that consumes a reservation on one path
 * and not the other leaves the order owing goods it has already had.
 *
 * Writes `consumedFromReservation` / `consumedFromStock` back onto each
 * item, so a later reversal can read what this despatch actually did.
 */
async function _applyDcItems(session, dc, userId) {
  if (dc.type !== "elastic") return;
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
      const shipped = Number(item.quantity) || 0;
      const consumeFromStock = Math.max(0, shipped - consumeFromReservation);

      // ONE movement for the whole despatch.
      //
      // The quantity that left the building is `shipped`, all of
      // it, however much of it had been promised to the order. A
      // reservation is a claim on the goods, not a second pile to
      // ship from — but this used to post DC_OUT for the stock
      // portion only and merely release the promise for the rest,
      // so a fully reserved order shipped its entire quantity
      // without the stock figure moving at all. The warehouse
      // went on listing goods that were on a lorry.
      //
      // `reservedQuantity` settles the promise on the same row:
      // goods out, claim discharged, both balances stated.
      if (shipped > 0) {
        await applyMovement(session, {
          elasticId:        item.elastic,
          type:             "DC_OUT",
          quantity:         -shipped,
          reservedQuantity: -consumeFromReservation,
          refType:          "DeliveryChallan",
          refId:            dc._id,
          reason: consumeFromReservation > 0
            ? `DC ${dc.dcNumber}; ${consumeFromReservation} against order reservation`
            : `DC ${dc.dcNumber}`,
          by:               userId,
        });
      }

      // The order's own reservation entry shrinks by what this
      // despatch fulfilled, so a part-delivered order still holds
      // the balance it is owed.
      if (consumeFromReservation > 0 && orderDoc) {
        const entry = (orderDoc.reservations || []).find(
          (r) => r.elastic.toString() === item.elastic.toString()
        );
        if (entry) {
          entry.quantity = Math.max(0, (Number(entry.quantity) || 0) - consumeFromReservation);
        }
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

    // An elastic line must IDENTIFY its elastic, not merely name it.
    //
    // Everything downstream keys on the id: _applyDcItems skips a line
    // without one, so no stock moves and no reservation is settled, and
    // the order's delivered figure sums by it, so the despatch never
    // appears against the order. A name-only line was accepted by this
    // route and then quietly ignored by both — the challan printed, the
    // goods went out of the gate, and as far as the system was concerned
    // nothing had happened. That is the worst of the three possible
    // outcomes, and it is the one we had.
    //
    // Machine parts are free text by nature and are not checked.
    if (type === "elastic") {
      const nameless = items.findIndex((item) => !item?.elastic);
      if (nameless !== -1) {
        const shown =
          items[nameless]?.elasticName || items[nameless]?.description || "";
        return next(new ErrorHandler(
          `Line ${nameless + 1}${shown ? ` ("${shown}")` : ""} does not say which ` +
          `elastic it is. Pick the product rather than typing its name — a line ` +
          `without it moves no stock and never reaches the order.`,
          400
        ));
      }
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
          await _applyDcItems(session, dc, req.user?._id);
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

// ─────────────────────────────────────────────────────────────
//  PUT /update — edit a challan, moving the stock with it
//
//  A DC takes goods off the shelf and settles part of the order's
//  reservation the moment it is cut. So an edit is not a text change:
//  changing a quantity has to move stock, and changing the elastic has
//  to put one product back and take another out.
//
//  Done by REVERSING every line and re-applying the new ones, rather
//  than computing a per-line delta. The reversal already exists — it is
//  what cancelling a DC does — and the re-application is the same
//  helper /create uses. A delta calculation would be a third way of
//  doing the same arithmetic, and the first to disagree with the other
//  two would do so silently, in stock.
//
//  Both halves run inside one transaction, so a failure between them
//  cannot leave the goods returned and never re-issued.
//
//  ── What cannot be edited ────────────────────────────────────────
//  A DELIVERED challan: the customer has the goods and has signed for
//  them; the note is their receipt, not our working copy. A CANCELLED
//  one: its stock has already gone back, and editing it would re-issue
//  goods against a document that says nothing was sent. Both are
//  refused by name rather than silently ignored.
// ─────────────────────────────────────────────────────────────
router.put(
  "/update",
  isAdmin("admin", "accounts"),
  catchAsyncErrors(async (req, res, next) => {
    const { id, items, dispatchDate, vehicleNo, driverName, transporter,
            lrNumber, remarks, customerName } = req.body || {};
    if (!id) return next(new ErrorHandler("id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid challan id", 400));
    }
    const auditReason = requireReason(req);
    if (!auditReason) {
      return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));
    }

    const changingItems = Array.isArray(items);
    if (changingItems) {
      if (items.length === 0) {
        return next(new ErrorHandler(
          "A challan needs at least one line — cancel it instead", 400
        ));
      }
      for (const [i, item] of items.entries()) {
        const q = Number(item?.quantity);
        if (!Number.isFinite(q) || q <= 0) {
          return next(new ErrorHandler(
            `items[${i}].quantity must be a positive number`, 400
          ));
        }
      }
    }

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const dc = await DeliveryChallan.findById(id).session(session);
        if (!dc) throw new ErrorHandler("Delivery Challan not found", 404);

        if (dc.status === "delivered") {
          throw new ErrorHandler(
            `DC ${dc.dcNumber} has been delivered — the customer holds it as their ` +
            `receipt. Raise a fresh challan for a correction.`, 409
          );
        }
        if (dc.status === "cancelled") {
          throw new ErrorHandler(
            `DC ${dc.dcNumber} is cancelled and its stock has already gone back. ` +
            `Raise a new challan instead.`, 409
          );
        }

        const before = {
          items: (dc.items || []).map((i) => ({
            elastic:  i.elastic ? String(i.elastic) : null,
            name:     i.elasticName || i.description || "",
            quantity: i.quantity,
            rate:     i.rate,
          })),
          totalQuantity: dc.totalQuantity,
          totalAmount:   dc.totalAmount,
        };

        if (changingItems) {
          // 1. Put back everything this challan took. Same reversal the
          //    cancel path uses, so the two cannot disagree.
          for (const item of dc.items || []) {
            await _reverseDcItem(
              session, dc, item, `DC ${dc.dcNumber} edited`, req.user?._id
            );
          }

          // 2. Replace the lines.
          dc.items = items.map((item) => ({
            elastic:     item.elastic || undefined,
            elasticName: item.elasticName || "",
            description: item.description || "",
            unit:        item.unit || "m",
            quantity:    Number(item.quantity) || 0,
            rate:        Number(item.rate) || 0,
            amount:      (Number(item.quantity) || 0) * (Number(item.rate) || 0),
            // Recomputed by the re-application below; a stale split
            // would make the NEXT reversal put back the wrong figure.
            consumedFromReservation: 0,
            consumedFromStock:       0,
          }));
          dc.totalQuantity = dc.items.reduce((s, i) => s + i.quantity, 0);
          dc.totalAmount   = dc.items.reduce((s, i) => s + i.amount,   0);

          // 3. Take the new lines out again, through the same helper
          //    /create uses.
          await _applyDcItems(session, dc, req.user?._id);
        }

        // ── The despatch detail ─────────────────────────────────────
        if (customerName !== undefined) dc.customerName = String(customerName).trim();
        if (dispatchDate !== undefined) {
          const d = dispatchDate ? new Date(dispatchDate) : null;
          if (d && !isNaN(d.getTime())) dc.dispatchDate = d;
        }
        if (vehicleNo   !== undefined) dc.vehicleNo   = String(vehicleNo).trim();
        if (driverName  !== undefined) dc.driverName  = String(driverName).trim();
        if (transporter !== undefined) dc.transporter = String(transporter).trim();
        if (lrNumber    !== undefined) dc.lrNumber    = String(lrNumber).trim();
        if (remarks     !== undefined) dc.remarks     = String(remarks).trim();

        const fp = buildFingerprint(ACTION_CODES.DC_STATUS_UPDATED, {
          entityId: dc._id,
          actor:    actorFromRequest(req),
          meta: {
            change:   "edited",
            dcNumber: dc.dcNumber,
            auditReason,
            before,
            after: {
              items: (dc.items || []).map((i) => ({
                elastic:  i.elastic ? String(i.elastic) : null,
                name:     i.elasticName || i.description || "",
                quantity: i.quantity,
                rate:     i.rate,
              })),
              totalQuantity: dc.totalQuantity,
              totalAmount:   dc.totalAmount,
            },
          },
        });
        dc.fingerprints.push(fp);
        await dc.save({ session });

        resp = { dc, fingerprint: fp };
      });
      res.json({ success: true, message: "Delivery challan updated", ...resp });
    } catch (err) {
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
            // Goods back on the shelf and the order's promise with
            // them, off the DC_OUT rows this challan wrote.
            await _reverseDcItem(
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
            await _reverseDcItem(
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

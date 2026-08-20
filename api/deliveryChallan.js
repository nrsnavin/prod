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
const JobOrder        = require("../models/JobOrder");
const StockMovement   = require("../models/StockMovement");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { applyMovement } = require("../utils/elasticStock");
const Customer          = require("../models/Customer");
const { enqueue }       = require("../utils/outbox");
const { nextNumber }    = require("../utils/sequence");
const { currentFinancialYear } = require("../utils/financialYear");
const PdfTemplate       = require("../models/PdfTemplate");
const { renderTemplatePdf } = require("../services/pdf/templateRenderer");
const { starterTemplate }   = require("../services/pdf/docTypes");
const { getPdfBranding }     = require("../services/documentSettings");
const { dcToContext }        = require("../services/pdf/dcContext");

// The whole router is already behind `gate('accounts')` where it is
// mounted in app.js — i.e. isAuthenticated + isAdmin('admin',
// 'accounts') — so every route below is admin-or-accounts already, and
// no per-route role check here can narrow that further for any role
// that can reach it. This line is belt-and-braces on the authentication
// half; the `isAdmin("admin", "accounts")` on /update is likewise
// redundant with the mount and kept only so the route reads honestly on
// its own.
router.use(isAuthenticated);

// Shared with the quote router — see utils/financialYear.js.

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

const DC_STATUSES = ["draft", "dispatched", "delivered", "cancelled"];

/**
 * Where a challan may go from where it is.
 *
 * `/update-status` accepted ANY status from ANY status, refusing only a
 * move to the one it was already in. Two of the transitions that opened
 * up are not merely untidy:
 *
 *   cancelled → dispatched   Cancelling reverses the DC_OUT and puts
 *                            the goods back on the shelf. Nothing
 *                            re-applies them on the way out again, so
 *                            the challan read "dispatched" while the
 *                            warehouse counted the goods as in stock.
 *                            Issued on paper, present in the ledger.
 *
 *   delivered → cancelled    Returns goods the customer has taken
 *                            delivery of and signed for. `/update`
 *                            already refuses to touch a delivered
 *                            challan for exactly that reason — "the
 *                            customer holds it as their receipt" — so
 *                            the same document was protected at one
 *                            door and not the other.
 *
 * Delivered and cancelled are terminal. Both are corrected by raising a
 * fresh challan, which is what `/update` already tells people to do.
 * This is the machine the web has always drawn; it simply was not the
 * one the server enforced.
 */
const DC_TRANSITIONS = Object.freeze({
  draft:      ["dispatched", "cancelled"],
  dispatched: ["delivered", "cancelled"],
  delivered:  [],
  cancelled:  [],
});

/**
 * Normalise and check the lines on a challan.
 *
 * Shared by `/create` and `/update`, because each of them was enforcing
 * what the other missed:
 *
 *   /create  refused an elastic line with no elastic id — and spelled
 *            out why at length — but accepted a quantity of any sign.
 *   /update  refused a quantity that was not positive, but built its
 *            items with `elastic: item.elastic || undefined` and so
 *            reopened the exact hole /create documents closing.
 *
 * So a challan that could not be CUT with a nameless line could be
 * edited into one, and a quantity that could not be edited to −5 could
 * be created that way. One function, both doors.
 */
function readDcItems(raw, type) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ErrorHandler("At least one item is required", 400);
  }

  return raw.map((item, i) => {
    // An elastic line must IDENTIFY its elastic, not merely name it.
    //
    // Everything downstream keys on the id: _applyDcItems skips a line
    // without one, so no stock moves and no reservation is settled, and
    // the order's delivered figure sums by it, so the despatch never
    // appears against the order. A name-only line printed a challan,
    // the goods went out of the gate, and as far as the system was
    // concerned nothing had happened — the worst of the three possible
    // outcomes, and the one we had.
    //
    // Machine parts are free text by nature and are not checked.
    if (type === "elastic") {
      if (!item?.elastic) {
        const shown = item?.elasticName || item?.description || "";
        throw new ErrorHandler(
          `Line ${i + 1}${shown ? ` ("${shown}")` : ""} does not say which ` +
          `elastic it is. Pick the product rather than typing its name — a line ` +
          `without it moves no stock and never reaches the order.`,
          400
        );
      }
      if (!mongoose.Types.ObjectId.isValid(item.elastic)) {
        throw new ErrorHandler(`Line ${i + 1}: that is not a valid elastic`, 400);
      }
    }

    const quantity = Number(item?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ErrorHandler(
        `Line ${i + 1}: quantity must be a positive number`, 400
      );
    }

    // A negative rate makes a negative amount, which flows into
    // totalAmount and out onto the printed challan. Zero is ordinary —
    // plenty of challans carry no prices at all.
    const rate = item?.rate === undefined || item?.rate === null || item?.rate === ""
      ? 0
      : Number(item.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new ErrorHandler(`Line ${i + 1}: rate cannot be negative`, 400);
    }

    return {
      elastic:     item.elastic || undefined,
      elasticName: item.elasticName || "",
      description: item.description || "",
      unit:        item.unit || "m",
      quantity,
      rate,
      amount:      quantity * rate,
      // Populated by _applyDcItems. Zeroed here on every path: a stale
      // split would make the NEXT reversal put back the wrong figure.
      consumedFromReservation: 0,
      consumedFromStock:       0,
    };
  });
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

/**
 * The order, shaped the way the "new DC" form needs it.
 *
 * Shared by /order-info (picked from the search box) and /job-order
 * (arrived at by scanning a job label), because the two have to agree.
 * A field added to one and not the other is a form that fills in
 * differently depending on which way the person got there, and that is
 * exactly the kind of difference nobody notices until a challan goes
 * out with a blank GSTIN on it.
 */
function orderInfoPayload(order) {
  return {
    orderNo:  order.orderNo,
    // The form does not gate on this, and neither does /create — a
    // closed order still despatches, it simply has no reservation left
    // to discharge (see _applyDcItems). It is reported so the screen
    // can SAY so, rather than quietly behaving differently.
    orderStatus: order.status ?? "",
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
  };
}

const populateOrderForDc = (q) => q
  .populate("customer", "name phoneNumber gstin contactName")
  .populate("elasticOrdered.elastic", "name weaveType");

router.get(
  "/order-info",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Order id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return next(new ErrorHandler("Invalid order id", 400));
    }

    const order = await populateOrderForDc(Order.findById(id));
    if (!order) return next(new ErrorHandler("Order not found", 404));

    res.json({ success: true, ...orderInfoPayload(order) });
  })
);

// ─────────────────────────────────────────────────────────────
//  THE ORDER BEHIND A SCANNED JOB LABEL
//
//  The person raising a challan is standing at a trolley with the job
//  label taped to it, and the challan is raised against the ORDER. So
//  the label — which names a job — has to be resolved one hop further
//  before it is any use here.
//
//  ── Why the server does the hop ────────────────────────────────
//  The obvious client-side version is: fetch the job, read its order
//  id, fetch the order. That is two round trips over a mill wifi for
//  something the database joins for free, and it leaves the phone
//  holding a half-resolved state if the second call fails — an order
//  id with no order, which the form has no way to render.
//
//  ── What comes back ────────────────────────────────────────────
//  The order, in exactly the shape /order-info returns, PLUS the lines
//  this particular job covers. The order may span several jobs; the
//  trolley holds one. Sending the job's own lines lets the form open
//  with that job's elastics ticked and its PACKED quantities filled
//  in, instead of the whole order's ordered quantities — which is the
//  difference between filling in the order and filling in the
//  despatch.
//
//  Quantities are directly comparable: Order.elasticOrdered.quantity
//  and JobOrder.packedElastic.quantity are both in the elastic's own
//  unit (meters). See models/Order.js.
// ─────────────────────────────────────────────────────────────
router.get(
  "/job-order",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, jobNo } = req.query;

    // The label carries an id; a hand-typed fallback carries a number.
    // Exactly one, so a request that means two things is rejected
    // rather than silently resolved by parameter order.
    const hasId = jobId !== undefined && String(jobId).trim() !== "";
    const hasNo = jobNo !== undefined && String(jobNo).trim() !== "";
    if (hasId === hasNo) {
      return next(new ErrorHandler("Give exactly one of jobId or jobNo", 400));
    }

    let job;
    if (hasId) {
      if (!mongoose.Types.ObjectId.isValid(String(jobId).trim())) {
        return next(new ErrorHandler("Invalid job id", 400));
      }
      job = await JobOrder.findById(String(jobId).trim())
        .select("jobOrderNo status order elastics packedElastic")
        .lean();
      if (!job) {
        return next(new ErrorHandler(
          "That label was read, but no job with that id exists.", 404));
      }
    } else {
      const n = Number(String(jobNo).trim());
      if (!Number.isInteger(n) || n <= 0) {
        return next(new ErrorHandler("Invalid job number", 400));
      }
      // jobOrderNo comes from an auto-increment counter, so duplicates
      // mean the data has been through surgery. Picking one anyway
      // could load a DIFFERENT customer's order onto a challan, so it
      // asks rather than guesses.
      const hits = await JobOrder.find({ jobOrderNo: n })
        .select("jobOrderNo status order elastics packedElastic")
        .limit(2)
        .lean();
      if (hits.length === 0) {
        return next(new ErrorHandler(`No job numbered ${n}.`, 404));
      }
      if (hits.length > 1) {
        return next(new ErrorHandler(
          `More than one job is numbered ${n}. Pick the order by hand.`, 409));
      }
      job = hits[0];
    }

    // `order` is required on JobOrder, so a missing one here means the
    // order document was deleted out from under the job rather than
    // that this job never had one — worth saying, because "order not
    // found" on a good label reads as a broken scanner.
    if (!job.order) {
      return next(new ErrorHandler(
        `Job #${job.jobOrderNo} is not linked to an order.`, 409));
    }

    const order = await populateOrderForDc(Order.findById(job.order));
    if (!order) {
      return next(new ErrorHandler(
        `Job #${job.jobOrderNo} points at an order that no longer exists.`, 404));
    }

    const qtyByElastic = new Map();
    for (const e of job.packedElastic ?? []) {
      if (e?.elastic) qtyByElastic.set(String(e.elastic), e.quantity ?? 0);
    }

    res.json({
      success: true,
      orderId: String(order._id),
      ...orderInfoPayload(order),
      job: {
        id:         String(job._id),
        jobOrderNo: job.jobOrderNo ?? null,
        status:     job.status ?? "",
      },
      // What this job planned and what it actually packed, per elastic.
      // packedQty is 0 until the job reaches packing — a real answer,
      // not a missing one, and the form says which it is rather than
      // prefilling a zero that looks like a typed figure.
      jobLines: (job.elastics ?? [])
        .filter((e) => e?.elastic)
        .map((e) => ({
          elasticId:  String(e.elastic),
          plannedQty: e.quantity ?? 0,
          packedQty:  qtyByElastic.get(String(e.elastic)) ?? 0,
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
      // `orderNo` is deliberately NOT read from the body — it is looked
      // up from `orderId` below, so the challan cannot carry a number
      // that disagrees with the order it points at.
      orderId,
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
    let processedItems;
    try {
      processedItems = readDcItems(items, type);
    } catch (err) {
      return next(err);
    }
    const totalQuantity = processedItems.reduce((s, i) => s + i.quantity, 0);
    const totalAmount   = processedItems.reduce((s, i) => s + i.amount,   0);

    // The order number is READ off the order, not taken on trust.
    //
    // `orderNo` came straight from the request body while `order` was
    // the id, so the two could disagree — and they are the same fact.
    // /list searches on the snapshot, so a mistyped number made the
    // challan unfindable by the order it was actually cut against.
    let linkedOrder = null;
    if (orderId) {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return next(new ErrorHandler("Invalid order id", 400));
      }
      linkedOrder = await Order.findById(orderId).select("orderNo").lean();
      if (!linkedOrder) {
        return next(new ErrorHandler("Order not found", 404));
      }
    }
    const resolvedOrderNo = linkedOrder ? linkedOrder.orderNo : undefined;

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
          orderNo:         resolvedOrderNo,
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
    if (changingItems && items.length === 0) {
      return next(new ErrorHandler(
        "A challan needs at least one line — cancel it instead", 400
      ));
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
          // Validated against the challan's OWN type, before anything
          // moves. This used to build the lines inline with
          // `elastic: item.elastic || undefined`, which reopened the
          // exact hole /create closes: an elastic line with no id moves
          // no stock and never reaches the order, so an edit could turn
          // a working challan into one the system does not see.
          const nextItems = readDcItems(items, dc.type);

          // 1. Put back everything this challan took. Same reversal the
          //    cancel path uses, so the two cannot disagree.
          for (const item of dc.items || []) {
            await _reverseDcItem(
              session, dc, item, `DC ${dc.dcNumber} edited`, req.user?._id
            );
          }

          // 2. Replace the lines.
          dc.items = nextItems;
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
  catchAsyncErrors(async (req, res, next) => {
    const { type, status, search = "" } = req.query;

    // Validated rather than passed through. An unknown status matched
    // nothing and answered with an empty list, which reads to the caller
    // exactly like a filter that legitimately found no challans.
    const filter = {};
    if (type) {
      if (!["elastic", "machine_part"].includes(type)) {
        return next(new ErrorHandler(`Invalid type: ${type}`, 400));
      }
      filter.type = type;
    }
    if (status) {
      if (!DC_STATUSES.includes(status)) {
        return next(new ErrorHandler(`Invalid status: ${status}`, 400));
      }
      filter.status = status;
    }
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

    // `limit` was clamped and `page` was not, so `page=0` produced a
    // negative skip — which Mongo rejects outright.
    const safePage  = Math.max(Number(req.query.page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const skip  = (safePage - 1) * safeLimit;
    const [dcs, total] = await Promise.all([
      DeliveryChallan.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .select("-items"),
      DeliveryChallan.countDocuments(filter),
    ]);

    res.json({ success: true, dcs, total, page: safePage });
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
    if (!DC_STATUSES.includes(status)) {
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

        const allowed = DC_TRANSITIONS[previousStatus] || [];
        if (!allowed.includes(status)) {
          const err = new ErrorHandler(
            allowed.length === 0
              ? `DC ${dc.dcNumber} is ${previousStatus} and cannot change again. ` +
                `Raise a fresh challan for a correction.`
              : `A ${previousStatus} challan can only become ` +
                `${allowed.join(" or ")} — not ${status}.`,
            409
          );
          err.code = "DC_BAD_TRANSITION";
          err.details = { from: previousStatus, to: status, allowed };
          throw err;
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

    // A DRAFT challan has not been dispatched.
    //
    // The filter excluded only cancelled ones, so every draft counted —
    // with `dispatchDate` defaulting to the moment it was keyed, which
    // is not a despatch date at all. Paperwork sitting in a drawer was
    // scoring in the delivery statistic, and scoring on-time.
    const dcs = await DeliveryChallan.find({
      order: { $ne: null },
      status: { $in: ["dispatched", "delivered"] },
      dispatchDate: { $gte: since },
    })
      .populate("order", "orderNo supplyDate")
      .select("dcNumber orderNo customerName dispatchDate order")
      .lean();

    // Lateness is counted in DAYS, so both ends are taken to the start
    // of their day first.
    //
    // The old line ceil'd a millisecond difference. `supplyDate` is
    // stored as a midnight timestamp and `dispatchDate` is the moment
    // the challan was cut, so a lorry that left at nine in the morning
    // on the promised date came out at ceil(0.4) = 1 day late. Every
    // same-day despatch — the ones that hit the date exactly — was
    // counted as a miss, which made the figure systematically worse
    // than the truth and worst for the customers served most promptly.
    const startOfDay = (d) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };
    const dayDiff = (a, b) =>
      Math.round((startOfDay(a) - startOfDay(b)) / (24 * 60 * 60 * 1000));

    let onTime = 0;
    const late = [];
    let considered = 0;
    for (const dc of dcs) {
      const due = dc.order?.supplyDate ? new Date(dc.order.supplyDate) : null;
      if (!due) continue;
      considered += 1;
      const dispatched = new Date(dc.dispatchDate);
      const lateDays = dayDiff(dispatched, due);
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

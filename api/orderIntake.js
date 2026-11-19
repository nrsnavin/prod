// ══════════════════════════════════════════════════════════════════
//  ORDERS — HOW ORDERS COME IN, AND THE LIST  (part of /api/v2/order)
//
//  Requests a customer typed on WhatsApp, the order list, a new order,
//  a restock order for stock, and a draft read from a customer's PO.
//
//    GET   /requests
//    POST  /requests/:id/:action(converted|dismissed)
//    GET   /list
//    POST  /create-order
//    POST  /restock
//    POST  /intake-po
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const { escapeRegex } = require("../utils/escapeRegex");
const Order = require("../models/Order.js");
const Elastic = require("../models/Elastic.js");
const creditControl = require("../services/creditControl");
const ErrorHandler = require("../utils/ErrorHandler.js");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const multer   = require("multer");
// multer finishes from a stream event, which loses the request's
// AsyncLocalStorage stores — the database it routes to and the user
// it audits as. See middleware/userContext.js.
const { keepRequestContext } = require("../middleware/userContext.js");
const poIntake = require("../services/inboundPoIntake.js");
const {
  readOrderLines,
  assertElasticsExist,
  assertCustomerExists,
} = require("../utils/orderLines");
const Customer             = require("../models/Customer.js");
const { notify }           = require("../utils/notify.js");
const { computeRawMaterialRequired } = require("./orderShared");
const factoryDay = require("../utils/factoryDay");
const { dayFrom } = require("../utils/requestDate");
const crypto = require("crypto");
const { onceAtATime } = require("../utils/onceAtATime");
const { ORDER_STATUSES } = require("../domain/orderStatus");
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  THE SAME ORDER, SENT TWICE
//
//  A double tap on Save, or a phone retrying on a bad line: nothing
//  stood between the second request and a second order. Each creates
//  its own new document, so there is no write for them to collide on.
//
//  An order that matches one saved in the last two minutes in every
//  particular — customer, PO, both dates, every line and its rate — and
//  that is still Open is that order sent again, and is answered with
//  it. Anything that differs, or comes later, is another order: a
//  customer does place the same PO twice.
// ════════════════════════════════════════════════════════════════
const RESEND_WINDOW_MS = 2 * 60_000;

const linesKey = (lines) => (lines || [])
  // A line saved with no rate is kept with a rate of 0 (models/Order.js).
  .map((l) => `${String(l.elastic?._id ?? l.elastic)}:${Number(l.quantity) || 0}:${Number(l.rate) || 0}`)
  .sort()
  .join("|");
const sameMoment = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

async function sameOrderJustSaved({ customer, po, date, supplyDate, lines }) {
  const recent = await Order.find({
    customer,
    po: po == null ? null : po,
    status: "Open",
    createdAt: { $gte: new Date(Date.now() - RESEND_WINDOW_MS) },
  })
    .select("orderNo date supplyDate elasticOrdered")
    .sort({ createdAt: -1 })
    .lean();
  const wanted = linesKey(lines);
  return recent.find((o) =>
    linesKey(o.elasticOrdered) === wanted && sameMoment(o.date, date) && sameMoment(o.supplyDate, supplyDate)
  ) || null;
}

// A photographed PO is a phone camera image; 12 MB covers a multi-page
// scan without letting somebody upload a video of one.
const poUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ════════════════════════════════════════════════════════════════
//  WHATSAPP ORDERS — typed by a customer, drafted, waiting for the office
//  (services/customerAssistant.js). Opened as an order (the form filled
//  from the draft, saved by a person) or dismissed; never ordered alone.
// ════════════════════════════════════════════════════════════════
router.get("/requests", catchAsyncErrors(async (req, res) => {
  const OrderRequest = require("../models/OrderRequest");
  const status = ["new", "converted", "dismissed"].includes(req.query.status) ? req.query.status : "new";
  const requests = await OrderRequest.find({ status }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, requests, count: await OrderRequest.countDocuments({ status: "new" }) });
}));

router.post("/requests/:id/:action(converted|dismissed)", catchAsyncErrors(async (req, res, next) => {
  const OrderRequest = require("../models/OrderRequest");
  if (!mongoose.isValidObjectId(req.params.id)) return next(new ErrorHandler("Request not found", 404));
  const set = { status: req.params.action, decidedBy: req.user?._id, decidedAt: new Date(), note: String(req.body?.note || "").trim().slice(0, 200) };
  if (req.params.action === "converted") {
    if (!mongoose.isValidObjectId(req.body?.order)) return next(new ErrorHandler("order is required", 400));
    const o = await Order.findById(req.body.order).select("orderNo").lean();
    if (!o) return next(new ErrorHandler("Order not found", 404));
    Object.assign(set, { order: o._id, orderNo: o.orderNo });
  }
  const r = await OrderRequest.findOneAndUpdate({ _id: req.params.id, status: "new" }, { $set: set }, { new: true }).lean();
  if (!r) return next(new ErrorHandler("That request was already dealt with", 409));
  res.json({ success: true, request: r });
}));

// ════════════════════════════════════════════════════════════════
//  LIST ORDERS  (by status)
// ════════════════════════════════════════════════════════════════
router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const { status } = req.query;
    if (!status) {
      return next(new ErrorHandler("Status is required", 400));
    }
    // "All" (case-insensitive) is every order that has not been deleted.
    // It matched every status, Deleted among them — and the web's list,
    // which opens on "All" and has no such status, showed deleted orders
    // among the live ones with a blank status. Deleted orders are still
    // listed when asked for by name (the phone's Deleted tab).
    //
    // Any other value is that exact status. One nobody knows ("open",
    // "Shipped") used to give an empty list, which reads as "there are
    // no such orders" rather than "that is not a status".
    const all = String(status).toLowerCase() === "all";
    if (!all && !ORDER_STATUSES.includes(String(status))) {
      return next(new ErrorHandler(
        `Unknown status "${String(status).slice(0, 40)}" — use All or one of ${ORDER_STATUSES.join(", ")}`, 400));
    }
    const filter = all ? { status: { $ne: "Deleted" } } : { status: String(status) };

    // Optional ?search= for the app's global search: "42", "#42" or
    // "order 42" is an order number; anything else matches the customer
    // PO, case-insensitively. Escaped — it is typed by a person.
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      const asNumber = search.match(/^(?:order\s*)?#?\s*(\d+)$/i);
      if (asNumber) filter.orderNo = Number(asNumber[1]);
      else filter.po = { $regex: escapeRegex(search), $options: "i" };
    }

    // Paginated. This route used to return every order ever placed, fully
    // hydrated into mongoose documents and sorted in memory — the one list
    // endpoint in the app that did (jobs, elastics and materials all page).
    // The sort was the sharp edge: on an unindexed field Mongo caps an
    // in-memory sort at 32 MB and then errors outright, so the order list
    // would have stopped working rather than merely slowed down.
    // The default is deliberately generous rather than small: the mobile app
    // reads `orders` without paging, so a tight default would silently hide
    // rows from it. 200 keeps every existing caller whole in practice while
    // removing the unbounded case, and the new index makes the page cheap.
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 200), 500);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        // Without the trail. Each order's fingerprints — every approval,
        // draw and edit — came down with every row, up to 500 orders at
        // a time, for pages that show one line per order. The order's
        // own page has them.
        .select("-fingerprints")
        .populate("customer",  "name")
        .populate("createdBy", "name role")
        .populate("updatedBy", "name role")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // .lean(): these are read straight to JSON, so paying for full
        // document hydration bought nothing.
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      orders,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasMore: page * limit < total,
    });
  })
);

// ════════════════════════════════════════════════════════════════
//  CREATE ORDER
// ════════════════════════════════════════════════════════════════
router.post(
  "/create-order",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { po, customer, description, elasticOrdered } = req.body;
      // The order's date and the date promised are calendar dates. The
      // web sends "2026-11-18"; the phone app sends its clock with no
      // zone, which went into the order as UTC: an order taken after
      // 18:30 was dated the next day, and promised a day late.
      const date = dayFrom(req.body.date, "date", undefined);
      const supplyDate = dayFrom(req.body.supplyDate, "supplyDate", undefined);

      // Validated before anything is written. This route used to read
      // the body straight into Order.create, so a missing array was a
      // 500 and an empty one was a 201 for an order with no lines.
      // See utils/orderLines.js for what each rule is protecting.
      const parsed = readOrderLines(elasticOrdered);
      if (parsed.error) return next(new ErrorHandler(parsed.error, 400));

      const customerError = await assertCustomerExists(customer, Customer);
      if (customerError) return next(new ErrorHandler(customerError, 400));

      // A customer over their credit limit or too long overdue is on hold.
      let creditOverride = null;
      try { creditOverride = await creditControl.enforce(customer, req, "this order"); } catch (err) { return next(err); }

      const elasticError = await assertElasticsExist(parsed.lines, Elastic);
      if (elasticError) return next(new ErrorHandler(elasticError, 400));

      const rawMaterialRequired = await computeRawMaterialRequired(parsed.lines);

      const producedElastic = parsed.lines.map((e) => ({ elastic: e.elastic, quantity: 0 }));
      const packedElastic   = parsed.lines.map((e) => ({ elastic: e.elastic, quantity: 0 }));
      const pendingElastic  = parsed.lines.map((e) => ({ elastic: e.elastic, quantity: e.quantity }));

      // One at a time for a customer's PO, so that of two requests
      // arriving together the second is looking at what the first made.
      const lease = `create-order:${customer}:${crypto.createHash("sha1").update(String(po ?? "")).digest("hex").slice(0, 16)}`;
      const made = await onceAtATime(lease, async () => {
        const already = await sameOrderJustSaved({ customer, po, date, supplyDate, lines: parsed.lines });
        if (already) return { already };

        const order = await Order.create({
          date, po, customer, supplyDate, description,
          elasticOrdered: parsed.lines, producedElastic, packedElastic,
          pendingElastic, rawMaterialRequired, status: "Open",
          ...(creditOverride ? { creditOverride } : {}),
        });

        const fp = buildFingerprint(ACTION_CODES.ORDER_CREATED, {
          entityId: order._id,
          actor:    actorFromRequest(req),
          meta: {
            po,
            customer:      customer?.toString?.() ?? customer,
            // The lines that were saved (the request's array was counted).
            totalElastics: parsed.lines.length,
            totalRawMats:  rawMaterialRequired.length,
          },
        });
        order.fingerprints.push(fp);
        await order.save();
        return { order, fp };
      }, { what: "This order" });

      if (made.already) {
        return res.status(200).json({
          success:   true,
          duplicate: true,
          orderId:   made.already._id,
          orderNo:   made.already.orderNo,
          message:   `Already saved as order #${made.already.orderNo} — the same order was sent twice.`,
        });
      }
      const { order, fp } = made;

      res.status(201).json({
        success:     true,
        orderId:     order._id,
        fingerprint: fp,
      });

      // Owner WhatsApp ping — fire-and-forget AFTER the response so a
      // slow/failed notification can never delay or break order
      // creation. Outcome is *logged* (not silently swallowed) so
      // "no message arrived" reports come with the actual reason
      // in journalctl instead of the orchestration looking opaque.
      (async () => {
        try {
          const totalMeters = parsed.lines
            .reduce((s, e) => s + (Number(e.quantity) || 0), 0);
          let customerName;
          if (customer) {
            const cust = await Customer.findById(customer).select("name").lean();
            customerName = cust?.name;
          }
          const result = await notify("orderCreated", {
            orderNo:      order.orderNo,
            po,
            customerName,
            totalMeters,
            lineCount:    parsed.lines.length,
            supplyDate,
            _entity: { type: "Order", id: order._id },
            _actor:  actorFromRequest(req),
          });
          console.log(`[notify:orderCreated] order=${order.orderNo} →`, JSON.stringify(result));
        } catch (err) {
          console.warn(`[notify:orderCreated] hook crashed: ${err?.message}`);
        }
      })();
    } catch (error) {
      // ErrorHandler already logs; no duplicate console.error.
      return next(error);
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  RESTOCK  —  POST /order/restock  { lines: [{ elastic, quantity }], supplyDate? }
//
//  Elastics at or under their reorder level are made for stock through
//  the ordinary order → job flow, on an order for the factory's own
//  house customer ("Own stock"). It is created Open, like any order:
//  someone approves it (which draws the raw material) and raises its job.
//  Its reservation holds the new production until the order completes;
//  completion releases it, and the metres become free stock.
// ════════════════════════════════════════════════════════════════
async function houseCustomer() {
  return Customer.findOneAndUpdate(
    { houseStock: true },
    { $setOnInsert: { houseStock: true, name: "Own stock (restock)", contactName: "", phoneNumber: "" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

router.post(
  "/restock",
  catchAsyncErrors(async (req, res, next) => {
    const parsed = readOrderLines(req.body?.lines);
    if (parsed.error) return next(new ErrorHandler(parsed.error, 400));
    const elasticError = await assertElasticsExist(parsed.lines, Elastic);
    if (elasticError) return next(new ErrorHandler(elasticError, 400));

    const customer = await houseCustomer();
    // Today in the factory: between midnight and 05:30 the server's own
    // date (UTC) is still yesterday's, and so was the STOCK- number.
    const today = factoryDay.calendarDay();
    let supplyDate;
    try { supplyDate = dayFrom(req.body?.supplyDate, "supplyDate", new Date(today.getTime() + 14 * 86_400_000)); } catch (err) { return next(err); }

    const rawMaterialRequired = await computeRawMaterialRequired(parsed.lines);
    const zeroes = parsed.lines.map((e) => ({ elastic: e.elastic, quantity: 0 }));
    const order = await Order.create({
      date: today,
      po: `STOCK-${today.toISOString().slice(0, 10).replace(/-/g, "")}`,
      customer: customer._id,
      supplyDate,
      description: String(req.body?.description || "Restock: elastics at or under their reorder level").slice(0, 500),
      elasticOrdered: parsed.lines,
      producedElastic: zeroes,
      packedElastic: zeroes.map((z) => ({ ...z })),
      pendingElastic: parsed.lines.map((e) => ({ elastic: e.elastic, quantity: e.quantity })),
      rawMaterialRequired,
      status: "Open",
    });
    order.fingerprints.push(buildFingerprint(ACTION_CODES.ORDER_CREATED, {
      entityId: order._id,
      actor: actorFromRequest(req),
      meta: { po: order.po, customer: String(customer._id), restock: true, totalElastics: parsed.lines.length },
    }));
    await order.save();
    res.status(201).json({ success: true, orderId: order._id, orderNo: order.orderNo });
  })
);

// ══════════════════════════════════════════════════════════════════
//  POST /intake-po — draft an order from a customer's purchase order
//
//  Stage → verify → apply, exactly as the shift sheet and QC vision do.
//  This route CREATES NOTHING. It reads the document, matches what it
//  names against the customer and elastic masters, and returns a draft
//  with candidates and confidence for every line. The existing create
//  route is what writes, driven by somebody who has looked at it.
//
//  Gating is at the mount — gate('accounts') plus requireFeature
//  ('/orders') — so this route carries no guard of its own.
// ══════════════════════════════════════════════════════════════════
router.post(
  "/intake-po",
  keepRequestContext(poUpload.single("file")),
  catchAsyncErrors(async (req, res, next) => {
    if (!req.file) {
      return next(new ErrorHandler('No file uploaded (field name must be "file").', 400));
    }

    let out;
    try {
      out = await poIntake.draftFromDocument(req.file.buffer, req.file.mimetype, {
        userId: req.user?._id,
      });
    } catch (err) {
      if (err.code === "UNSUPPORTED_TYPE") return next(new ErrorHandler(err.message, 400));
      // A model that is down is a 502, not a 500: nothing here is
      // broken, the upstream did not answer.
      return res.status(502).json({ success: false, reason: "INTAKE_FAILED", message: err.message });
    }

    if (!out.available) {
      return res.json({
        success: true, available: false,
        message: "Document intake is not configured (no API key).",
      });
    }

    res.json({ success: true, ...out });
  })
);

module.exports = router;

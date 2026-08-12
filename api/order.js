const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const router = express.Router();
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const Elastic = require("../models/Elastic.js");
const { computeMaterialRequirement } = require("../utils/materialRequirement.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const { buildOrderStatusReport } = require("../services/orderStatusReport.js");
const PurchaseOrder = require("../models/PurchaseOrder.js");
const { triageShortfall, createShortfallPos, skipReasons } = require("../services/shortfallPo.js");
const { issuedForOrder } = require("../services/orderIssuance.js");
const { buildOrderStatusPdf } = require("../utils/orderStatusPdf.js");
const { getPdfBranding } = require("../services/documentSettings.js");
const RawMaterial     = require("../models/RawMaterial.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const { requireReason } = require("../utils/auditReason.js");
const { assertVersion } = require("../utils/versioning.js");
const { applyMovement } = require("../utils/elasticStock.js");
const { appendStockMovement } = require("../utils/stockLedger.js");
const { receiveAtCost } = require("../utils/materialValuation.js");
const { estimateOrderEta } = require("../utils/orderEta.js");
const Customer             = require("../models/Customer.js");
const { notify }           = require("../utils/notify.js");
const Notification         = require("../models/Notification.js");
const { approveOrderTxn }  = require("../services/orderService.js");
const WarpingBatch         = require("../models/WarpingBatch.js");
const DeliveryChallan      = require("../models/DeliveryChallan.js");
const { plannedLotsByJob, distinctLots, emptyTrail } = require("../services/yarnLotTrail.js");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient.js");
// ETA forecast engine lives in its own service (Phase 4 god-file split).
// The routes below and utils/digest.js both consume these; keeping them
// in one module means the digest and the order card show identical numbers.
const {
  _computeRunningEtaForOrder,
  _fallbackEntryTimeEta,
  _loadPlantMetersPerMachineDay,
  _loadFreeMachineCount,
  buildEntryTimeAggregates,
} = require("../services/etaService.js");


// ════════════════════════════════════════════════════════════════
//  SHARED — BOM EXPANSION
// ════════════════════════════════════════════════════════════════
// Delegates to the shared MRP calculator (utils/materialRequirement.js) so
// the order and the job MRP sheet can never drift apart. That version also
// survives a deleted RawMaterial: this one crashed on `material._id` when
// populate handed back null for a dangling reference, and silently dropped
// the line when it didn't.
async function computeRawMaterialRequired(elasticOrdered) {
  return computeMaterialRequirement(elasticOrdered);
}


// ════════════════════════════════════════════════════════════════
//  SHARED — RELEASE ALL REMAINING RESERVATIONS
//
//  Called from /cancel and /complete. For each entry in
//  order.reservations, post a RESERVATION_RELEASE: the promise is
//  given up, and the goods it was holding become available again.
//  No goods move — they were never taken. Clears the array on the
//  order. Fingerprints (STOCK_RELEASED) appended to the order so
//  the timeline shows the release event.
// ════════════════════════════════════════════════════════════════
async function _releaseAllReservations(session, order, actor, context) {
  if (!order.reservations || order.reservations.length === 0) return [];
  const released = [];

  for (const r of order.reservations) {
    const qty = Number(r.quantity || 0);
    if (qty <= 0) continue;

    // applyMovement lowers reservedStock and records the resulting
    // balance on the row. Doing it here as well would release twice.
    await applyMovement(session, {
      elasticId: r.elastic,
      type:      "RESERVATION_RELEASE",
      quantity:  +qty,
      refType:   "Order",
      refId:     order._id,
      reason:    `${context} (order ${order.orderNo ?? order._id})`,
      by:        actor?.id,
    });

    const fp = buildFingerprint(ACTION_CODES.STOCK_RELEASED, {
      entityId: order._id,
      actor,
      meta: {
        elasticId: r.elastic.toString(),
        quantity:  qty,
        context,
      },
    });
    order.fingerprints.push(fp);
    released.push({ elastic: r.elastic, quantity: qty, fingerprint: fp });
  }

  order.reservations = [];
  return released;
}


// ════════════════════════════════════════════════════════════════
//  SHARED — REFUND RAW MATERIALS ON CANCEL
//
//  Walks every MaterialOutward this order's APPROVAL emitted and
//  credits each material's stock back by exactly the quantity that
//  was actually drawn (not requiredWeight — under force-approval
//  these can differ). Records a paired ORDER_CANCEL_REFUND row in
//  stockMovements, marks the MaterialOutward as reversed, and
//  pushes a RAW_MATERIAL_RESTORED fingerprint per refunded row so
//  the timeline shows the credit clearly.
//
//  Returns the list of `{materialId, quantity, balanceAfter}` so
//  the cancel route can include a summary in its response.
//
//  Safe to call on Open orders (returns an empty list — no
//  approval has been recorded for them yet).
// ════════════════════════════════════════════════════════════════
async function _refundRawMaterialsForOrder(session, order, actor, userObjectId) {
  const refunded = [];

  // Only reverse outwards that haven't been reversed yet — protects
  // against any future code path that might call this helper twice.
  const outwards = await MaterialOutward.find({
    order:    order._id,
    type:     "ORDER_APPROVAL",
    reversed: { $ne: true },
  }).session(session);

  if (outwards.length === 0) return refunded;

  for (const ow of outwards) {
    const qty = Number(ow.quantity || 0);
    if (qty <= 0) continue;

    const material = await RawMaterial.findById(ow.rawMaterial).session(session);
    if (!material) continue;

    // The consumption counter first, on its own — `stock` and `avgCost`
    // are moved by receiveAtCost below and must not also be written
    // from this stale in-memory copy.
    material.totalConsumption = Math.max(
      0,
      (Number(material.totalConsumption) || 0) - qty
    );
    await material.save({ session });

    // Back at exactly what it left at. The outward row this is
    // reversing recorded the unit cost at issue time, so the yarn
    // returns to the shelf carrying the value it took off it —
    // crediting it at TODAY's average would quietly create money every
    // time an order was cancelled after a price rise.
    //
    // receiveAtCost moves the weighted average in the same atomic
    // update as the stock, the way any other receipt does.
    const refundCost = Number(ow.unitPrice) || 0;
    const restored = await receiveAtCost(ow.rawMaterial, qty, refundCost, session);
    material.stock = restored
      ? Number(restored.stock) || 0
      : (Number(material.stock) || 0) + qty;

    await appendStockMovement(material._id, {
      type:     "ORDER_CANCEL_REFUND",
      order:    order._id,
      refNo:    order.orderNo != null ? String(order.orderNo) : "",
      quantity: qty,
      balance:  material.stock,
      unitCost: refundCost,
    }, session);

    // Mark the outward row as reversed so audit + the dedupe filter
    // above stay self-consistent. The original outward stays in
    // place for history; no MaterialInward is created because this
    // wasn't a true receipt.
    ow.reversed   = true;
    ow.reversedAt = new Date();
    // reversedBy is an ObjectId ref to User; only assign when we
    // have a real mongo user id. The normalised `actor.id` can be
    // a string sentinel like "system" / "unknown" which would
    // CastError on save. The fingerprint already captures actor
    // identity for audit, so this field is purely a cross-ref.
    if (userObjectId) ow.reversedBy = userObjectId;
    await ow.save({ session });

    const fp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_RESTORED, {
      entityId: order._id,
      actor,
      meta: {
        rawMaterialId:   ow.rawMaterial.toString(),
        rawMaterialName: material.name,
        quantity:        qty,
        unit:            "kg",
        balanceAfter:    material.stock,
        reversedFrom:    ow._id.toString(),
      },
    });
    order.fingerprints.push(fp);

    refunded.push({
      materialId:   ow.rawMaterial.toString(),
      materialName: material.name,
      quantity:     qty,
      balanceAfter: material.stock,
    });
  }

  return refunded;
}


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
    // "All" (case-insensitive) lists every order regardless of status;
    // any other value filters to that exact status.
    const filter = String(status).toLowerCase() === "all" ? {} : { status };

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
      const { date, po, customer, supplyDate, description, elasticOrdered } =
        req.body;

      const rawMaterialRequired = await computeRawMaterialRequired(elasticOrdered);

      const producedElastic = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
      const packedElastic   = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
      const pendingElastic  = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: e.quantity }));

      const order = await Order.create({
        date, po, customer, supplyDate, description,
        elasticOrdered, producedElastic, packedElastic,
        pendingElastic, rawMaterialRequired, status: "Open",
      });

      const fp = buildFingerprint(ACTION_CODES.ORDER_CREATED, {
        entityId: order._id,
        actor:    actorFromRequest(req),
        meta: {
          po,
          customer:      customer?.toString?.() ?? customer,
          totalElastics: elasticOrdered.length,
          totalRawMats:  rawMaterialRequired.length,
        },
      });
      order.fingerprints.push(fp);
      await order.save();

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
          const totalMeters = (elasticOrdered || [])
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
            lineCount:    (elasticOrdered || []).length,
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
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  GET ORDER DETAIL
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-orderDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Order ID is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid order id", 400));
    }

    const order = await Order.findById(id)
      .populate("customer",  "name gstin")
      // elasticOrdered.elastic is deliberately NOT populated: mongoose turns
      // an unresolvable ref into null, discarding the id the produced/packed/
      // pending joins below key on. Names are resolved from a lookup map
      // instead, so a deleted elastic master degrades one row's label rather
      // than throwing and taking the whole order page down with it.
      // The job's own elastic names come along so the order page can show a
      // per-job breakdown without a round trip per job.
      .populate({
        path: "jobs.job",
        populate: [
          { path: "elastics.elastic",        select: "name" },
          { path: "producedElastic.elastic", select: "name" },
          { path: "packedElastic.elastic",   select: "name" },
        ],
      })
      .populate("createdBy",  "name role")
      .populate("updatedBy",  "name role")
      .populate("approvedBy", "name role")
      .populate("cancelledBy","name role")
      .populate("startedBy",  "name role")
      .populate("completedBy","name role")
      .populate("deletedBy",  "name role")
      .lean();

    if (!order) return next(new ErrorHandler("Order not found", 404));

    // Name lookup for every elastic referenced anywhere on this order. A row
    // whose master has since been deleted simply has no entry and is labelled
    // rather than dropped — the ordered quantity is still real.
    const elasticIds = [
      ...(order.elasticOrdered || []),
      ...(order.producedElastic || []),
      ...(order.packedElastic || []),
      ...(order.pendingElastic || []),
      // Excess rows name their own elastic; it is always on the order
      // too, but relying on that would break the day it isn't.
      ...(order.excessPlanning || []),
    ]
      .map((row) => row?.elastic)
      .filter(Boolean);
    const elasticNames = new Map(
      (await Elastic.find({ _id: { $in: elasticIds } }).select("name").lean())
        .map((el) => [String(el._id), el.name])
    );

    // Matching on strings rather than ObjectId.equals(): a null id on either
    // side used to throw here and 500 the whole page.
    const qtyFor = (rows, id) =>
      (rows || []).find((p) => p?.elastic && String(p.elastic) === id)?.quantity;

    // ── What has actually reached the customer ──────────────────────
    // Packed is goods in a box in this building; DELIVERED is goods that
    // left it on a delivery note. The page reported the first and called
    // it progress, which reads as further along than the order really
    // is — an order can be fully packed and nothing despatched.
    //
    // Summed from the notes rather than stored on the order, so it
    // cannot drift from them. Matched on the reference AND the order
    // number, because a note carries both and older rows can have one
    // without the other. Cancelled notes are excluded: nothing left the
    // building on them.
    const dcMatch = [{ order: order._id }];
    if (order.orderNo != null) dcMatch.push({ orderNo: order.orderNo });
    const orderDcs = await DeliveryChallan.find({
      $or: dcMatch,
      status: { $ne: "cancelled" },
    }).select("items").lean();

    const deliveredByElastic = new Map();
    for (const dc of orderDcs) {
      for (const item of dc.items || []) {
        if (!item.elastic) continue;
        const key = String(item.elastic);
        deliveredByElastic.set(
          key,
          (deliveredByElastic.get(key) || 0) + (Number(item.quantity) || 0)
        );
      }
    }
    const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

    const elastics = order.elasticOrdered.map((e) => {
      const id = String(e.elastic ?? "");
      return {
        id:       e.elastic ?? null,
        name:     elasticNames.get(id) ?? "Unknown elastic",
        ordered:  e.quantity,
        produced: qtyFor(order.producedElastic, id) || 0,
        packed:   qtyFor(order.packedElastic, id)   || 0,
        // Two questions that were long conflated under "pending":
        //   notAssigned — ordered minus what jobs have been raised for.
        //     A planning figure, and the cap when allocating to a job.
        //   pendingDelivery — ordered minus packed. A delivery figure:
        //     what the customer is still owed. Work can be fully
        //     planned and still entirely pending.
        notAssigned:     qtyFor(order.pendingElastic, id) ?? e.quantity,
        pendingDelivery: Math.max(
          0,
          e.quantity - (qtyFor(order.packedElastic, id) || 0)
        ),
        // Goods that have actually left, on a delivery note. Sits beside
        // `packed` because the two are a step apart and are constantly
        // read as one.
        delivered: round3(deliveredByElastic.get(id) || 0),
        // Ordered minus delivered — what the customer is still waiting
        // for, as against `pendingDelivery` which stops at packed.
        // Negative would mean an over-despatch, which happens and is
        // worth seeing rather than clamped away.
        undelivered: round3(e.quantity - (deliveredByElastic.get(id) || 0)),
        // Legacy alias for notAssigned — the mobile app reads it as the
        // allocation cap, so its meaning must not drift.
        pending:  qtyFor(order.pendingElastic, id)  ?? e.quantity,
        reserved: qtyFor(order.reservations, id)    ?? 0,
      };
    });

    // Per-job elastic breakdown, so the order page can show at a glance what
    // each job covers and how much of it is still to weave.
    //
    // Note the two senses of "pending". At ORDER level it means "not yet
    // committed to any job" (ordered − planned; see services/orderPending.js).
    // Here it means "committed to this job but not yet woven" (planned −
    // produced). They answer different questions and must not be conflated.
    const jobs = (order.jobs || []).map((ref) => {
      const job = ref.job && typeof ref.job === "object" ? ref.job : null;
      if (!job) return ref;

      const qtyBy = (arr) => {
        const map = new Map();
        for (const row of arr || []) {
          const id = row.elastic?._id ?? row.elastic;
          if (!id) continue;
          map.set(String(id), (map.get(String(id)) || 0) + (row.quantity || 0));
        }
        return map;
      };
      const produced = qtyBy(job.producedElastic);
      const packed   = qtyBy(job.packedElastic);

      const elasticSummary = (job.elastics || []).map((e) => {
        const id = String(e.elastic?._id ?? e.elastic ?? "");
        const planned = e.quantity || 0;
        const made    = produced.get(id) || 0;
        return {
          id,
          // Falls back to the order's own naming when the job's elastic ref
          // no longer resolves (deleted master), rather than dropping the row.
          name: e.elastic?.name
            ?? elastics.find((oe) => String(oe.id) === id)?.name
            ?? "Unknown",
          planned,
          produced: made,
          packed:   packed.get(id) || 0,
          // Over-production is a data issue, not a negative outstanding qty.
          pending:  Math.max(0, planned - made),
        };
      });

      return { ...ref, elasticSummary };
    });

    // One query for every material on the order, not one per material. This
    // was a findById inside a map — an order with 20 materials opened 20
    // connections and paid 20 round trips to render one page.
    const requirementIds = (order.rawMaterialRequired || [])
      .map((rm) => rm.rawMaterial)
      .filter(Boolean);
    const materialsById = new Map(
      (await RawMaterial.find({ _id: { $in: requirementIds } })
        .select("name stock unit")
        .lean()
      ).map((m) => [String(m._id), m])
    );

    // What approval already drew for this order. Without it every
    // approved order's material panel turned red the moment it was
    // approved: the requirement had come OUT of the stock figure it was
    // then being compared against.
    const drawn = await issuedForOrder(order._id);

    const liveRawMaterials = (order.rawMaterialRequired || []).map((rm) => {
      const mat = materialsById.get(String(rm.rawMaterial));
      // A deleted material is reported as absent rather than as zero stock:
      // see utils/materialRequirement.js — "0 in stock" and "we no longer
      // know" look identical on screen but mean very different things.
      const inStock = mat?.stock ?? 0;
      const required = Number(rm.requiredWeight) || 0;
      const allocated = Math.min(required, drawn.get(String(rm.rawMaterial)) || 0);
      const outstanding = Math.max(0, Math.round((required - allocated) * 1000) / 1000);
      return {
        rawMaterial:     rm.rawMaterial,
        name:            mat?.name ?? rm.name ?? "—",
        unit:            mat?.unit ?? "kg",
        requiredWeight:  required,
        // Taken out of stock and held for this order at approval; nil
        // before it, and nil again after a cancel hands it back.
        allocated:       Math.round(allocated * 1000) / 1000,
        outstanding,
        // full  — the whole requirement is held for this order
        // partial — a forced approval drew what there was; the rest is
        //           still owed and nothing is holding it
        // none  — not approved yet, or the allocation was handed back
        allocationState: allocated <= 0
          ? "none"
          : outstanding > 0 ? "partial" : "full",
        inStock,
        stockSufficient: inStock >= outstanding,
      };
    });

    const canApprove = order.status === "Open"
      ? liveRawMaterials.every((m) => m.stockSufficient)
      : undefined;

    const fingerprints = (order.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.status(200).json({
      success: true,
      data: {
        _id:         order._id,
        // The document version, for the optimistic lock on /update-order.
        // This projection is hand-built and never included it, so the
        // edit form has been sending `expectedVersion: undefined` — and
        // assertVersion no-ops on an absent value, which left the lock
        // decorative: two people editing the same order both saved, and
        // the second silently won.
        __v:         order.__v,
        orderNo:     order.orderNo,
        po:          order.po,
        status:      order.status,
        date:        order.date,
        supplyDate:  order.supplyDate,
        description: order.description,
        customer:    order.customer,
        elastics,
        jobs,
        rawMaterialRequired: liveRawMaterials,
        // Jobs planned past what this order asked for. Surfaced as its
        // own list rather than folded into the job rows: an excess is a
        // decision someone made and had to justify, and it is the thing
        // that explains why this order's yarn draw exceeds its lines.
        excessPlanning: (order.excessPlanning || []).map((x) => ({
          elastic:         x.elastic,
          // The snapshot survives a rename; the live name is preferred
          // when the master is still there, as everywhere else here.
          name:            elasticNames.get(String(x.elastic)) || x.elasticName || "—",
          job:             x.job,
          jobOrderNo:      x.jobOrderNo ?? null,
          jobNo:           x.jobOrderNo != null ? `J-${x.jobOrderNo}` : "—",
          orderedQuantity: x.orderedQuantity ?? 0,
          plannedQuantity: x.plannedQuantity ?? 0,
          excessQuantity:  x.excessQuantity ?? 0,
          excessPct:       x.excessPct ?? 0,
          // "" means the excess was inside the free allowance and no
          // reason was ever asked for — not that one was withheld.
          reason:          x.reason || "",
          materialsDrawn:  x.materialsDrawn || [],
          recordedAt:      x.recordedAt || null,
        })),
        canApprove,
        createdBy:   order.createdBy  || null,
        createdAt:   order.createdAt  || null,
        updatedBy:   order.updatedBy  || null,
        updatedAt:   order.updatedAt  || null,
        approvedBy:  order.approvedBy || null,
        approvedAt:  order.approvedAt || null,
        cancelledBy: order.cancelledBy|| null,
        cancelledAt: order.cancelledAt|| null,
        startedBy:   order.startedBy  || null,
        startedAt:   order.startedAt  || null,
        completedBy: order.completedBy|| null,
        completedAt: order.completedAt|| null,
        deletedBy:   order.deletedBy  || null,
        deletedAt:   order.deletedAt  || null,
        fingerprints,
      },
    });
  })
);


// ════════════════════════════════════════════════════════════════
//  APPROVE ORDER  (deducts raw stock; reserves elastic stock)
//
//  PR E: in addition to the existing raw-material deduction, the
//  approve route now reserves elastic units against the order.
//  For each elasticOrdered line:
//    1. $inc Elastic.reservedStock by the ordered quantity.
//    2. Push a {elastic, quantity} entry onto Order.reservations.
//    3. Emit a RESERVATION_HOLD info-row on the StockMovement
//       ledger and a STOCK_RESERVED fingerprint on the order.
// ════════════════════════════════════════════════════════════════
router.post(
  "/approve",
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      const { orderId, force = false, forceReason = "" } = req.body;
      const actor = actorFromRequest(req);

      // The transactional domain logic (validate → pre-flight → force
      // fingerprint → raw deduction → elastic reservation → approval
      // fingerprint + status flip) lives in services/orderService.js.
      // The route keeps only session lifecycle, HTTP shaping, and the
      // post-commit fire-and-forget notifications.
      //
      // withTransaction, not a hand-rolled startTransaction/commit pair:
      // approving two different orders that draw on the same raw material
      // makes their transactions collide on that material document, and
      // Mongo resolves the collision by aborting one with a WriteConflict.
      // Without the retry withTransaction provides, that surfaced to the
      // user as a 500 on a perfectly valid approval — the busier the floor,
      // the more often it fired. approveOrderTxn re-reads the order and
      // every material from the session on entry, so a replay starts from
      // clean state rather than compounding the aborted attempt's edits.
      let txn;
      await session.withTransaction(async () => {
        txn = await approveOrderTxn(session, {
          orderId, force, forceReason, actor,
          whatsappActor: req.body?.whatsappActor,
          userId:        req.user?._id,
        });
      });

      const {
        order, approveFp, deductionFingerprints, reservationFingerprints,
        stockoutSnapshots,
      } = txn;

      // Responding and notifying only once the transaction has committed —
      // inside the callback a retry would try to send the response twice.
      res.status(200).json({
        success:                 true,
        message:                 "Order approved, raw stock deducted, elastic stock reserved",
        fingerprint:             approveFp,
        deductionFingerprints,
        reservationFingerprints,
      });

      // Owner WhatsApp pings — fire-and-forget AFTER the response so
      // a slow/failed notification can never delay the request. Two
      // separate events:
      //   • orderApproved       — always, for the normal happy-path
      //                           approve. Skipped when force=true so
      //                           it doesn't double up with the force
      //                           variant.
      //   • orderForceApproved — only when force=true (stock guard
      //                           override). Carries the reason.
      // The webhook-driven path also passes whatsappActor.from in
      // the body so the audit message tells the owner which channel
      // initiated the approval.
      (async () => {
        try {
          const cust = order.customer
            ? await Customer.findById(order.customer).select("name").lean()
            : null;
          const actorName = actorFromRequest(req)?.name || "Admin";
          const via = req.body?.whatsappActor?.from
            ? `WhatsApp (${req.body.whatsappActor.from})`
            : "Admin app";
          const totalMeters = (order.elasticOrdered || [])
            .reduce((s, e) => s + (Number(e.quantity) || 0), 0);

          const auditContext = {
            _entity: { type: "Order", id: order._id },
            _actor:  { id: req.user?._id, name: actorName, via },
          };
          if (force) {
            const result = await notify("orderForceApproved", {
              orderNo:      order.orderNo,
              customerName: cust?.name,
              by:           actorName,
              reason:       forceReason || "(no reason given)",
              via,
              ...auditContext,
            });
            console.log(`[notify:orderForceApproved] order=${order.orderNo} →`, JSON.stringify(result));
          } else {
            const result = await notify("orderApproved", {
              orderNo:      order.orderNo,
              customerName: cust?.name,
              totalMeters,
              by:           actorName,
              via,
              supplyDate:   order.supplyDate,
              ...auditContext,
            });
            console.log(`[notify:orderApproved] order=${order.orderNo} →`, JSON.stringify(result));
          }

          // Per-material critical-stockout pings — fire after the
          // transaction has committed so we never alert on a write
          // that subsequently got rolled back.
          const { maybeFireCriticalStockout } = require("../utils/inventoryAlerts");
          for (const snap of stockoutSnapshots) {
            const fresh = await RawMaterial.findById(snap.materialId).select("name category minStock _id");
            if (!fresh) continue;
            await maybeFireCriticalStockout({
              material:  fresh,
              oldStock:  snap.oldStock,
              newStock:  snap.newStock,
              reason:    `Order #${order.orderNo ?? ""} approval`,
            });
          }
        } catch (err) {
          console.warn(`[notify:order-approved-hooks] crashed: ${err?.message}`);
        }
      })();
    } catch (error) {
      // withTransaction has already aborted; only the session is ours to close.
      return next(error);
    } finally {
      session.endSession();
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  CANCEL ORDER
//
//  Releases any remaining elastic reservations AND refunds raw
//  materials previously deducted during /approve. The refund walks
//  the order's MaterialOutward records (which carry the actually-
//  applied quantity — correct under force-approval where less than
//  requiredWeight was drawn). Refund only happens for Approved /
//  InProgress orders; Open orders never deducted anything.
// ════════════════════════════════════════════════════════════════
router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, cancelReason } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      let snapshot; // populated inside the txn for the post-response notification
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);

        if (!["Open", "Approved", "InProgress"].includes(order.status)) {
          throw new ErrorHandler(
            `Cannot cancel an order with status "${order.status}"`,
            400
          );
        }

        const previousStatus = order.status;
        const actor = actorFromRequest(req);

        const released = await _releaseAllReservations(
          session,
          order,
          actor,
          "order cancelled"
        );

        const refunded = previousStatus === "Open"
          ? []
          : await _refundRawMaterialsForOrder(
              session,
              order,
              actor,
              req.user?._id,
            );

        order.status      = "Cancelled";
        order.cancelledBy = req.user?._id || null;
        order.cancelledAt = new Date();

        // Capture the cancel reason on the audit fingerprint when
        // the caller supplied one. The WhatsApp inbound webhook will
        // pass it through as part of the body; the admin app is
        // expected to prompt for it for any non-Open cancel.
        const fp = buildFingerprint(ACTION_CODES.ORDER_CANCELLED, {
          entityId: order._id,
          actor,
          meta: {
            previousStatus,
            newStatus: "Cancelled",
            releasedReservations: released.length,
            refundedMaterials:    refunded.length,
            reason:               cancelReason ? String(cancelReason).trim() : undefined,
            via:                  req.body?.whatsappActor?.from ? "whatsapp" : "admin",
            whatsappFrom:         req.body?.whatsappActor?.from || undefined,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        snapshot = {
          orderNo:      order.orderNo,
          customer:     order.customer,
          previousStatus,
          released:     released.length,
          refunded:     refunded.length,
          reason:       cancelReason ? String(cancelReason).trim() : undefined,
          via:          req.body?.whatsappActor?.from
            ? `WhatsApp (${req.body.whatsappActor.from})`
            : "Admin app",
          actorName:    actor?.name || "Admin",
          actorId:      req.user?._id || null,
        };

        resp = {
          orderId: order._id,
          status:  order.status,
          fingerprint: fp,
          releasedReservations: released,
          refundedMaterials:    refunded,
        };
      });

      res.status(200).json({ success: true, message: "Order cancelled", ...resp });

      // Owner WhatsApp ping — fire-and-forget AFTER the response so
      // a slow notification can never delay or break a cancel. Skip
      // when the actor is themselves the recipient (you don't ping
      // yourself for an action you just took in the app).
      if (snapshot) {
        (async () => {
          try {
            const cust = snapshot.customer
              ? await Customer.findById(snapshot.customer).select("name").lean()
              : null;
            const result = await notify("orderCancelled", {
              orderNo:              snapshot.orderNo,
              customerName:         cust?.name,
              previousStatus:       snapshot.previousStatus,
              releasedReservations: snapshot.released,
              refundedMaterials:    snapshot.refunded,
              reason:               snapshot.reason || "(not provided)",
              by:                   snapshot.actorName,
              via:                  snapshot.via,
              _entity: { type: "Order", id: resp.orderId },
              _actor:  { id: snapshot.actorId, name: snapshot.actorName, via: snapshot.via },
            });
            console.log(`[notify:orderCancelled] order=${snapshot.orderNo} →`, JSON.stringify(result));
          } catch (err) {
            console.warn(`[notify:orderCancelled] hook crashed: ${err?.message}`);
          }
        })();
      }
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  START PRODUCTION  (Approved → InProgress)
// ════════════════════════════════════════════════════════════════
router.post(
  "/start-production",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (order.status !== "Approved") {
      return next(new ErrorHandler("Order must be Approved before starting production", 400));
    }

    order.status    = "InProgress";
    order.startedBy = req.user?._id || null;
    order.startedAt = new Date();

    const fp = buildFingerprint(ACTION_CODES.ORDER_PRODUCTION_STARTED, {
      entityId: order._id,
      actor:    actorFromRequest(req),
      meta:     { previousStatus: "Approved", newStatus: "InProgress" },
    });
    order.fingerprints.push(fp);
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order moved to InProgress",
      status:  order.status,
      fingerprint: fp,
    });

    // Owner WhatsApp ping — fire-and-forget. Confirms operations
    // actually picked up the order vs. it sitting in Approved limbo.
    //
    // Edge case: if production starts within 60s of approval (e.g.
    // an automated planner kicked in), the back-to-back pings read
    // weirdly ("approved then started one second later"). Skip in
    // that window — owner already got the approve ping; the start
    // is implied.
    (async () => {
      try {
        const approvedTooRecent = order.approvedAt &&
          (Date.now() - new Date(order.approvedAt).getTime() < 60_000);
        if (approvedTooRecent) {
          console.log(`[notify:orderProductionStarted] order=${order.orderNo} → skipped: approve was <60s ago`);
          return;
        }
        const cust = order.customer
          ? await Customer.findById(order.customer).select("name").lean()
          : null;
        const totalMeters = (order.elasticOrdered || [])
          .reduce((s, e) => s + (Number(e.quantity) || 0), 0);
        const actorName = actorFromRequest(req)?.name || "Admin";
        const result = await notify("orderProductionStarted", {
          orderNo:      order.orderNo,
          customerName: cust?.name,
          totalMeters,
          by:           actorName,
          via:          "Admin app",
          _entity: { type: "Order", id: order._id },
          _actor:  { id: req.user?._id, name: actorName },
        });
        console.log(`[notify:orderProductionStarted] order=${order.orderNo} →`, JSON.stringify(result));
      } catch (err) {
        console.warn(`[notify:orderProductionStarted] hook crashed: ${err?.message}`);
      }
    })();
  })
);


// ════════════════════════════════════════════════════════════════
//  COMPLETE ORDER
//
//  PR E: releases any remaining elastic reservations. Useful when
//  a customer accepts a partial delivery and the order is closed
//  with un-dispatched units still reserved.
// ════════════════════════════════════════════════════════════════
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);

        if (order.status !== "InProgress") {
          throw new ErrorHandler("Only InProgress orders can be completed", 400);
        }

        const actor = actorFromRequest(req);
        const released = await _releaseAllReservations(
          session,
          order,
          actor,
          "order completed"
        );

        order.status      = "Completed";
        order.completedBy = req.user?._id || null;
        order.completedAt = new Date();

        const fp = buildFingerprint(ACTION_CODES.ORDER_COMPLETED, {
          entityId: order._id,
          actor,
          meta: {
            previousStatus: "InProgress",
            newStatus:      "Completed",
            releasedReservations: released.length,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        // Snapshot for the post-response notification.
        resp = {
          status: order.status,
          fingerprint: fp,
          releasedReservations: released,
          // captured for the hook outside the txn
          _orderNo:       order.orderNo,
          _customer:      order.customer,
          _totalMeters:   (order.elasticOrdered || [])
            .reduce((s, e) => s + (Number(e.quantity) || 0), 0),
          _onTime:        order.supplyDate ? order.completedAt <= new Date(order.supplyDate) : undefined,
          _actorName:     actor?.name || "Admin",
          _orderId:       order._id,
        };
      });

      res.status(200).json({
        success: true,
        message: "Order completed",
        status:  resp.status,
        fingerprint:          resp.fingerprint,
        releasedReservations: resp.releasedReservations,
      });

      // Owner WhatsApp ping — confirms revenue-recognition moment.
      // Edge case: if a dcDelivered ping just fired for this same
      // order (within the last hour), skip — the owner already saw
      // "your order is done"; doubling up reads as system noise.
      (async () => {
        try {
          const recentDc = await Notification.findOne({
            event:       "dcDelivered",
            "entity.id": resp._orderId,
            status:      "sent",
            createdAt:   { $gte: new Date(Date.now() - 60 * 60 * 1000) },
          }).lean();
          if (recentDc) {
            console.log(`[notify:orderCompleted] order=${resp._orderNo} → skipped: dcDelivered fired ${Math.round((Date.now() - new Date(recentDc.createdAt).getTime()) / 1000)}s ago`);
            return;
          }
          const cust = resp._customer
            ? await Customer.findById(resp._customer).select("name").lean()
            : null;
          const result = await notify("orderCompleted", {
            orderNo:              resp._orderNo,
            customerName:         cust?.name,
            totalMeters:          resp._totalMeters,
            releasedReservations: resp.releasedReservations?.length || 0,
            onTime:               resp._onTime,
            by:                   resp._actorName,
            via:                  "Admin app",
            _entity: { type: "Order", id: resp._orderId },
            _actor:  { id: req.user?._id, name: resp._actorName },
          });
          console.log(`[notify:orderCompleted] order=${resp._orderNo} →`, JSON.stringify(result));
        } catch (err) {
          console.warn(`[notify:orderCompleted] hook crashed: ${err?.message}`);
        }
      })();
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  UPDATE ORDER  (Open state only)
// ════════════════════════════════════════════════════════════════
router.post(
  "/update-order",
  catchAsyncErrors(async (req, res, next) => {
    const {
      orderId,
      po, supplyDate, description, customer, elasticOrdered,
    } = req.body;
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);
        // Optimistic lock: reject the edit if another user saved since
        // this client loaded the order (409 → client reloads).
        assertVersion(order, req);
        if (order.status !== "Open") {
          throw new ErrorHandler(
            `Only Open orders can be edited (current: "${order.status}"). ` +
            `Cancel and recreate to change an approved order.`,
            400
          );
        }

        const changed = {};
        const previousValues = {};
        if (po !== undefined && po !== order.po) {
          previousValues.po = order.po;          order.po          = po;          changed.po          = po;
        }
        if (supplyDate !== undefined && supplyDate !== "" && !isNaN(new Date(supplyDate).getTime())
            && new Date(supplyDate).getTime() !== new Date(order.supplyDate).getTime()) {
          previousValues.supplyDate = order.supplyDate; order.supplyDate = new Date(supplyDate); changed.supplyDate = supplyDate;
        }
        if (description !== undefined && description !== order.description) {
          previousValues.description = order.description; order.description = description; changed.description = description;
        }
        if (customer !== undefined && String(customer) !== String(order.customer)) {
          previousValues.customer = order.customer?.toString?.(); order.customer = customer; changed.customer = customer;
        }

        if (Array.isArray(elasticOrdered) && elasticOrdered.length > 0) {
          previousValues.elasticOrdered = order.elasticOrdered.map((e) => ({
            elastic:  e.elastic.toString(),
            quantity: e.quantity,
          }));

          const rawMaterialRequired = await computeRawMaterialRequired(elasticOrdered);

          order.elasticOrdered      = elasticOrdered;
          order.pendingElastic      = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: e.quantity }));
          order.producedElastic     = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
          order.packedElastic       = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
          order.rawMaterialRequired = rawMaterialRequired;
          order.updatedItemsAt      = new Date();
          changed.elasticOrdered    = `${elasticOrdered.length} item(s)`;
        }

        if (Object.keys(changed).length === 0) {
          throw new ErrorHandler("No editable fields supplied", 400);
        }

        const fp = buildFingerprint(ACTION_CODES.ORDER_UPDATED, {
          entityId: order._id,
          actor:    actorFromRequest(req),
          meta: {
            changedFields: Object.keys(changed),
            previousValues,
            newValues:     changed,
            auditReason,
          },
        });
        order.fingerprints.push(fp);
        order.increment(); // bump __v so concurrent editors get a 409
        await order.save({ session });

        resp = { order, fingerprint: fp };
      });
      res.status(200).json({
        success: true,
        message: "Order updated",
        order:   resp.order,
        fingerprint: resp.fingerprint,
      });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  DELETE ORDER  (soft-delete; Open state only, no jobs)
// ════════════════════════════════════════════════════════════════
router.post(
  "/delete-order",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);
        if (order.status !== "Open") {
          throw new ErrorHandler(
            `Only Open orders can be deleted (current: "${order.status}"). ` +
            `Use cancel for approved/in-progress orders.`,
            400
          );
        }
        if ((order.jobs || []).length > 0) {
          throw new ErrorHandler(
            `Cannot delete an order with jobs (${order.jobs.length}). Cancel the jobs first.`,
            400
          );
        }

        const previousStatus = order.status;
        order.status    = "Deleted";
        order.deletedBy = req.user?._id || null;
        order.deletedAt = new Date();

        const fp = buildFingerprint(ACTION_CODES.ORDER_DELETED, {
          entityId: order._id,
          actor:    actorFromRequest(req),
          meta: {
            previousStatus,
            newStatus: "Deleted",
            auditReason,
            orderNo:   order.orderNo,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        resp = { fingerprint: fp, orderId: order._id, status: order.status };
      });
      res.status(200).json({ success: true, message: "Order deleted", ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);


// ════════════════════════════════════════════════════════════════
//  GET OPEN ORDERS
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-open-orders",
  catchAsyncErrors(async (req, res, next) => {
    const openOrders = await Order.find({ status: "Open" })
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, openOrders });
  })
);


// ════════════════════════════════════════════════════════════════
//  GET PENDING (APPROVED) ORDERS
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-pending-orders",
  catchAsyncErrors(async (req, res, next) => {
    const pending = await Order.find({ status: "Approved" })
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, pending });
  })
);


// ══════════════════════════════════════════════════════════════
//  GET /delivery-risk?horizonDays=7
//  Orders whose supplyDate lands inside the horizon and still
//  have outstanding production (pendingElastic total > 0). Powers
//  the AIAdvisor "delivery risk" card on the admin dashboard.
//
//  Status filter excludes Completed, Cancelled, Deleted — those
//  are not going to ship anyway.
// ══════════════════════════════════════════════════════════════
router.get('/delivery-risk', async (req, res) => {
  try {
    const horizon = Math.max(1, parseInt(req.query.horizonDays, 10) || 7);
    const now     = new Date();
    const cutoff  = new Date(now.getTime() + horizon * 86_400_000);

    const orders = await Order.find({
      status:     { $in: ['Open', 'Approved', 'InProgress'] },
      supplyDate: { $lte: cutoff },
    })
      .select('orderNo customer status supplyDate pendingElastic')
      .populate('customer', 'name')
      .lean();

    const at_risk = [];
    for (const o of orders) {
      const pendingUnits = (o.pendingElastic || []).reduce(
        (sum, p) => sum + (Number(p.quantity) || 0),
        0
      );
      if (pendingUnits <= 0) continue;
      const daysToSupply = Math.ceil(
        (new Date(o.supplyDate).getTime() - now.getTime()) / 86_400_000
      );
      at_risk.push({
        orderId:      o._id,
        orderNo:      o.orderNo,
        customerName: o.customer?.name ?? '—',
        status:       o.status,
        supplyDate:   o.supplyDate,
        daysToSupply,
        pendingUnits,
      });
    }
    at_risk.sort((a, b) => a.daysToSupply - b.daysToSupply);

    return res.json({
      success: true,
      horizonDays: horizon,
      orders:  at_risk,
      count:   at_risk.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/order/estimate-completion
//  Live ETA for an order while the admin is still typing it. Reads
//  recent production + attendance + machine state, feeds the pure
//  heuristic in utils/orderEta.js. Read-only — safe to call on every
//  keystroke (frontend debounces).
//
//  Body:
//    {
//      elasticOrdered: [{ elastic: id, quantity: meters }, ...],
//      supplyDate?: ISO date (optional, for risk chip),
//      machines?:   number   (optional, override default parallelism)
//    }
// ═════════════════════════════════════════════════════════════════
router.post(
  "/estimate-completion",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const { elasticOrdered, supplyDate, machines } = req.body || {};
    if (!Array.isArray(elasticOrdered) || elasticOrdered.length === 0) {
      return res.status(400).json({
        success: false,
        message: "elasticOrdered must be a non-empty array of { elastic, quantity }",
      });
    }

    const now = new Date();

    // Gather + shape the plant/elastic/machine/attendance aggregates
    // (services/etaService.js) — one round-trip block, no req/res.
    const { aggregates, summary } = await buildEntryTimeAggregates(elasticOrdered, now);

    const result = estimateOrderEta({
      lines: elasticOrdered,
      machines,
      supplyDate,
      today: now,
      aggregates,
    });

    return res.json({
      success: true,
      ...result,
      aggregates: summary,
    });
  }),
);

// ETA engine (_computeRunningEtaForOrder, _fallbackEntryTimeEta,
// _loadPlantMetersPerMachineDay, _loadFreeMachineCount) moved to
// services/etaService.js — imported at the top of this file.

// ═════════════════════════════════════════════════════════════════
//  GET /api/v2/order/:id/running-eta
//
//  Live ETA for an in-flight order. Uses the per-(elastic, machine)
//  Bayesian rate posterior when available, falling back to the
//  plant-wide blended rate (then cold-start) when the posterior
//  doesn't have enough data for a pair yet.
//
//  Returned shape mirrors the Add-Order /estimate-completion route
//  enough that the frontend can share a card widget, plus a
//  perJob breakdown so the admin can see which job is dragging the
//  order late.
// ═════════════════════════════════════════════════════════════════
router.get(
  "/:id/running-eta",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const orderId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const now = new Date();
    const [plantMetersPerMachineDay, freeMachines] = await Promise.all([
      _loadPlantMetersPerMachineDay(now),
      _loadFreeMachineCount(),
    ]);
    const result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);

    return res.json({
      success: true,
      orderId: order._id,
      orderNo: order.orderNo,
      status:  order.status,
      ...result,
    });
  }),
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/order/running-eta-bulk
//
//  Compact ETA summary for many orders at once. Used by the order
//  list to render a per-row chip without N+1 round trips. Returns
//  one entry per order id including those not in an in-flight
//  state — the frontend decides whether to render a chip or not.
//
//  Body: { orderIds: [id, id, ...] }   max 50
// ═════════════════════════════════════════════════════════════════
router.post(
  "/running-eta-bulk",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : null;
    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "orderIds must be a non-empty array",
      });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({
        success: false,
        message: "orderIds capped at 50 per request",
      });
    }

    const validIds = orderIds
      .filter((id) => typeof id === "string" && mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const orders = await Order.find({ _id: { $in: validIds } })
      .select({ _id: 1, orderNo: 1, status: 1, supplyDate: 1 })
      .lean();
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    const now = new Date();
    // Only load plant rate if we have at least one in-flight order to
    // compute — avoids a useless aggregation on lists of only Open or
    // Completed orders.
    const inFlight = orders.filter(
      (o) => o.status === "Approved" || o.status === "InProgress"
    );
    const [plantMetersPerMachineDay, freeMachines] = inFlight.length > 0
      ? await Promise.all([_loadPlantMetersPerMachineDay(now), _loadFreeMachineCount()])
      : [null, 1];

    const etas = {};
    for (const id of orderIds) {
      const order = orderById.get(String(id));
      if (!order) {
        etas[id] = { ok: false, reason: "NOT_FOUND" };
        continue;
      }
      if (order.status !== "Approved" && order.status !== "InProgress") {
        etas[id] = { ok: false, reason: "NOT_RUNNING", status: order.status };
        continue;
      }
      // Per-order try/catch so a single bad order can't poison the
      // whole batch — frontend chip just shows "ETA error" for that
      // row instead of every row failing.
      let result;
      try {
        result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);
      } catch (err) {
        console.warn(
          "[running-eta-bulk] order", String(id), "failed:", err?.message
        );
        etas[id] = { ok: false, reason: "COMPUTE_ERROR", message: err?.message };
        continue;
      }
      if (result.ok) {
        etas[id] = {
          ok: true,
          expectedDate: result.expectedDate,
          workingDays:  result.workingDays,
          weavingDays:  result.weavingDays,
          leadDays:     result.leadDays,
          late:           result.risk?.late === true,
          lateWorkingDays: result.risk?.lateWorkingDays || 0,
          rateSources:  result.rateSources,
        };
      } else {
        etas[id] = { ok: false, reason: result.reason || "UNKNOWN" };
      }
    }

    return res.json({ success: true, etas });
  }),
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/v2/order/eta-risks
//
//  Proactive delivery-risk detection: for every in-flight order, run
//  the ML ETA and surface the ones whose predicted completion slips
//  PAST the promised supply date (not just "date is near" — actually
//  predicted late). Each risk comes with a ready-to-send customer
//  message draft, so the admin approves & sends (human-in-the-loop)
//  instead of chasing manually.
// ═════════════════════════════════════════════════════════════════
function _fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}
function _draftCustomerUpdate({ customerName, orderNo, expectedDate, promised, lateWorkingDays }) {
  const name = customerName && customerName !== '—' ? customerName : 'Sir/Madam';
  return (
    `Dear ${name}, an update on your order #${orderNo}: based on current production ` +
    `progress we now expect completion around ${_fmtDate(expectedDate)}, about ` +
    `${lateWorkingDays} working day${lateWorkingDays === 1 ? '' : 's'} later than the planned ` +
    `${_fmtDate(promised)}. We are prioritising it and will keep you updated. ` +
    `Thank you for your patience.`
  );
}

// ══════════════════════════════════════════════════════════════
//  ORDER STATUS REPORT
//
//  GET /:id/status-report      — the computed report as JSON
//  GET /:id/status-report.pdf  — the same report as a printed sheet
//
//  Both are fed by services/orderStatusReport.js, so the screen and the
//  paper can never tell different stories.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/status-report',
  catchAsyncErrors(async (req, res, next) => {
    const data = await buildOrderStatusReport(req.params.id);
    if (!data) return next(new ErrorHandler('Order not found', 404));
    res.json({ success: true, data });
  })
);

router.get(
  '/:id/status-report.pdf',
  catchAsyncErrors(async (req, res, next) => {
    const data = await buildOrderStatusReport(req.params.id);
    if (!data) return next(new ErrorHandler('Order not found', 404));

    data.branding = await getPdfBranding();
    const pdf = await buildOrderStatusPdf(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="order-status-${data.orderNo ?? req.params.id}.pdf"`
    );
    res.send(pdf);
  })
);

// ══════════════════════════════════════════════════════════════
//  ORDER-LEVEL MATERIAL REQUIREMENT
//
//  GET  /:id/mrp       — what the whole order needs, and what is short
//  POST /:id/raise-po  — buy the gap, one PO per supplier
//
//  The job-level MRP answers "what does this run need". This answers
//  "what does the whole order need", which is the question asked before
//  the work is split into jobs at all — and the point at which yarn
//  actually has to be bought.
//
//  Computed from elasticOrdered, so it covers the entire order including
//  quantities no job has been raised for yet. The two views deliberately
//  disagree while an order is part-planned; that difference is the
//  unplanned quantity, and it is the thing worth seeing.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/mrp',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id)
      .select('orderNo po date supplyDate status elasticOrdered customer')
      .populate('customer', 'name')
      .lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    // Approval already took this order's material out of stock, so the
    // sheet has to know what it drew — otherwise it reads the reduced
    // balance as a shortage and offers to buy the same yarn again.
    const materials = await computeMaterialRequirement(order.elasticOrdered || [], {
      allocated: await issuedForOrder(order._id),
    });

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        customerPo: order.po || '',
        customerName: order.customer?.name || '',
        status: order.status,
        materials,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /:id/yarn-lots — the dye lots this order's goods will carry
//
//  Shade complaints arrive quoting an order or a delivery note, not a
//  warping batch, so the trail has to be answerable from this end too.
//  It rolls up every job on the order: the lots each job's warping
//  programme committed to, and the lots its batches actually issued.
//
//  Sections whose lot has not been chosen are counted, not hidden. An
//  order two beams short of a decision looks exactly like a settled one
//  otherwise, and that is the state worth seeing before the machine
//  starts.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/yarn-lots',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id).select('orderNo').lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    // Read the jobs by their order ref rather than the order's `jobs`
    // array: the ref is the one a job cannot be created without.
    const jobs = await Job.find({ order: order._id })
      .select('jobOrderNo status elastics')
      .populate('elastics.elastic', 'name')
      .sort({ jobOrderNo: 1 })
      .lean();

    const jobIds = jobs.map((j) => j._id);
    const [planned, batches] = await Promise.all([
      plannedLotsByJob(jobIds),
      WarpingBatch.find({ job: { $in: jobIds } })
        .select('job batchNo status beamNos issuedDate allocations elastics')
        .populate('elastics', 'name')
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const issuedByJob = new Map(jobIds.map((id) => [String(id), []]));
    for (const b of batches) {
      // Cancelled batches went back on the rack; they are not in the goods.
      if (b.status === 'cancelled') continue;
      const bucket = issuedByJob.get(String(b.job));
      if (!bucket) continue;
      const names = (b.elastics || []).map((e) => e.name).filter(Boolean);
      for (const a of b.allocations || []) {
        bucket.push({
          source: 'issued',
          batchId: b._id,
          batchNo: b.batchNo,
          batchStatus: b.status,
          beamNos: b.beamNos || [],
          yarnLot: a.yarnLot,
          lotNo: a.lotNo || '',
          shade: a.shade || '',
          materialName: a.materialName || '',
          quantity: a.quantity,
          elasticNames: names,
          issuedDate: b.issuedDate || null,
        });
      }
    }

    const byJob = jobs.map((j) => {
      const trail = planned.get(String(j._id)) || emptyTrail();
      return {
        jobId: String(j._id),
        jobOrderNo: j.jobOrderNo,
        jobNo: `J-${j.jobOrderNo}`,
        status: j.status,
        elastics: (j.elastics || [])
          .map((e) => e.elastic?.name)
          .filter(Boolean),
        planned: trail.entries,
        issued: issuedByJob.get(String(j._id)) || [],
        sections: trail.sections,
        openBeamNos: trail.openBeamNos,
      };
    });

    const allRows = byJob.flatMap((j) => [...j.planned, ...j.issued]);
    const sections = byJob.reduce(
      (acc, j) => ({
        total: acc.total + j.sections.total,
        withLot: acc.withLot + j.sections.withLot,
        open: acc.open + j.sections.open,
      }),
      { total: 0, withLot: 0, open: 0 }
    );

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        byJob,
        lots: distinctLots(allRows),
        sections,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /:id/delivery-challans — what has actually left the building
//
//  The order detail page could say what was ordered, planned, produced
//  and packed, and then stopped. Whether any of it had been DESPATCHED
//  — and against which delivery note — could only be answered by
//  leaving the order, opening the DC list and searching it by order
//  number. That is the question customers ring up about.
//
//  Matched on the reference AND the number snapshot. A DC carries both
//  (`order` and `orderNo`), and older rows can have one without the
//  other; matching on the reference alone would quietly drop them, and
//  a despatch list that is silently incomplete is worse than none. The
//  order number is unique, so the number match cannot pull in somebody
//  else's note.
//
//  Cancelled notes are listed but excluded from the despatched totals.
//  They are part of the history of the order — somebody raised them,
//  and "why is there a gap in the DC numbers" has to have an answer —
//  but nothing left the building on them.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/delivery-challans',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id)
      .select('orderNo elasticOrdered')
      .populate('elasticOrdered.elastic', 'name')
      .lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    const match = [{ order: order._id }];
    if (order.orderNo != null) match.push({ orderNo: order.orderNo });

    const dcs = await DeliveryChallan.find({ $or: match })
      .select('dcNumber date dispatchDate status type items totalQuantity ' +
              'totalAmount vehicleNo transporter lrNumber customerName createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const LIVE = (dc) => dc.status !== 'cancelled';

    // What has gone out, per elastic, so the panel can sit the despatched
    // quantity next to what was ordered rather than leaving the reader to
    // add up the notes themselves.
    const dispatchedByElastic = new Map();
    for (const dc of dcs) {
      if (!LIVE(dc)) continue;
      for (const item of dc.items || []) {
        if (!item.elastic) continue;
        const key = String(item.elastic);
        const row = dispatchedByElastic.get(key) || { quantity: 0, name: item.elasticName || '' };
        row.quantity += Number(item.quantity) || 0;
        if (!row.name && item.elasticName) row.name = item.elasticName;
        dispatchedByElastic.set(key, row);
      }
    }

    const lines = (order.elasticOrdered || []).map((l) => {
      const key = String(l.elastic?._id || l.elastic);
      const sent = dispatchedByElastic.get(key);
      const ordered = Number(l.quantity) || 0;
      const dispatched = sent ? sent.quantity : 0;
      return {
        elasticId:   key,
        elasticName: l.elastic?.name || sent?.name || '',
        ordered,
        dispatched,
        // Negative would mean more went out than was ordered, which
        // happens and is worth seeing rather than clamping away.
        pending: Math.round((ordered - dispatched) * 1000) / 1000,
      };
    });

    const live = dcs.filter(LIVE);

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        dcs: dcs.map((dc) => ({
          id:            String(dc._id),
          dcNumber:      dc.dcNumber,
          date:          dc.date || dc.createdAt || null,
          dispatchDate:  dc.dispatchDate || null,
          status:        dc.status,
          type:          dc.type,
          customerName:  dc.customerName || '',
          totalQuantity: Number(dc.totalQuantity) || 0,
          totalAmount:   Number(dc.totalAmount) || 0,
          vehicleNo:     dc.vehicleNo || '',
          transporter:   dc.transporter || '',
          lrNumber:      dc.lrNumber || '',
          items: (dc.items || []).map((i) => ({
            elasticId:   i.elastic ? String(i.elastic) : null,
            elasticName: i.elasticName || i.description || '',
            quantity:    Number(i.quantity) || 0,
            unit:        i.unit || 'm',
          })),
        })),
        lines,
        totals: {
          count:      dcs.length,
          cancelled:  dcs.length - live.length,
          quantity:   Math.round(live.reduce((s, d) => s + (Number(d.totalQuantity) || 0), 0) * 1000) / 1000,
          ordered:    lines.reduce((s, l) => s + l.ordered, 0),
          dispatched: Math.round(lines.reduce((s, l) => s + l.dispatched, 0) * 1000) / 1000,
        },
      },
    });
  })
);

router.post(
  '/:id/raise-po',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id)
      .select('orderNo elasticOrdered status')
      .lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    // Buying for an order happens BEFORE it is approved. Approval
    // allocates the stock to the order — takes it out of the balance
    // and holds it — so from that point the order's material question
    // is settled and a purchase raised against it would be buying for
    // a requirement already met.
    //
    // A forced approval is the exception the rule has to survive: it
    // allocated only what was there, and the rest is genuinely owed.
    // That gap is bought from the job that needs it or from the
    // purchase-order screen directly, both of which stay open — this
    // route is the one that used to double up, because it is the one
    // sitting next to the requirement.
    if (order.status !== 'Open') {
      const err = new ErrorHandler(
        `Stock for order #${order.orderNo} was allocated when it was approved — ` +
        `raise purchase orders before approval, or from the job that needs the material.`,
        400
      );
      err.code = 'ORDER_ALREADY_APPROVED';
      return next(err);
    }

    const requirement = await computeMaterialRequirement(order.elasticOrdered || [], {
      allocated: await issuedForOrder(order._id),
    });
    const { orderable, noSupplier, unresolved, anyShort, awaitingDelivery } =
      triageShortfall(requirement, req.body?.materials);

    if (!anyShort) {
      return next(new ErrorHandler(
        awaitingDelivery.length
          ? `Already on order — ${awaitingDelivery
              .map((m) => m.name)
              .join(', ')} ${awaitingDelivery.length === 1 ? 'is' : 'are'} short but bought and awaiting delivery.`
          : 'Nothing is short on this order — no purchase order to raise.',
        400
      ));
    }
    if (orderable.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'None of the short materials has a supplier set — set one before raising a PO.',
        skipped: skipReasons(unresolved, noSupplier),
      });
    }

    const created = await createShortfallPos(
      orderable,
      { forOrder: order._id },
      {
        expectedDate: req.body?.expectedDate,
        notes: req.body?.notes,
        defaultNote: `Raised for order #${order.orderNo} material shortfall`,
      }
    );

    try {
      const doc = await Order.findById(order._id);
      if (doc) {
        // buildFingerprint + push: this router imports the builder, not
        // the stamper, and the two produce the same row.
        doc.fingerprints.push(buildFingerprint(ACTION_CODES.PO_RAISED, {
          entityId: doc._id,
          actor: actorFromRequest(req),
          meta: {
            source: 'order-mrp-shortfall',
            purchaseOrders: created.map((c) => ({ poNo: c.poNo, supplier: c.supplierName })),
          },
        }));
        await doc.save();
      }
    } catch (fpErr) {
      console.warn('[order raise-po] fingerprint failed:', fpErr.message);
    }

    res.status(201).json({
      success: true,
      purchaseOrders: created,
      skipped: skipReasons(unresolved, noSupplier),
    });
  })
);

router.get(
  '/:id/purchase-orders',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    // Everything bought for this order, including POs raised from one of
    // its jobs — from the order's point of view they are the same spend.
    const pos = await PurchaseOrder.find({ forOrder: req.params.id })
      .populate('supplier', 'name')
      .populate('items.rawMaterial', 'name')
      .populate('forJob', 'jobOrderNo')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, purchaseOrders: pos });
  })
);

router.get(
  '/eta-risks',
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const now = new Date();
    const orders = await Order.find({ status: { $in: ['Approved', 'InProgress'] } })
      .select('orderNo status supplyDate customer elasticOrdered producedElastic')
      .populate('customer', 'name phoneNumber')
      .lean();

    if (orders.length === 0) {
      return res.json({ success: true, count: 0, generatedAt: now, risks: [] });
    }

    const [plantMetersPerMachineDay, freeMachines] = await Promise.all([
      _loadPlantMetersPerMachineDay(now),
      _loadFreeMachineCount(),
    ]);
    const risks = [];
    for (const order of orders) {
      let result;
      try {
        result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);
      } catch (err) {
        console.warn('[eta-risks] order', String(order._id), 'failed:', err?.message);
        continue;
      }
      if (!result.ok || !result.risk?.late) continue;
      const lateWorkingDays = result.risk.lateWorkingDays || 0;
      risks.push({
        orderId:         order._id,
        orderNo:         order.orderNo,
        status:          order.status,
        customer:        { name: order.customer?.name || '—', phone: order.customer?.phoneNumber || null },
        promised:        order.supplyDate,
        expectedDate:    result.expectedDate,
        workingDays:     result.workingDays,
        lateWorkingDays,
        draft: _draftCustomerUpdate({
          customerName: order.customer?.name,
          orderNo: order.orderNo,
          expectedDate: result.expectedDate,
          promised: order.supplyDate,
          lateWorkingDays,
        }),
      });
    }
    risks.sort((a, b) => b.lateWorkingDays - a.lateWorkingDays);

    // Upgrade the template drafts to genuinely AI-written messages when a
    // Claude key is configured. One call for all risks; on any failure we
    // keep the deterministic template so the feature never breaks.
    const claude = anthropic();
    let aiDrafted = false;
    if (claude && risks.length) {
      try {
        const message = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 1024,
          system:
            "You are a courteous customer-relations rep for an elastic (narrow-fabric) " +
            "manufacturer. For each order, write a short, warm, professional WhatsApp message " +
            "telling the customer their order will be slightly delayed. 2-3 sentences, plain " +
            "text, no emojis, no placeholders/brackets. Use the EXACT dates provided, apologise " +
            "briefly, and reassure them it's being prioritised.",
          messages: [{
            role: "user",
            content:
              'Return ONLY JSON: {"messages":[{"orderNo":<number>,"message":"..."}]}\n\nOrders:\n' +
              risks.map((r) =>
                `- Order #${r.orderNo}, customer ${r.customer.name}, promised ${_fmtDate(r.promised)}, ` +
                `now expected ${_fmtDate(r.expectedDate)} (${r.lateWorkingDays} working days late).`
              ).join("\n"),
          }],
        });
        const text = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed && Array.isArray(parsed.messages)) {
          const byNo = new Map(parsed.messages.map((x) => [String(x.orderNo), x.message]));
          for (const r of risks) {
            const msg = byNo.get(String(r.orderNo));
            if (msg && typeof msg === "string" && msg.trim()) { r.draft = msg.trim(); r.aiDrafted = true; }
          }
          aiDrafted = true;
        }
      } catch (err) {
        console.warn("[eta-risks] AI draft failed, using templates:", err?.message);
      }
    }

    return res.json({ success: true, count: risks.length, generatedAt: now, aiDrafted, risks });
  }),
);

// Expose the per-order ETA computation + plant-rate loader so utility
// modules (utils/digest.js) can reuse the exact same math the route
// returns to clients — no duplication, identical numbers across the
// app and the WhatsApp digest.
router._etaHelpers = {
  _computeRunningEtaForOrder,
  _loadPlantMetersPerMachineDay,
};

module.exports = router;

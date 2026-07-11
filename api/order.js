const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const router = express.Router();
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const RawMaterial     = require("../models/RawMaterial.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const { requireReason } = require("../utils/auditReason.js");
const { applyMovement } = require("../utils/elasticStock.js");
const ShiftDetail        = require("../models/ShiftDetail.js");
const Attendance         = require("../models/Attendence.js");
const Machine            = require("../models/Machine.js");
const { estimateOrderEta } = require("../utils/orderEta.js");
const { estimateRunningOrderEta } = require("../utils/runningOrderEta.js");
const { getPairRate, toMetersPerMachineDay } = require("../utils/etaPosterior.js");
const C                    = require("../utils/etaConfig.js");
const Customer             = require("../models/Customer.js");
const { notify }           = require("../utils/notify.js");
const Notification         = require("../models/Notification.js");
const { approveOrderTxn }  = require("../services/orderService.js");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient.js");


// ════════════════════════════════════════════════════════════════
//  SHARED — BOM EXPANSION
// ════════════════════════════════════════════════════════════════
async function computeRawMaterialRequired(elasticOrdered) {
  const elasticIds = elasticOrdered.map((e) => e.elastic);
  const elastics = await Elastic.find({ _id: { $in: elasticIds } })
    .populate("warpSpandex.id")
    .populate("spandexCovering.id")
    .populate("weftYarn.id")
    .populate("warpYarn.id")
    .lean();

  const rawMap = new Map();
  const addMaterial = (material, weightKg) => {
    const key = material._id.toString();
    if (!rawMap.has(key)) {
      rawMap.set(key, {
        rawMaterial:    material._id,
        name:           material.name,
        requiredWeight: 0,
        inStock:        material.stock || 0,
      });
    }
    rawMap.get(key).requiredWeight += weightKg;
  };

  elasticOrdered.forEach((orderItem) => {
    const elastic = elastics.find(
      (e) => e._id.toString() === orderItem.elastic.toString()
    );
    if (!elastic) return;
    const qty = orderItem.quantity;

    if (elastic.warpSpandex?.id)
      addMaterial(elastic.warpSpandex.id, (elastic.warpSpandex.weight * qty) / 1000);
    if (elastic.spandexCovering?.id)
      addMaterial(elastic.spandexCovering.id, (elastic.spandexCovering.weight * qty) / 1000);
    if (elastic.weftYarn?.id)
      addMaterial(elastic.weftYarn.id, (elastic.weftYarn.weight * qty) / 1000);
    (elastic.warpYarn || []).forEach((wy) => {
      if (wy.id) addMaterial(wy.id, (wy.weight * qty) / 1000);
    });
  });

  return Array.from(rawMap.values());
}


// ════════════════════════════════════════════════════════════════
//  SHARED — RELEASE ALL REMAINING RESERVATIONS
//
//  Called from /cancel and /complete. For each entry in
//  order.reservations: $inc reservedStock down on the elastic and
//  emit a RESERVATION_RELEASE info-row. Clears the array on the
//  order. Fingerprints (STOCK_RELEASED) appended to the order so
//  the timeline shows the release event.
// ════════════════════════════════════════════════════════════════
async function _releaseAllReservations(session, order, actor, context) {
  if (!order.reservations || order.reservations.length === 0) return [];
  const released = [];

  for (const r of order.reservations) {
    const qty = Number(r.quantity || 0);
    if (qty <= 0) continue;

    // Decrement reservedStock on the elastic (clamped to 0).
    const elasticDoc = await Elastic.findById(r.elastic).session(session);
    if (elasticDoc) {
      const current = Number(elasticDoc.reservedStock) || 0;
      const next    = Math.max(0, current - qty);
      elasticDoc.reservedStock = next;
      await elasticDoc.save({ session });
    }

    // Info-only ledger row.
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

    material.stock = (Number(material.stock) || 0) + qty;
    material.totalConsumption = Math.max(
      0,
      (Number(material.totalConsumption) || 0) - qty
    );
    material.stockMovements?.push({
      date:     new Date(),
      type:     "ORDER_CANCEL_REFUND",
      order:    order._id,
      quantity: qty,
      balance:  material.stock,
    });
    await material.save({ session });

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
    const orders = await Order.find({ status })
      .populate("customer",  "name")
      .populate("createdBy", "name role")
      .populate("updatedBy", "name role")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, orders });
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
      .populate("elasticOrdered.elastic", "name")
      .populate("jobs.job")
      .populate("createdBy",  "name role")
      .populate("updatedBy",  "name role")
      .populate("approvedBy", "name role")
      .populate("cancelledBy","name role")
      .populate("startedBy",  "name role")
      .populate("completedBy","name role")
      .populate("deletedBy",  "name role")
      .lean();

    if (!order) return next(new ErrorHandler("Order not found", 404));

    const elastics = order.elasticOrdered.map((e) => {
      const produced = order.producedElastic.find((p) => p.elastic.equals(e.elastic._id))?.quantity || 0;
      const packed   = order.packedElastic.find((p)   => p.elastic.equals(e.elastic._id))?.quantity || 0;
      const pending  = order.pendingElastic.find((p)  => p.elastic.equals(e.elastic._id))?.quantity ?? e.quantity;
      const reserved = (order.reservations || []).find((p) => p.elastic.equals(e.elastic._id))?.quantity ?? 0;
      return {
        id:       e.elastic._id,
        name:     e.elastic.name,
        ordered:  e.quantity,
        produced, packed, pending,
        reserved,
      };
    });

    const liveRawMaterials = await Promise.all(
      order.rawMaterialRequired.map(async (rm) => {
        const mat = await RawMaterial.findById(rm.rawMaterial)
          .select("name stock unit")
          .lean();
        const inStock = mat?.stock ?? 0;
        return {
          rawMaterial:     rm.rawMaterial,
          name:            mat?.name ?? rm.name ?? "—",
          unit:            mat?.unit ?? "kg",
          requiredWeight:  rm.requiredWeight,
          inStock,
          stockSufficient: inStock >= rm.requiredWeight,
        };
      })
    );

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
        orderNo:     order.orderNo,
        po:          order.po,
        status:      order.status,
        date:        order.date,
        supplyDate:  order.supplyDate,
        description: order.description,
        customer:    order.customer,
        elastics,
        jobs:        order.jobs,
        rawMaterialRequired: liveRawMaterials,
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
    session.startTransaction();
    try {
      const { orderId, force = false, forceReason = "" } = req.body;
      const actor = actorFromRequest(req);

      // The transactional domain logic (validate → pre-flight → force
      // fingerprint → raw deduction → elastic reservation → approval
      // fingerprint + status flip) lives in services/orderService.js.
      // The route keeps only session lifecycle, HTTP shaping, and the
      // post-commit fire-and-forget notifications.
      const {
        order, approveFp, deductionFingerprints, reservationFingerprints,
        stockoutSnapshots,
      } = await approveOrderTxn(session, {
        orderId, force, forceReason, actor,
        whatsappActor: req.body?.whatsappActor,
        userId:        req.user?._id,
      });

      await session.commitTransaction();
      session.endSession();

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
      await session.abortTransaction();
      session.endSession();
      return next(error);
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
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res) => {
    const { elasticOrdered, supplyDate, machines } = req.body || {};
    if (!Array.isArray(elasticOrdered) || elasticOrdered.length === 0) {
      return res.status(400).json({
        success: false,
        message: "elasticOrdered must be a non-empty array of { elastic, quantity }",
      });
    }

    const now = new Date();
    const since = new Date(now.getTime() - C.RATE_LOOKBACK_DAYS * 86_400_000);
    const last7 = new Date(now.getTime() - 7 * 86_400_000);
    const last30 = new Date(now.getTime() - 30 * 86_400_000);

    // ── Aggregates (one round-trip block) ────────────────────────
    const elasticIds = elasticOrdered
      .map((l) => l && l.elastic)
      .filter(Boolean)
      .map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch (_) { return null; }
      })
      .filter(Boolean);

    const [
      plantShiftAgg,
      elasticShiftAgg,
      machineAgg,
      attLast7,
      attLast30,
    ] = await Promise.all([
      // Plant-wide meters/machine active-day over the rate window.
      ShiftDetail.aggregate([
        { $match: { status: "closed", date: { $gte: since } } },
        { $group: {
            _id: { machine: "$machine", date: {
              $dateToString: { format: "%Y-%m-%d", date: "$date" } } },
            meters: { $sum: "$productionMeters" },
          } },
        { $group: {
            _id: null,
            totalMeters: { $sum: "$meters" },
            machineDays: { $sum: 1 },
          } },
      ]),

      // Per-elastic meters/machine active-day — same shape, filtered
      // to shifts whose head map includes the elastic.
      elasticIds.length > 0
        ? ShiftDetail.aggregate([
            { $match: {
                status: "closed",
                date: { $gte: since },
                "elastics.elastic": { $in: elasticIds },
              } },
            { $unwind: "$elastics" },
            { $match: { "elastics.elastic": { $in: elasticIds } } },
            { $group: {
                _id: { elastic: "$elastics.elastic", machine: "$machine", date: {
                  $dateToString: { format: "%Y-%m-%d", date: "$date" } } },
                meters: { $sum: "$productionMeters" },
              } },
            { $group: {
                _id: "$_id.elastic",
                totalMeters: { $sum: "$meters" },
                machineDays: { $sum: 1 },
              } },
          ])
        : [],

      // Machine availability — free vs not maintenance, plus avg heads.
      Machine.aggregate([
        { $group: {
            _id: null,
            total:        { $sum: 1 },
            free:         { $sum: { $cond: [{ $eq: ["$status", "free"] },        1, 0] } },
            running:      { $sum: { $cond: [{ $eq: ["$status", "running"] },     1, 0] } },
            maintenance:  { $sum: { $cond: [{ $eq: ["$status", "maintenance"] }, 1, 0] } },
            headsAvg:     { $avg: "$NoOfHead" },
          } },
      ]),

      // Attendance momentum — last 7 days effective-present count.
      Attendance.aggregate([
        { $match: { date: { $gte: last7 } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
      // ...vs trailing 30 days.
      Attendance.aggregate([
        { $match: { date: { $gte: last30 } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);

    // ── Boil aggregates down to the shape orderEta wants ─────────
    const effectivePresent = (rows) => {
      const m = Object.fromEntries(rows.map((r) => [r._id, r.n]));
      return (m.present || 0) + (m.late || 0) + 0.5 * (m.half_day || 0);
    };
    const present7  = effectivePresent(attLast7);
    const present30 = effectivePresent(attLast30);
    // Trailing 30 spans ~26 working days; last 7 spans ~6. Normalise
    // to a daily rate before taking the ratio.
    const trailing30Daily = present30 > 0 ? present30 / 26 : 0;
    const last7Daily      = present7  > 0 ? present7  / 6  : 0;
    const attendanceMomentum = trailing30Daily > 0 ? last7Daily / trailing30Daily : 1;

    const machineRow = machineAgg[0] || {};
    const totalMachines = machineRow.total || 0;
    const freeMachines  = machineRow.free  || 0;
    const availableMachines = totalMachines - (machineRow.maintenance || 0);
    const machineHealth = totalMachines > 0
      ? availableMachines / totalMachines
      : 1;
    const machineNoOfHeadAvg = machineRow.headsAvg || 1;

    const plantRow = plantShiftAgg[0] || {};
    const plantRate = (plantRow.machineDays || 0) > 0
      ? plantRow.totalMeters / plantRow.machineDays
      : null;

    const elasticRate = {};
    for (const r of elasticShiftAgg) {
      if (r.machineDays > 0) {
        elasticRate[String(r._id)] = r.totalMeters / r.machineDays;
      }
    }

    // No consistency score endpoint exposed in a cheap form yet;
    // approximate from sample size — more data → tighter band.
    const consistencyScore = Math.min(95, 40 + (plantRow.machineDays || 0));

    const aggregates = {
      plantRate,
      elasticRate,
      consistencyScore,
      attendanceMomentum,
      machineHealth,
      freeMachines,
      machineNoOfHeadAvg,
    };

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
      aggregates: {
        plantRate:           plantRate ? Math.round(plantRate) : null,
        attendanceMomentum:  Math.round(attendanceMomentum * 100) / 100,
        machineHealth:       Math.round(machineHealth * 100) / 100,
        freeMachines,
        totalMachines,
        availableMachines,
        machineDaysSampled:  plantRow.machineDays || 0,
        consistencyScore,
      },
    });
  }),
);

// ═════════════════════════════════════════════════════════════════
//  Shared helper — compute running ETA for a single order.
//
//  Resolves active jobs, builds the rate input from the per-pair
//  Bayesian posterior (with plant + cold-start fallbacks), and
//  feeds the structured input into the pure math estimator.
//
//  Callers pass a hydrated `plantMetersPerMachineDay` so a bulk
//  request can amortise the one expensive plant aggregation across
//  many orders.
// ═════════════════════════════════════════════════════════════════
async function _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines = 1) {
  const activeJobs = await Job.find({
    order: order._id,
    status: { $nin: ["completed", "cancelled"] },
  })
    .populate({ path: "machine", select: "ID NoOfHead elastics status" })
    .lean();

  // No JobOrder yet — common for orders that were just approved but
  // haven't been planned, and for legacy orders that pre-date the ML
  // ETA layer. Fall back to an entry-time-style estimate so the UI
  // can still show a forward date instead of an empty card. The order
  // will run across the free machines, so pass that count through.
  if (activeJobs.length === 0) {
    return _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now, freeMachines);
  }

  const jobs = [];
  const rateSources = { posterior: 0, plant: 0, coldstart: 0, missing: 0 };

  for (const job of activeJobs) {
    const machine = job.machine;
    if (!machine?._id) continue;

    const noOfHead = Number(machine.NoOfHead) || 1;

    const headsByElastic = {};
    for (const h of machine.elastics || []) {
      const id = h.elastic?.toString();
      if (!id) continue;
      headsByElastic[id] = (headsByElastic[id] || 0) + 1;
    }

    const producedMap = {};
    for (const p of job.producedElastic || []) {
      if (!p?.elastic) continue;
      producedMap[p.elastic.toString()] = Number(p.quantity) || 0;
    }

    const elasticRows = [];
    for (const e of job.elastics || []) {
      // Defensive — legacy job orders occasionally have a null
      // elastic ref (data older than the schema gate). Skip rather
      // than throwing "cannot read 'toString' of null".
      if (!e?.elastic) continue;
      const elasticId = e.elastic.toString();
      const planned   = Number(e.quantity) || 0;
      const produced  = producedMap[elasticId] || 0;
      const remaining = Math.max(0, planned - produced);

      let metersPerHeadPerShift = null;
      let rateSource = "missing";
      const post = await getPairRate(elasticId, machine._id);
      if (post && post.informative) {
        metersPerHeadPerShift = post.metersPerHeadPerShift;
        rateSource = "posterior";
      } else if (plantMetersPerMachineDay && plantMetersPerMachineDay > 0) {
        metersPerHeadPerShift =
          plantMetersPerMachineDay / Math.max(1, noOfHead) / Math.max(1, C.SHIFTS_PER_DAY);
        rateSource = "plant";
      } else {
        metersPerHeadPerShift =
          C.COLDSTART_METERS_PER_HEAD_DAY * C.LOOM_EFFICIENCY / Math.max(1, C.SHIFTS_PER_DAY);
        rateSource = "coldstart";
      }
      rateSources[rateSource] += 1;

      // Machine.elastics may not include this job's elastic in its
      // head map (existing/legacy orders where the head-elastic
      // mapping wasn't kept in sync). Falling back to 1 head keeps
      // the estimate conservative but visible.
      const headsAssigned = headsByElastic[elasticId] || 1;

      elasticRows.push({
        elastic:         elasticId,
        plannedMeters:   planned,
        producedMeters:  produced,
        remainingMeters: remaining,
        headsAssigned,
        metersPerHeadPerShift,
        metersPerMachineDay: Math.round(
          toMetersPerMachineDay(metersPerHeadPerShift, noOfHead, C.SHIFTS_PER_DAY)
        ),
        rateSource,
        posteriorObservations: post?.observations || 0,
      });
    }

    jobs.push({
      job:          job._id,
      jobOrderNo:   job.jobOrderNo,
      status:       job.status,
      machineId:    machine._id,
      machineLabel: machine.ID || null,
      noOfHead,
      elastics:     elasticRows,
    });
  }

  const result = estimateRunningOrderEta({
    jobs,
    today:      now,
    supplyDate: order.supplyDate,
  });

  return { ...result, rateSources };
}

// ─────────────────────────────────────────────────────────────────
// Entry-time fallback — for orders that don't have an active job
// yet (just approved, or legacy). Reuses the entry-time estimator
// (utils/orderEta.js) on the order's *remaining* quantities so the
// shape matches the running-ETA contract the UI already renders.
// ─────────────────────────────────────────────────────────────────
function _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now, freeMachines = 1) {
  const producedMap = {};
  for (const p of order.producedElastic || []) {
    if (!p?.elastic) continue;
    producedMap[p.elastic.toString()] = Number(p.quantity) || 0;
  }
  const lines = (order.elasticOrdered || [])
    .filter((e) => e?.elastic)
    .map((e) => {
      const id = e.elastic.toString();
      const planned   = Number(e.quantity) || 0;
      const produced  = producedMap[id] || 0;
      return { elastic: id, quantity: Math.max(0, planned - produced) };
    })
    .filter((l) => l.quantity > 0);

  if (lines.length === 0) {
    return { ok: false, reason: "NOTHING_REMAINING" };
  }

  const aggregates = {
    plantRate:          plantMetersPerMachineDay,
    elasticRate:        {},
    consistencyScore:   70,
    attendanceMomentum: 1,
    machineHealth:      1,
    // Real-world: an approved order will be run across the machines that
    // are free, not a single loom. estimateOrderEta caps this by how many
    // machines the job can actually keep busy, so an over-count is safe.
    freeMachines:       Math.max(1, Number(freeMachines) || 1),
    machineNoOfHeadAvg: 4,
  };

  const result = estimateOrderEta({
    lines,
    today:      now,
    supplyDate: order.supplyDate,
    aggregates,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason || "NO_RATE" };
  }

  // Reshape to match the running-eta contract — same fields the UI
  // already knows how to render. perJob is empty (no jobs yet); the
  // assumptions list explains the fallback in plain language.
  const rateSource = result.usedColdStart ? "coldstart" : "plant";
  return {
    ok:           true,
    expectedDate: result.expectedDate,
    workingDays:  result.workingDays,
    weavingDays:  result.weavingDays || (result.workingDays - (result.leadDays || 0)),
    leadDays:     result.leadDays || 0,
    perJob:       [],
    risk:         result.risk,
    assumptions:  [
      "Production hasn't started on this order yet — estimate uses the plant-wide rate.",
      ...(result.assumptions || []),
    ],
    rateSources:  {
      posterior: 0,
      plant:     rateSource === "plant" ? 1 : 0,
      coldstart: rateSource === "coldstart" ? 1 : 0,
      missing:   0,
    },
    usedEntryTimeFallback: true,
  };
}

// ═════════════════════════════════════════════════════════════════
// Shared helper — plant rate aggregation. One round-trip, used by
// every running-ETA caller.
// ═════════════════════════════════════════════════════════════════
async function _loadPlantMetersPerMachineDay(now) {
  const since = new Date(now.getTime() - C.RATE_LOOKBACK_DAYS * 86_400_000);
  const plantShiftAgg = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: since } } },
    { $group: {
        _id: { machine: "$machine", date: {
          $dateToString: { format: "%Y-%m-%d", date: "$date" } } },
        meters: { $sum: "$productionMeters" },
      } },
    { $group: {
        _id: null,
        totalMeters: { $sum: "$meters" },
        machineDays: { $sum: 1 },
      } },
  ]);
  const plantRow = plantShiftAgg[0] || {};
  return (plantRow.machineDays || 0) > 0
    ? plantRow.totalMeters / plantRow.machineDays
    : null;
}

// Count the machines currently free to take on an order. Used to size
// the parallelism for approved-but-unplanned orders so their ETA
// reflects running across several looms, not a single machine. Loaded
// once per request and threaded into the per-order estimator.
async function _loadFreeMachineCount() {
  const n = await Machine.countDocuments({ status: "free" });
  return Math.max(1, n);
}

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
  isAuthenticated, isAdmin('admin'),
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
  isAuthenticated, isAdmin('admin'),
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

router.get(
  '/eta-risks',
  isAuthenticated, isAdmin('admin'),
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

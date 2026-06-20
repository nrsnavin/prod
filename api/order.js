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
      if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        throw new ErrorHandler("Valid orderId is required", 400);
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) throw new ErrorHandler("Order not found", 404);
      if (order.status !== "Open")
        throw new ErrorHandler("Only Open orders can be approved", 400);
      if (!Array.isArray(order.elasticOrdered) ||
          order.elasticOrdered.length === 0) {
        throw new ErrorHandler(
          "Order has no elastic lines — cannot approve", 400
        );
      }

      // Pre-flight stock check. When `force: true` we still build a
      // shortfall list so the audit fingerprint records what was
      // forced through; we don't bail out. When `force: false` the
      // first short material raises 400 with a machine-readable
      // `code: "INSUFFICIENT_STOCK"` so the admin app can prompt for
      // a reason and retry.
      const shortfalls = [];
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        if (!material) throw new ErrorHandler("Raw material not found", 404);
        if (material.stock < rm.requiredWeight) {
          if (!force) {
            const err = new ErrorHandler(
              `Insufficient stock for ${material.name} (have ${material.stock}, need ${rm.requiredWeight})`,
              400
            );
            err.code = "INSUFFICIENT_STOCK";
            err.shortfall = {
              materialId:   rm.rawMaterial.toString(),
              materialName: material.name,
              available:    material.stock,
              required:     rm.requiredWeight,
              short:        rm.requiredWeight - material.stock,
            };
            throw err;
          }
          shortfalls.push({
            materialId:   rm.rawMaterial.toString(),
            materialName: material.name,
            available:    material.stock,
            required:     rm.requiredWeight,
            short:        rm.requiredWeight - material.stock,
          });
        }
      }
      // Reason is only demanded when the force flag actually
      // overrides something — a force=true call against healthy
      // stock behaves like a normal approval.
      if (force && shortfalls.length > 0) {
        const reason = String(forceReason || "").trim();
        if (reason.length < 8) {
          throw new ErrorHandler(
            "forceReason must be at least 8 characters when forcing through a shortfall",
            400
          );
        }
      }

      const actor = actorFromRequest(req);

      // If admin forced approval through a shortfall, leave a
      // standalone fingerprint capturing the reason BEFORE the
      // deduction fingerprints. This keeps the audit trail explicit
      // about who overrode the stock guard and why.
      if (force && shortfalls.length > 0) {
        const forceFp = buildFingerprint(ACTION_CODES.ORDER_APPROVED, {
          entityId: order._id,
          actor,
          meta: {
            forced:     true,
            reason:     String(forceReason).trim(),
            shortfalls,
          },
        });
        order.fingerprints.push(forceFp);
      }

      const deductionFingerprints = [];
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        // Clamp stock at 0 on a forced approval — the schema floor
        // (min: 0) on RawMaterial.stock would otherwise reject the
        // save and trash the whole transaction. The shortfall is
        // already captured in the force fingerprint above.
        const applied = Math.min(rm.requiredWeight, material.stock);
        material.stock = Math.max(0, material.stock - rm.requiredWeight);
        material.totalConsumption = (material.totalConsumption || 0) + applied;
        // Ledger rows record what ACTUALLY moved (`applied`) so the
        // movement sums reconcile with stock after a clamped forced
        // approval. The requested amount lives in the deduction
        // fingerprint + force fingerprint shortfalls.
        material.stockMovements?.push({
          date: new Date(), type: "ORDER_APPROVAL", order: order._id,
          quantity: applied, balance: material.stock,
        });
        await material.save({ session });
        await MaterialOutward.create([{
          rawMaterial: rm.rawMaterial,
          quantity:    applied,
          order:       order._id,
          type:        "ORDER_APPROVAL",
          outwardDate: new Date(),
          unitPrice:   material.price ?? 0,
          remarks:     applied < rm.requiredWeight
            ? `Order #${order.orderNo ?? ""} approval (forced — requested ${rm.requiredWeight}, short ${rm.requiredWeight - applied})`
            : `Order #${order.orderNo ?? ""} approval`,
        }], { session });

        const deductFp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
          entityId: order._id,
          actor,
          meta: {
            rawMaterialId:   rm.rawMaterial.toString(),
            rawMaterialName: material.name,
            requested:       rm.requiredWeight,
            applied,
            unit:            "kg",
            balanceAfter:    material.stock,
          },
        });
        order.fingerprints.push(deductFp);
        deductionFingerprints.push(deductFp);
      }

      // ── Reserve elastic units against this order ───────────
      const reservationFingerprints = [];
      for (const line of order.elasticOrdered) {
        const qty = Number(line.quantity || 0);
        if (qty <= 0) continue;

        const elasticDoc = await Elastic.findById(line.elastic).session(session);
        if (!elasticDoc) {
          throw new ErrorHandler(`Elastic ${line.elastic} not found`, 404);
        }
        elasticDoc.reservedStock = (Number(elasticDoc.reservedStock) || 0) + qty;
        await elasticDoc.save({ session });

        order.reservations.push({ elastic: line.elastic, quantity: qty });

        await applyMovement(session, {
          elasticId: line.elastic,
          type:      "RESERVATION_HOLD",
          quantity:  +qty,
          refType:   "Order",
          refId:     order._id,
          reason:    `Order ${order.orderNo ?? order._id} approved`,
          by:        req.user?._id,
        });

        const resFp = buildFingerprint(ACTION_CODES.STOCK_RESERVED, {
          entityId: order._id,
          actor,
          meta: {
            elasticId:   line.elastic.toString(),
            elasticName: elasticDoc.name,
            quantity:    qty,
          },
        });
        order.fingerprints.push(resFp);
        reservationFingerprints.push(resFp);
      }

      // Provenance — when the approve came from the WhatsApp webhook,
      // the inbound handler passes whatsappActor.from in the body so
      // the audit trail keeps the originating phone (the JWT actor
      // would otherwise just say "WhatsApp Bot"). Stamp both the
      // order doc and the fingerprint meta so the admin app can
      // render a "via WhatsApp +91…" pill in the timeline + a small
      // icon on the order list.
      const whatsappFrom = req.body?.whatsappActor?.from || null;
      const approvalVia  = whatsappFrom ? "whatsapp" : "admin";

      const approveFp = buildFingerprint(ACTION_CODES.ORDER_APPROVED, {
        entityId: order._id,
        actor,
        meta: {
          previousStatus:    "Open",
          newStatus:         "Approved",
          forced:            force === true && shortfalls.length > 0,
          forceReason:       force ? String(forceReason).trim() : undefined,
          shortfallCount:    shortfalls.length,
          materialsDeducted: deductionFingerprints.length,
          elasticsReserved:  reservationFingerprints.length,
          via:               approvalVia,
          whatsappFrom:      whatsappFrom || undefined,
        },
      });
      order.fingerprints.push(approveFp);

      order.status               = "Approved";
      order.approvedBy           = req.user?._id || null;
      order.approvedAt           = new Date();
      order.approvalVia          = approvalVia;
      order.approvalWhatsappFrom = whatsappFrom || undefined;
      await order.save({ session });
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

          if (force) {
            const result = await notify("orderForceApproved", {
              orderNo:      order.orderNo,
              customerName: cust?.name,
              by:           actorName,
              reason:       forceReason || "(no reason given)",
              via,
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
            });
            console.log(`[notify:orderApproved] order=${order.orderNo} →`, JSON.stringify(result));
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
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
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

        // Refund only if the order had been approved (Open orders
        // never touched stock). The helper short-circuits on Open
        // anyway, but skipping the call keeps the response cleaner.
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

        const fp = buildFingerprint(ACTION_CODES.ORDER_CANCELLED, {
          entityId: order._id,
          actor,
          meta: {
            previousStatus,
            newStatus: "Cancelled",
            releasedReservations: released.length,
            refundedMaterials:    refunded.length,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        resp = {
          orderId: order._id,
          status:  order.status,
          fingerprint: fp,
          releasedReservations: released,
          refundedMaterials:    refunded,
        };
      });

      res.status(200).json({ success: true, message: "Order cancelled", ...resp });
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

        resp = {
          status: order.status,
          fingerprint: fp,
          releasedReservations: released,
        };
      });

      res.status(200).json({ success: true, message: "Order completed", ...resp });
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
        if (supplyDate !== undefined && new Date(supplyDate).getTime() !== new Date(order.supplyDate).getTime()) {
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
    const { orderId, reason } = req.body;
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));

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
            reason:    reason || null,
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
async function _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now) {
  const activeJobs = await Job.find({
    order: order._id,
    status: { $nin: ["completed", "cancelled"] },
  })
    .populate({ path: "machine", select: "ID NoOfHead elastics status" })
    .lean();

  // No JobOrder yet — common for orders that were just approved but
  // haven't been planned, and for legacy orders that pre-date the ML
  // ETA layer. Fall back to an entry-time-style estimate so the UI
  // can still show a forward date instead of an empty card.
  if (activeJobs.length === 0) {
    return _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now);
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
function _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now) {
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
    freeMachines:       1,
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
    const plantMetersPerMachineDay = await _loadPlantMetersPerMachineDay(now);
    const result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now);

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
    const plantMetersPerMachineDay = inFlight.length > 0
      ? await _loadPlantMetersPerMachineDay(now)
      : null;

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
        result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now);
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

// Expose the per-order ETA computation + plant-rate loader so utility
// modules (utils/digest.js) can reuse the exact same math the route
// returns to clients — no duplication, identical numbers across the
// app and the WhatsApp digest.
router._etaHelpers = {
  _computeRunningEtaForOrder,
  _loadPlantMetersPerMachineDay,
};

module.exports = router;

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
      if (force) {
        const reason = String(forceReason || "").trim();
        if (reason.length < 8) {
          throw new ErrorHandler(
            "forceReason must be at least 8 characters when force=true",
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
        material.stockMovements?.push({
          date: new Date(), type: "ORDER_APPROVAL", order: order._id,
          quantity: rm.requiredWeight, balance: material.stock,
        });
        await material.save({ session });
        await MaterialOutward.create([{
          rawMaterial: rm.rawMaterial,
          quantity:    rm.requiredWeight,
          order:       order._id,
          type:        "ORDER_APPROVAL",
          outwardDate: new Date(),
          unitPrice:   material.price ?? 0,
          remarks:     `Order #${order.orderNo ?? ""} approval`,
        }], { session });

        const deductFp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
          entityId: order._id,
          actor,
          meta: {
            rawMaterialId:   rm.rawMaterial.toString(),
            rawMaterialName: material.name,
            quantity:        rm.requiredWeight,
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
        },
      });
      order.fingerprints.push(approveFp);

      order.status     = "Approved";
      order.approvedBy = req.user?._id || null;
      order.approvedAt = new Date();
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
//  PR E: releases any remaining elastic reservations. Raw material
//  refund is out of scope (already-deducted raw stock stays out).
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
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        resp = {
          orderId: order._id,
          status:  order.status,
          fingerprint: fp,
          releasedReservations: released,
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


module.exports = router;

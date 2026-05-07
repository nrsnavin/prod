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


// ════════════════════════════════════════════════════════════════
//  SHARED — BOM EXPANSION
//  Walks an elasticOrdered list and rolls up the raw-material
//  weight requirement using each Elastic's BOM. Used by both
//  /create-order (initial snapshot) and /update-order (recompute
//  after items change).
//
//  Returns { rawMaterialRequired: [{ rawMaterial, name, requiredWeight, inStock }] }
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
//  LIST ORDERS  (by status)
// ════════════════════════════════════════════════════════════════
router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const { status } = req.query;
    if (!status) {
      return next(new ErrorHandler("Status is required", 400));
    }
    // Status is an exact match, so soft-deleted orders are naturally
    // excluded from any non-"Deleted" status request. Pass status=Deleted
    // explicitly to surface them.
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

      // 🪪 Fingerprint: ORDER_CREATED
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
      console.error(error);
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
      return {
        id:       e.elastic._id,
        name:     e.elastic.name,
        ordered:  e.quantity,
        produced, packed, pending,
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

    // 🪪 Newest-first fingerprint feed for the UI timeline
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
        // ── Per-state audit pointers ──
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
        // 🪪 Full audit timeline (newest-first)
        fingerprints,
      },
    });
  })
);


// ════════════════════════════════════════════════════════════════
//  APPROVE ORDER  (deducts stock — uses transaction)
// ════════════════════════════════════════════════════════════════
router.post(
  "/approve",
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { orderId } = req.body;
      const order = await Order.findById(orderId).session(session);
      if (!order) throw new ErrorHandler("Order not found", 404);
      if (order.status !== "Open")
        throw new ErrorHandler("Only Open orders can be approved", 400);

      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        if (!material) throw new ErrorHandler("Raw material not found", 404);
        if (material.stock < rm.requiredWeight)
          throw new ErrorHandler(`Insufficient stock for ${material.name}`, 400);
      }

      const actor = actorFromRequest(req);
      const deductionFingerprints = [];
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        material.stock -= rm.requiredWeight;
        material.totalConsumption = (material.totalConsumption || 0) + rm.requiredWeight;
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

        // 🪪 Fingerprint per raw-material deduction
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

      // 🪪 ORDER_APPROVED summary fingerprint
      const approveFp = buildFingerprint(ACTION_CODES.ORDER_APPROVED, {
        entityId: order._id,
        actor,
        meta: {
          previousStatus:    "Open",
          newStatus:         "Approved",
          materialsDeducted: deductionFingerprints.length,
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
        success:               true,
        message:               "Order approved and stock deducted",
        fingerprint:           approveFp,
        deductionFingerprints,
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
// ════════════════════════════════════════════════════════════════
router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (!["Open", "Approved"].includes(order.status)) {
      return next(new ErrorHandler(`Cannot cancel an order with status "${order.status}"`, 400));
    }

    const previousStatus = order.status;
    order.status      = "Cancelled";
    order.cancelledBy = req.user?._id || null;
    order.cancelledAt = new Date();

    // 🪪 Fingerprint: ORDER_CANCELLED
    const fp = buildFingerprint(ACTION_CODES.ORDER_CANCELLED, {
      entityId: order._id,
      actor:    actorFromRequest(req),
      meta:     { previousStatus, newStatus: "Cancelled" },
    });
    order.fingerprints.push(fp);
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order cancelled",
      orderId: order._id,
      status:  order.status,
      fingerprint: fp,
    });
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

    // 🪪 Fingerprint: ORDER_PRODUCTION_STARTED
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
// ════════════════════════════════════════════════════════════════
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (order.status !== "InProgress") {
      return next(new ErrorHandler("Only InProgress orders can be completed", 400));
    }

    order.status      = "Completed";
    order.completedBy = req.user?._id || null;
    order.completedAt = new Date();

    // 🪪 Fingerprint: ORDER_COMPLETED
    const fp = buildFingerprint(ACTION_CODES.ORDER_COMPLETED, {
      entityId: order._id,
      actor:    actorFromRequest(req),
      meta:     { previousStatus: "InProgress", newStatus: "Completed" },
    });
    order.fingerprints.push(fp);
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order completed",
      status:  order.status,
      fingerprint: fp,
    });
  })
);


// ════════════════════════════════════════════════════════════════
//  UPDATE ORDER  (Open state only)
//
//  Edits header fields and/or items on an Open order. Item changes
//  trigger a full recompute of pendingElastic + rawMaterialRequired
//  (production has not started, so producedElastic / packedElastic
//  stay at zero). Wrapped in a transaction matching /approve.
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

        // ── Diff header fields, build changedFields list ─────────
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

        // ── Item / quantity recompute ────────────────────────────
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

        // 🪪 Fingerprint: ORDER_UPDATED
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
//
//  Sets status="Deleted" and stamps deletedBy/deletedAt. The
//  document and its fingerprint timeline are preserved; list views
//  exclude Deleted by default (see /list, /get-open-orders).
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

        // 🪪 Fingerprint: ORDER_DELETED
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

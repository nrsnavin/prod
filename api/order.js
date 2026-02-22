const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const router = express.Router();
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const RawMaterial = require("../models/RawMaterial.js");
const mongoose = require("mongoose");


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
      .populate("customer", "name")
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

      const elasticIds = elasticOrdered.map((e) => e.elastic);
      const elastics = await Elastic.find({ _id: { $in: elasticIds } })
        .populate("warpSpandex.id")
        .populate("spandexCovering.id")
        .populate("weftYarn.id")
        .populate("warpYarn.id")
        .lean();

      // Build raw material requirement map
      const rawMap = new Map();
      const addMaterial = (material, weightKg) => {
        const key = material._id.toString();
        if (!rawMap.has(key)) {
          rawMap.set(key, {
            rawMaterial: material._id,
            name: material.name,
            requiredWeight: 0,
            inStock: material.stock || 0,
          });
        }
        rawMap.get(key).requiredWeight += weightKg;
      };

      elasticOrdered.forEach((orderItem) => {
        const elastic = elastics.find(
          (e) => e._id.toString() === orderItem.elastic
        );
        if (!elastic) return;
        const qty = orderItem.quantity;

        if (elastic.warpSpandex?.id)
          addMaterial(elastic.warpSpandex.id, (elastic.warpSpandex.weight * qty) / 1000);
        if (elastic.spandexCovering?.id)
          addMaterial(elastic.spandexCovering.id, (elastic.spandexCovering.weight * qty) / 1000);
        if (elastic.weftYarn?.id)
          addMaterial(elastic.weftYarn.id, (elastic.weftYarn.weight * qty) / 1000);
        elastic.warpYarn.forEach((wy) => {
          if (wy.id) addMaterial(wy.id, (wy.weight * qty) / 1000);
        });
      });

      const rawMaterialRequired = Array.from(rawMap.values());

      const producedElastic = elasticOrdered.map((e) => ({
        elastic: e.elastic, quantity: 0,
      }));
      const packedElastic = elasticOrdered.map((e) => ({
        elastic: e.elastic, quantity: 0,
      }));
      const pendingElastic = elasticOrdered.map((e) => ({
        elastic: e.elastic, quantity: e.quantity,
      }));

      const order = await Order.create({
        date, po, customer, supplyDate, description,
        elasticOrdered, producedElastic, packedElastic,
        pendingElastic, rawMaterialRequired, status: "Open",
      });

      res.status(201).json({ success: true, orderId: order._id });
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
      .populate("customer", "name gstin")
      .populate("elasticOrdered.elastic", "name")
      .populate("jobs.job")
      .lean();

    if (!order) return next(new ErrorHandler("Order not found", 404));

    const elastics = order.elasticOrdered.map((e) => {
      const produced =
        order.producedElastic.find((p) =>
          p.elastic.equals(e.elastic._id)
        )?.quantity || 0;
      const packed =
        order.packedElastic.find((p) =>
          p.elastic.equals(e.elastic._id)
        )?.quantity || 0;
      const pending =
        order.pendingElastic.find((p) =>
          p.elastic.equals(e.elastic._id)
        )?.quantity ?? e.quantity;

      return {
        id: e.elastic._id,
        name: e.elastic.name,
        ordered: e.quantity,
        produced, packed, pending,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        _id: order._id,
        orderNo: order.orderNo,
        po: order.po,
        status: order.status,
        date: order.date,
        supplyDate: order.supplyDate,
        description: order.description,
        customer: order.customer,
        elastics,
        jobs: order.jobs,
        rawMaterialRequired: order.rawMaterialRequired,
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

      // Check stock
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        if (!material) throw new ErrorHandler("Raw material not found", 404);
        if (material.stock < rm.requiredWeight)
          throw new ErrorHandler(`Insufficient stock for ${material.name}`, 400);
      }

      // Deduct stock
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(rm.rawMaterial).session(session);
        material.stock -= rm.requiredWeight;
        material.totalConsumption = (material.totalConsumption || 0) + rm.requiredWeight;
        material.stockMovements?.push({
          date: new Date(), type: "ORDER_APPROVAL",
          order: order._id, quantity: rm.requiredWeight,
          balance: material.stock,
        });
        await material.save({ session });
      }

      order.status = "Approved";
      await order.save({ session });
      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        success: true,
        message: "Order approved and stock deducted",
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
//  FIX: This route was COMPLETELY MISSING — frontend always got 404.
//       cancelOrder() was broken in production.
// ════════════════════════════════════════════════════════════════
router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId)
      return next(new ErrorHandler("Order ID is required", 400));

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (!["Open", "Approved"].includes(order.status)) {
      return next(
        new ErrorHandler(
          `Cannot cancel an order with status "${order.status}"`,
          400
        )
      );
    }

    order.status = "Cancelled"; // FIX: correct casing matches schema enum
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order cancelled",
      orderId: order._id,
      status: order.status,
    });
  })
);


// ════════════════════════════════════════════════════════════════
//  START PRODUCTION  (Approved → InProgress)
//  FIX: /startProduction didn't validate current status. Now uses
//       /start-production which checks order must be "Approved" first.
// ════════════════════════════════════════════════════════════════
router.post(
  "/start-production",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId)
      return next(new ErrorHandler("Order ID is required", 400));

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (order.status !== "Approved") {
      return next(
        new ErrorHandler("Order must be Approved before starting production", 400)
      );
    }

    order.status = "InProgress";
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order moved to InProgress",
      status: order.status,
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
      return next(
        new ErrorHandler("Only InProgress orders can be completed", 400)
      );
    }

    order.status = "Completed";
    await order.save();
    res.status(200).json({ success: true, message: "Order completed", status: order.status });
  })
);


// ════════════════════════════════════════════════════════════════
//  GET OPEN ORDERS
//  FIX: was querying { status: "open" } (lowercase) — schema stores
//       "Open" (capitalized). Returned zero results always.
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-open-orders",
  catchAsyncErrors(async (req, res, next) => {
    const openOrders = await Order.find({ status: "Open" }) // FIX: was "open"
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, openOrders });
  })
);


// ════════════════════════════════════════════════════════════════
//  GET PENDING (APPROVED) ORDERS
//  FIX: was querying { status: "approved" } (lowercase). Always zero results.
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-pending-orders",
  catchAsyncErrors(async (req, res, next) => {
    const pending = await Order.find({ status: "Approved" }) // FIX: was "approved"
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, pending });
  })
);


module.exports = router;
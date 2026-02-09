const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const router = express.Router();
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const RawMaterial = require("../models/RawMaterial.js");
const axios = require("axios");
const mongoose = require("mongoose");



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

    res.status(200).json({
      success: true,
      orders,
    });
  })
);

// ✅ APPROVE ORDER


router.post(
  "/approve",
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { orderId } = req.body;

      console.log("Approving order ID:", orderId);

      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new ErrorHandler("Order not found", 404);
      }

      if (order.status !== "Open") {
        throw new ErrorHandler(
          "Only Open orders can be approved",
          400
        );
      }

      // 1️⃣ CHECK STOCK AVAILABILITY
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(
          rm.rawMaterial
        ).session(session);

        if (!material) {
          throw new ErrorHandler("Raw material not found", 404);
        }

        if (material.stock < rm.requiredWeight) {
          throw new ErrorHandler(
            `Insufficient stock for ${material.name}`,
            400
          );
        }
      }

      // 2️⃣ DEDUCT STOCK
      for (const rm of order.rawMaterialRequired) {
        const material = await RawMaterial.findById(
          rm.rawMaterial
        ).session(session);

        material.stock -= rm.requiredWeight;
        material.totalConsumption =
          (material.totalConsumption || 0) + rm.requiredWeight;

        // Optional audit trail
        material.stockMovements.push({
          date: new Date(),
          type: "ORDER_APPROVAL",
          order: order._id,
          quantity: rm.requiredWeight,
          balance: material.stock,
        });

        await material.save({ session });
      }

      // 3️⃣ UPDATE ORDER STATUS
      order.status = "Approved";
      await order.save({ session });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        success: true,
        message: "Order approved and stock deducted",
      });
    } catch (error) {
      console.error("Error approving order:", error);
      await session.abortTransaction();
      session.endSession();
      return next(error);
    }
  })
);


// ❌ CANCEL ORDER
router.post(
  "/startProduction",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;

    if (!orderId) {
      return next(new ErrorHandler("Order ID is required", 400));
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return next(new ErrorHandler("Order not found", 404));
    }

    

    order.status = "InProgress";
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order started successfully",
      orderId: order._id,
      status: order.status,
    });
  })
);


// 🚀 MOVE ORDER TO IN-PROGRESS
router.post(
  "/start-production",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;

    const order = await Order.findById(orderId);

    if (!order) {
      return next(new ErrorHandler("Order not found", 404));
    }

    if (order.status !== "Approved") {
      return next(
        new ErrorHandler("Order must be Approved first", 400)
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


// ✅ COMPLETE ORDER
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;

    const order = await Order.findById(orderId);

    if (!order) {
      return next(new ErrorHandler("Order not found", 404));
    }

    order.status = "Completed";
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order completed",
      status: order.status,
    });
  })
);




// create product
router.post(
  "/create-order",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const {
        date,
        po,
        customer,
        supplyDate,
        description,
        elasticOrdered, // [{ elastic, quantity }]
      } = req.body;

      // 1️⃣ Fetch all elastics with material details
      const elasticIds = elasticOrdered.map(e => e.elastic);

      const elastics = await Elastic.find({
        _id: { $in: elasticIds },
      })
        .populate("warpSpandex.id")
        .populate("spandexCovering.id")
        .populate("weftYarn.id")
        .populate("warpYarn.id")
        .lean();

      // 2️⃣ RAW MATERIAL MAP (MERGE SAME MATERIALS)
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

      // 3️⃣ CALCULATE REQUIREMENTS
      elasticOrdered.forEach(orderItem => {
        const elastic = elastics.find(
          e => e._id.toString() === orderItem.elastic
        );

        if (!elastic) return;

        const qty = orderItem.quantity;

        // Warp Spandex
        if (elastic.warpSpandex?.id) {
          addMaterial(
            elastic.warpSpandex.id,
            (elastic.warpSpandex.weight * qty) / 1000
          );
        }

        // Spandex Covering
        if (elastic.spandexCovering?.id) {
          addMaterial(
            elastic.spandexCovering.id,
            (elastic.spandexCovering.weight * qty) / 1000
          );
        }

        // Weft Yarn
        if (elastic.weftYarn?.id) {
          addMaterial(
            elastic.weftYarn.id,
            (elastic.weftYarn.weight * qty) / 1000
          );
        }

        // Warp Yarns (multiple)
        elastic.warpYarn.forEach(wy => {
          if (wy.id) {
            addMaterial(
              wy.id,
              (wy.weight * qty) / 1000
            );
          }
        });
      });

      const rawMaterialRequired = Array.from(rawMap.values());

      // 4️⃣ BUILD TRACKING ARRAYS
      const producedElastic = elasticOrdered.map(e => ({
        elastic: e.elastic,
        quantity: 0,
      }));

      const packedElastic = elasticOrdered.map(e => ({
        elastic: e.elastic,
        quantity: 0,
      }));

      const pendingElastic = elasticOrdered.map(e => ({
        elastic: e.elastic,
        quantity: e.quantity,
      }));

      // 5️⃣ CREATE ORDER
      const order = await Order.create({
        date,
        po,
        customer,
        supplyDate,
        description,
        elasticOrdered,
        producedElastic,
        packedElastic,
        pendingElastic,
        rawMaterialRequired,
        status: "Open",
      });

      res.status(201).json({
        success: true,
        orderId: order._id,
      });
    } catch (error) {
      console.error(error);
      return next(new ErrorHandler(error.message, 500));
    }
  })
);




router.get(
  "/get-orderDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;


    console.log("Fetching details for order ID:", id);
    if (!id) {
      return next(new ErrorHandler("Order ID is required", 400));
    }

    const order = await Order.findById(id)
      .populate("customer", "name gstin")
      .populate("elasticOrdered.elastic", "name")
      .populate("jobs.job")
      .lean();

    if (!order) {
      return next(new ErrorHandler("Order not found", 404));
    }

    // 🔹 Elastic-wise view model
    const elastics = order.elasticOrdered.map(e => {
      const produced =
        order.producedElastic.find(p => p.elastic.equals(e.elastic._id))
          ?.quantity || 0;

      const packed =
        order.packedElastic.find(p => p.elastic.equals(e.elastic._id))
          ?.quantity || 0;

      const pending =
        order.pendingElastic.find(p => p.elastic.equals(e.elastic._id))
          ?.quantity || e.quantity;

      return {
        id: e.elastic._id,
        name: e.elastic.name,
        ordered: e.quantity,
        produced,
        packed,
        pending,
        
      };
    });


    const a= {
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
      }

      console.log("Order details fetched:", a);

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




router.get('/order-closed', catchAsyncErrors(async (req, res, next) => {
  try {

    let order = await Promise.resolve(Order.findById(req.query.id));
    order.status = "closed";

    order.save();


    order.elasticOrdered.map(async (e, i) => {
      const elas = await Elastic.findById(e.id);

      elas.status = null;

      await elas.save();

    });

    res.status(201).json({

      success: true,
      order

    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error, 400));
  }
}))



// router.get('/checkMaterialRequired', catchAsyncErrors(async (req, res, next) => {
//   try {
//     const mat = [];

//     const order = await Promise.resolve(Order.findById(req.query.id).populate('elasticOrdered.elastic').exec());

//     let raw = [];

//     await Promise.all(order.elasticOrdered.map(async (e) => {
//       const weft = e.id.weftYarn.id;
//       const covering = e.id.spandexCovering.id;
//       const rubber = e.id.warpSpandex.id;
//       const warp = e.id.warpYarn;

//       const weftDetail = await RawMaterial.findById(weft);
//       const weftIdx = raw.find((x) => x.id == weftDetail._id);
//       if (weftIdx) {
//         raw[weftIdx].weight = raw[weftIdx].weight + (e.id.weftYarn.weight * e.quantity) / 1000;
//       }
//       else {
//         raw.push({
//           id: weftDetail._id,
//           name: weftDetail.name,
//           inStock: weftDetail.stock,
//           weight: (e.id.weftYarn.weight * e.quantity) / 1000
//         })
//       }




//       const coverDetail = await RawMaterial.findById(covering);
//       const coveringIdx = raw.find((x) => x.id == coverDetail._id);
//       if (coveringIdx) {
//         raw[coveringIdx].weight = raw[coveringIdx].weight + (e.id.spandexCovering.weight * e.quantity) / 1000;
//       }
//       else {
//         raw.push({
//           id: coverDetail._id,
//           name: coverDetail.name,
//           inStock: coverDetail.stock,
//           weight: (e.id.spandexCovering.weight * e.quantity) / 1000
//         })
//       }




//       const rubberDetail = await RawMaterial.findById(rubber);
//       const rubberIdx = raw.find((x) => x.id == rubberDetail._id);
//       if (rubberIdx) {
//         raw[rubberIdx].weight = raw[rubberIdx].weight + (e.id.warpSpandex.weight * e.quantity) / 1000;
//       }
//       else {
//         raw.push({
//           id: rubberDetail._id,
//           name: rubberDetail.name,
//           inStock: rubberDetail.stock,
//           weight: (e.id.warpSpandex.weight * e.quantity) / 1000
//         })
//       }


//       await Promise.all(warp.map(async (w) => {
//         const warpDetail = await RawMaterial.findById(w.id);
//         const warpIdx = raw.find((x) => x.id == warpDetail._id);
//         if (warpIdx) {
//           raw[warpIdx].weight = raw[warpIdx].weight + (w.weight * e.quantity) / 1000;
//         }
//         else {
//           raw.push({
//             id: warpDetail._id,
//             name: warpDetail.name,
//             inStock: warpDetail.stock,
//             weight: (w.weight * e.quantity) / 1000
//           })
//         }

//       }))


//     })).then(() => {

//       raw.forEach((e) => {
//         const i = mat.findIndex((rm) => rm.id.toString() == e.id.toString());


//         if (i >= 0) {
//           mat[i].weight += e.weight;
//         }
//         else {
//           mat.push(e);
//         }

//       })
//     });

//     order.rawmaterialRequired = mat;

//     await order.save();






//     res.status(201).json({
//       raw,
//       success: true,
//       mat,

//     });
//   } catch (error) {
//     console.log(error);
//     return next(new ErrorHandler(error, 400));
//   }
// }))





router.get(
  "/get-open-orders",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const openOrders = await Order.find({ status: "open" }).populate("customer").sort({
        createdAt: -1,
      }).exec();
      res.status(201).json({
        success: true,
        openOrders,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

router.get(
  "/get-pending-orders",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const pending = await Order.find({ status: "approved" }).populate("customer").sort({
        createdAt: -1,
      }).exec();
      res.status(201).json({
        success: true,
        pending,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// router.get(
//   "/get-orderDetail",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     try {
//       const order = await Promise.resolve(Order.findById(req.query.id).populate('elasticOrdered.elastic').populate('customer').exec());




//       const elastics = order.elasticOrdered.map((e) => {
//         const name = e.id.name;
//         const id = e.id.id;

//         const packed = order.packedElastic.find((x) => x.id == id);

//         const pending = order.pendingElastic.find((x) => x.id == id);

//         const produced = order.producedElastic.find((x) => x.id == id);

//         return {
//           id: id,
//           name: name,
//           ordered: e.quantity,
//           produced: produced.quantity,
//           pending: pending.quantity,
//           packed: packed.quantity
//         }
//       })

//       res.status(201).json({
//         success: true,
//         data: {
//           customer: order.customer,
//           elastics,
//           jobs: order.jobs,
//           po: order.po,
//           date: order.date,
//           deliveryDate: order.supplyDate,
//           status: order.status,
//           description: order.description,
//           orderNo: order.orderNo.toString(),
//           _id: order._id,
//           rawmaterialRequired: order.rawmaterialRequired
//         },
//       });
//     } catch (error) {
//       return next(new ErrorHandler(error.message, 500));
//     }
//   })
// );


module.exports = router;





const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const router = express.Router();
const Order = require("../models/Order.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const RawMaterial = require("../models/RawMaterial.js");
const axios = require("axios");



// create product
router.post(
  "/create-order",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {


      const date = req.body.date;
      const delDate = req.body.supplyDate;
      const po = req.body.po;
      let description = req.body.description;
      const customer = req.body.customer;
      const elasticOrdered = req.body.elasticOrdered;


      const producedElastic = elasticOrdered.map((e) => {
        const r =
        {
          id: e.id,
          quantity: 0
        };

        return r
      });


      const packedElastic = elasticOrdered.map((e) => {
        const r =
        {
          id: e.id,
          quantity: 0
        };

        return r
      });




      const pendingElastic = elasticOrdered.map((e, i) => {
        const r =
        {
          id: e.id,
          quantity: e.quantity - packedElastic[i].quantity
        };

        return r;

      });



      const status = "open";

      description = description + " pending Approval";






      const o = await Order.create({
        date: Date(date),
        elasticOrdered: elasticOrdered,
        pendingElastic: pendingElastic,
        packedElastic: packedElastic,
        producedElastic: producedElastic,
        customer: customer,
        status: status,
        supplyDate: Date(delDate),
        po: po,
        description: description,
      });



      elasticOrdered.map(async (e, i) => {
        const elas = await Elastic.findById(e.id);
        const idx = elas.customers.findIndex((c) => c.toString() == customer.toString());

        if (idx < 0) {
          elas.customers.push(customer);
        }


        elas.status = o._id;

        await elas.save();

      });
      res.status(201).json({
        success: true,

      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);



router.get('/order-approval', catchAsyncErrors(async (req, res, next) => {
  try {

    let order = await Promise.resolve(Order.findById(req.query.id));
    let description = order.description;
    const elasticOrdered = order.elasticOrdered;





    const producedElastic = elasticOrdered.map((e) => {
      const r =
      {
        id: e.id,
        quantiy: 0
      };

      return r
    });


    const packedElastic = await Promise.all(elasticOrdered.map(async (e) => {
      const elas = await Elastic.findById(e.id);
      if (elas.stock > 0 && elas.stock < e.quantity) {

        const r = {
          id: e.id,
          quantity: elas.stock

        };
        elas.stock = 0;

        await elas.save();


        return r;

      }

      else if (elas.stock > 0 && elas.stock > e.quantity) {
        const r = { id: e.id, quantity: elas.stock };
        elas.stock = elas.stock - e.quantity;
        await elas.save();
        return r;
      }


      else {
        const r = { id: e.id, quantity: 0 };


        return r;
      }
    }))

    const pendingElastic = elasticOrdered.map((e, i) => {
      const r =
      {
        id: e.id,
        quantity: e.quantity - packedElastic[i].quantity
      };

      return r;

    });

    var x = true;

    pendingElastic.forEach(element => {
      if (element.quantity > 0) {
        x = false;
      }
      else {
        x = x & true;
      }
    });

    console.log(x);

    const status = x ? "closed" : "approved";

    description = x ? description + " completed from stock" : description + "Order Approved for Production";


    order.packedElastic = packedElastic;
    order.pendingElastic = pendingElastic;
    order.producedElastic = producedElastic,
      order.status = status;
    order.description = description;


    await order.save();


    if (order.rawmaterialRequired.length > 0) {
      await Promise.all(order.rawmaterialRequired.map(async (r) => {
        const material = await RawMaterial.findById(r.id);

        material.stock = material.stock - r.weight;

        material.totalConsumption+=r.weight;

        material.stockMovements.push({
          date:Date.now(),
          order:order._id,
          orderNumber:order.orderNo,
          quantity:r.weight,
        })
  

        await material.save();
      }));
    }
    else {
      const rawReq = await axios.get(req.protocol + '://' + req.get('host') + '/api/v2/order/checkMaterialRequired?id=' + req.query.id);

      order = await Order.findById(req.query.id);

      await Promise.all(order.rawmaterialRequired.map(async (r) => {
        const material = await RawMaterial.findById(r.id);

        material.stock = material.stock - r.weight;

        material.totalConsumption+=r.weight;

        material.stockMovements.push({
          date:Date.now(),
          order:order._id,
          orderNumber:order.orderNo,
          quantity:r.weight,
        })

        await material.save();
      }));
    }

    res.status(201).json({

      success: true,
      order

    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error, 400));
  }
}))


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



router.get('/checkMaterialRequired', catchAsyncErrors(async (req, res, next) => {
  try {
    const mat = [];

    const order = await Promise.resolve(Order.findById(req.query.id).populate('elasticOrdered.id').exec());

    let raw = [];

    await Promise.all(order.elasticOrdered.map(async (e) => {
      const weft = e.id.weftYarn.id;
      const covering = e.id.spandexCovering.id;
      const rubber = e.id.warpSpandex.id;
      const warp = e.id.warpYarn;

      const weftDetail = await RawMaterial.findById(weft);
      const weftIdx = raw.find((x) => x.id == weftDetail._id);
      if (weftIdx) {
        raw[weftIdx].weight = raw[weftIdx].weight + (e.id.weftYarn.weight * e.quantity) / 1000;
      }
      else {
        raw.push({
          id: weftDetail._id,
          name: weftDetail.name,
          inStock: weftDetail.stock,
          weight: (e.id.weftYarn.weight * e.quantity) / 1000
        })
      }




      const coverDetail = await RawMaterial.findById(covering);
      const coveringIdx = raw.find((x) => x.id == coverDetail._id);
      if (coveringIdx) {
        raw[coveringIdx].weight = raw[coveringIdx].weight + (e.id.spandexCovering.weight * e.quantity) / 1000;
      }
      else {
        raw.push({
          id: coverDetail._id,
          name: coverDetail.name,
          inStock: coverDetail.stock,
          weight: (e.id.spandexCovering.weight * e.quantity) / 1000
        })
      }




      const rubberDetail = await RawMaterial.findById(rubber);
      const rubberIdx = raw.find((x) => x.id == rubberDetail._id);
      if (rubberIdx) {
        raw[rubberIdx].weight = raw[rubberIdx].weight + (e.id.warpSpandex.weight * e.quantity) / 1000;
      }
      else {
        raw.push({
          id: rubberDetail._id,
          name: rubberDetail.name,
          inStock: rubberDetail.stock,
          weight: (e.id.warpSpandex.weight * e.quantity) / 1000
        })
      }


      await Promise.all(warp.map(async (w) => {
        const warpDetail = await RawMaterial.findById(w.id);
        const warpIdx = raw.find((x) => x.id == warpDetail._id);
        if (warpIdx) {
          raw[warpIdx].weight = raw[warpIdx].weight + (w.weight * e.quantity) / 1000;
        }
        else {
          raw.push({
            id: warpDetail._id,
            name: warpDetail.name,
            inStock: warpDetail.stock,
            weight: (w.weight * e.quantity) / 1000
          })
        }

      }))


    })).then(() => {

      raw.forEach((e) => {
        const i = mat.findIndex((rm) => rm.id.toString() == e.id.toString());


        if (i >= 0) {
          mat[i].weight += e.weight;
        }
        else {
          mat.push(e);
        }

      })
    });

    order.rawmaterialRequired = mat;

    await order.save();






    res.status(201).json({
      raw,
      success: true,
      mat,

    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error, 400));
  }
}))





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


router.get(
  "/get-orderDetail",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const order = await Promise.resolve(Order.findById(req.query.id).populate('elasticOrdered.id').populate('customer').exec());




      const elastics = order.elasticOrdered.map((e) => {
        const name = e.id.name;
        const id = e.id.id;

        const packed = order.packedElastic.find((x) => x.id == id);

        const pending = order.pendingElastic.find((x) => x.id == id);

        const produced = order.producedElastic.find((x) => x.id == id);

        return {
          id: id,
          name: name,
          ordered: e.quantity,
          produced: produced.quantity,
          pending: pending.quantity,
          packed: packed.quantity
        }
      })

      res.status(201).json({
        success: true,
        data: {
          customer: order.customer,
          elastics,
          jobs: order.jobs,
          po: order.po,
          date: order.date,
          deliveryDate: order.supplyDate,
          status: order.status,
          description: order.description,
          orderNo: order.orderNo.toString(),
          _id: order._id,
          rawmaterialRequired: order.rawmaterialRequired
        },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


module.exports = router;





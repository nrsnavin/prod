const express = require("express");
const router = express.Router();

// const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Customer = require("../models/Customer");


router.post(
  "/create",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const customerData = req.body;

    if (!customerData.name) {
      return next(new ErrorHandler("Customer name is required", 400));
    }

    const customer = await Customer.create(customerData);

    res.status(201).json({
      success: true,
      data: customer,
    });
  })
);


router.put(
  "/update",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    console.log("Updating customer:"







      
    );

    const customer = await Customer.findByIdAndUpdate(
      req.body._id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return next(new ErrorHandler("Customer not found", 404));
    }

    res.status(200).json({
      success: true,
      data: customer,
    });
  })
);


// router.delete(
//   "/delete/:id",
//   // isAuthenticated,
//   // isAdmin("Admin"),
//   catchAsyncErrors(async (req, res, next) => {
//     const customer = await Customer.findById(req.params.id);

//     if (!customer) {
//       return next(new ErrorHandler("Customer not found", 404));
//     }

//     customer.isActive = false;
//     await customer.save();

//     res.status(200).json({
//       success: true,
//       message: "Customer deactivated successfully",
//     });
//   })
// );

router.get(
  "/all-customers",
  catchAsyncErrors(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const search = req.query.search || "";

    const skip = (page - 1) * limit;

    const query = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { phoneNumber: { $regex: search, $options: "i" } },
            { gstin: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      customers,
    });
  })
);

router.get(
  "/customerDetail",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {

    console.log("sd");
    
    const customer = await Customer.findById(req.query.id);

    console.log(req.query.id);
    

    if (!customer) {
      return next(new ErrorHandler("Customer not found", 404));
    }

    res.status(200).json({
      success: true,
       customer,
    });
  })
);


module.exports = router;

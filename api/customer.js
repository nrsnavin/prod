const express = require("express");
const router = express.Router();

const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Customer = require("../models/Customer");


router.post(
  "/create",
  isAuthenticated,
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
  "/update/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;

    const customer = await Customer.findByIdAndUpdate(
      id,
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


router.delete(
  "/delete/:id",
  isAuthenticated,
  isAdmin("Admin"),
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return next(new ErrorHandler("Customer not found", 404));
    }

    customer.isActive = false;
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Customer deactivated successfully",
    });
  })
);


router.get(
  "/all",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const customers = await Customer.find({ isActive: true }).sort({
      createdAt: -1,
    });

    res.status(200).json({
      success: true,
      count: customers.length,
      data: customers,
    });
  })
);

router.get(
  "/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return next(new ErrorHandler("Customer not found", 404));
    }

    res.status(200).json({
      success: true,
      data: customer,
    });
  })
);


module.exports = router;

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const Customer = require("../models/Customer");
const Order    = require("../models/Order");

// All customer management routes are admin-only.
router.use(isAuthenticated, isAdmin('admin'));

router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const customerData = req.body;
    if (!customerData.name) {
      return next(new ErrorHandler("Customer name is required", 400));
    }
    const customer = await Customer.create(customerData);
    res.status(201).json({ success: true, data: customer });
  })
);

router.put(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const id = req.body?._id;
    if (!id) return next(new ErrorHandler("_id is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const customer = await Customer.findByIdAndUpdate(
      id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!customer) return next(new ErrorHandler("Customer not found", 404));
    res.status(200).json({ success: true, data: customer });
  })
);

router.get(
  "/all-customers",
  catchAsyncErrors(async (req, res) => {
    const page   = Number(req.query.page)  || 1;
    const limit  = Math.min(Number(req.query.limit) || 20, 200);
    const search = req.query.search        || "";
    const skip   = (page - 1) * limit;

    const query = search ? {
      $or: [
        { name:        { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { gstin:       { $regex: search, $options: "i" } },
      ],
    } : {};

    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({ success: true, customers });
  })
);

router.get(
  "/customerDetail",
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findById(req.query.id);
    if (!customer) return next(new ErrorHandler("Customer not found", 404));
    res.status(200).json({ success: true, customer });
  })
);

router.get(
  "/orders",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Customer id is required", 400));

    const page  = Number(req.query.page)  || 1;
    const limit = Number(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const RUNNING_STATUSES = ["Open", "Approved", "InProgress"];
    const PAST_STATUSES    = ["Completed", "Cancelled"];

    const [running, pastTotal, past] = await Promise.all([
      Order.find({ customer: id, status: { $in: RUNNING_STATUSES } })
        .sort({ createdAt: -1 })
        .select("orderNo po status supplyDate createdAt elasticOrdered")
        .lean(),

      Order.countDocuments({ customer: id, status: { $in: PAST_STATUSES } }),

      Order.find({ customer: id, status: { $in: PAST_STATUSES } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("orderNo po status supplyDate createdAt elasticOrdered")
        .lean(),
    ]);

    res.status(200).json({
      success:   true,
      running,
      past,
      pastTotal,
      page,
      hasMore: skip + past.length < pastTotal,
    });
  })
);

module.exports = router;

const express = require("express");
const router  = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const Customer = require("../models/Customer");
const Order    = require("../models/Order");

// ─────────────────────────────────────────────────────────────
//  POST /customer/create
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  PUT /customer/update
// ─────────────────────────────────────────────────────────────
router.put(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findByIdAndUpdate(
      req.body._id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!customer) return next(new ErrorHandler("Customer not found", 404));
    res.status(200).json({ success: true, data: customer });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /customer/all-customers
// ─────────────────────────────────────────────────────────────
router.get(
  "/all-customers",
  catchAsyncErrors(async (req, res) => {
    const page   = Number(req.query.page)  || 1;
    const limit  = Number(req.query.limit) || 20;
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
      .limit(search ? 0 : limit);

    res.status(200).json({ success: true, customers });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /customer/customerDetail?id=<customerId>
// ─────────────────────────────────────────────────────────────
router.get(
  "/customerDetail",
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findById(req.query.id);
    if (!customer) return next(new ErrorHandler("Customer not found", 404));
    res.status(200).json({ success: true, customer });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /customer/orders?id=<customerId>&page=<n>&limit=<n>&type=running|past
//
//  Returns the customer's orders split into two buckets:
//    running  → status NOT IN [Completed, Cancelled]
//    past     → status IN    [Completed, Cancelled]
//
//  Each call returns ONE bucket (type param), paginated.
//  The "running" bucket is never paginated (usually small).
//  The "past" bucket is paginated.
//
//  Response:
//  {
//    success: true,
//    running: [...],          // always returned (non-paginated)
//    past:    [...],          // paginated
//    pastTotal: <number>,     // total count of past orders
//    page:    <number>,
//    hasMore: <bool>
//  }
// ─────────────────────────────────────────────────────────────
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

    // Run both queries in parallel
    const [running, pastTotal, past] = await Promise.all([

      // All active / in-progress orders — no pagination (usually < 10)
      Order.find({ customer: id, status: { $in: RUNNING_STATUSES } })
        .sort({ createdAt: -1 })
        .select("orderNo po status supplyDate createdAt elasticOrdered")
        .lean(),

      // Count for pagination indicator
      Order.countDocuments({ customer: id, status: { $in: PAST_STATUSES } }),

      // Paginated past orders
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
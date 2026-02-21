const express = require("express");
const router = express.Router();

// const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const Customer = require("../models/Customer");

// ── Create customer ────────────────────────────────────────────
router.post(
  "/create",
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

// ── Update customer ────────────────────────────────────────────
router.put(
  "/update",
  catchAsyncErrors(async (req, res, next) => {
    // FIX: was `console.log("Updating customer:"` — dangling string (broken syntax)
    console.log("Updating customer:", req.body._id);

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

// ── Soft delete (deactivate) ───────────────────────────────────
// FIX: added this route — was called by Flutter controller but missing from backend
router.delete(
  "/delete-customer",
  catchAsyncErrors(async (req, res, next) => {
    const customer = await Customer.findById(req.query.id);

    if (!customer) {
      return next(new ErrorHandler("Customer not found", 404));
    }

    // Soft delete — set status to Inactive instead of hard delete
    customer.status = "Inactive";
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Customer deactivated successfully",
    });
  })
);

// ── Get all customers (paginated + search) ─────────────────────
router.get(
  "/all-customers",
  catchAsyncErrors(async (req, res) => {
    const page   = Number(req.query.page)  || 1;
    const limit  = Number(req.query.limit) || 20;
    const search = req.query.search        || "";

    const skip = (page - 1) * limit;

    const query = search
      ? {
          $or: [
            { name:        { $regex: search, $options: "i" } },
            { phoneNumber: { $regex: search, $options: "i" } },
            { gstin:       { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Customer.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      customers,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  })
);

// ── Get single customer detail ─────────────────────────────────
router.get(
  "/customerDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;

    if (!id) {
      return next(new ErrorHandler("Customer ID is required", 400));
    }

    const customer = await Customer.findById(id).lean();

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
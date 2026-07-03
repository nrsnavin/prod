const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { escapeRegex } = require("../utils/escapeRegex");

const Customer     = require("../models/Customer");
const CustomerUser = require("../models/CustomerUser");
const Order        = require("../models/Order");

// All customer management routes are admin-only.
router.use(isAuthenticated, isAdmin('admin'));

// Fields a client is allowed to set on a customer. Everything else
// (audit fields, anything future/internal) is ignored so the raw body
// can't overwrite protected state.
const CUSTOMER_FIELDS = [
  "name", "email", "gstin", "status", "contactName", "phoneNumber",
  "purchase", "accountant", "merchandiser", "paymentTerms",
];
function pickCustomer(body) {
  const out = {};
  for (const f of CUSTOMER_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const customerData = pickCustomer(req.body);
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
      pickCustomer(req.body),
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
        { name:        { $regex: escapeRegex(search), $options: "i" } },
        { phoneNumber: { $regex: escapeRegex(search), $options: "i" } },
        { gstin:       { $regex: escapeRegex(search), $options: "i" } },
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

// ─────────────────────────────────────────────────────────────────
// Portal user provisioning — admins create the first login for a
// customer. The customer can then invite additional users from
// inside the portal (Phase 2). Self-registration is intentionally
// not exposed — keeps onboarding controlled.
//
// POST /api/v2/customer/:id/portal-users
// Body: { name, email, phone?, role?, password }
// ─────────────────────────────────────────────────────────────────
router.post(
  "/:id/portal-users",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const customer = await Customer.findById(id);
    if (!customer) return next(new ErrorHandler("Customer not found", 404));

    const { name, email, phone, role, password } = req.body || {};
    if (!name || !email || !password) {
      return next(new ErrorHandler("name, email, and password are required", 400));
    }
    // Constrain the portal role to the known set rather than trusting
    // the raw body value (defence-in-depth; the schema enum also guards).
    const PORTAL_ROLES = ["buyer", "viewer", "accountant"];
    const portalRole = PORTAL_ROLES.includes(role) ? role : "buyer";
    const dupe = await CustomerUser.findOne({
      email: String(email).toLowerCase().trim(),
    });
    if (dupe) return next(new ErrorHandler("Email already registered", 409));

    const user = await CustomerUser.create({
      customer: customer._id,
      name,
      email,
      phone: phone || "",
      role:  portalRole,
      password,
    });
    return res.status(201).json({
      success: true,
      user: {
        _id:   user._id,
        name:  user.name,
        email: user.email,
        role:  user.role,
        phone: user.phone,
      },
    });
  })
);

// GET /api/v2/customer/:id/portal-users — list portal users on a customer.
router.get(
  "/:id/portal-users",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const users = await CustomerUser.find({ customer: id })
      .select("name email phone role status lastLoginAt createdAt")
      .lean();
    return res.json({ success: true, users });
  })
);

module.exports = router;

const express  = require("express");
const { versionFilter, bumpVersion, explainMiss } = require("../utils/versioning");
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
router.use(isAuthenticated, isAdmin('admin', 'accounts'));

// Fields a client is allowed to set on a customer. Everything else
// (audit fields, anything future/internal) is ignored so the raw body
// can't overwrite protected state.
const CUSTOMER_FIELDS = [
  "name", "tallyName", "email", "gstin", "status", "contactName", "phoneNumber",
  "address", "city", "pincode", "stateCode",
  "purchase", "accountant", "merchandiser", "paymentTerms", "interestRate", "interestGraceDays", "country", "sez", "currency",
  "creditLimit", "maxOverdueDays", "tan", "pan", "group",
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
    // Filled from a card: what was saved scores the read.
    if (mongoose.Types.ObjectId.isValid(String(req.body?.aiSuggestion || ""))) {
      require("../services/aiLedger").settle(req.body.aiSuggestion, {
        accepted: { name: customer.name, contactName: customer.contactName || "", phone: customer.phoneNumber || "", email: customer.email || "", gstin: customer.gstin || "", address: customer.address || "", city: customer.city || "", pincode: customer.pincode || "" },
        decidedBy: req.user?._id, expectSurface: "party-card-ocr", ignoreMissing: true,
      }).catch(() => {});
    }
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
    // Compare-and-set: two people editing one customer used to be last
    // write wins, silently. With the version the form loaded, a stale
    // save is a 409 instead. See utils/versioning.js.
    const changes = pickCustomer(req.body);
    const customer = await Customer.findOneAndUpdate(
      { _id: id, ...versionFilter(req) },
      { ...(Object.keys(changes).length ? { $set: changes } : {}), ...bumpVersion() },
      { new: true, runValidators: true }
    );
    if (!customer) await explainMiss(Customer, id, req, "Customer not found");
    res.status(200).json({ success: true, data: customer });
  })
);

// ── GET /credit/:id ─────────────────────────────────────────────
// Where a customer stands against their credit limit — read by the
// order, challan and invoice screens before they commit.
// The customer groups in use, for the picker on the customer form.
router.get(
  "/groups",
  catchAsyncErrors(async (_req, res) => {
    const groups = (await Customer.distinct("group", { group: { $nin: ["", null] } })).sort((a, b) => a.localeCompare(b));
    res.json({ success: true, groups });
  })
);

router.get(
  "/credit/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!require("mongoose").Types.ObjectId.isValid(String(req.params.id))) return next(new ErrorHandler("Customer not found", 404));
    const pos = await require("../services/creditControl").check(req.params.id);
    if (!pos) return next(new ErrorHandler("Customer not found", 404));
    res.json({ success: true, ...pos });
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

    // Archived customers stay out of lists and pickers unless asked for.
    // `$ne: true` rather than `false`, so records predating the field
    // still count as active.
    if (req.query.includeArchived !== "true") query.archived = { $ne: true };

    // The total and page count go with the page of customers. Without
    // them the web list headed itself "undefined customers" and could
    // never offer a second page.
    const [customers, counted] = await Promise.all([
      Customer.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Customer.countDocuments(query),
    ]);
    const total = Number(counted) || 0;

    res.status(200).json({
      success: true,
      customers,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  ARCHIVE / UNARCHIVE (soft delete)
//  PATCH /api/v2/customer/:id/archive   { archived: true|false }
//
//  The detail page has offered a "Deactivate" button for some time
//  with nothing behind it — the route did not exist, so pressing it
//  404'd. This is that button's other half.
//
//  Nothing is deleted. Orders, delivery challans and ledger rows keep
//  their references; the customer simply stops appearing in lists and
//  pickers (override with ?includeArchived=true).
//
//  Guard: a customer with live orders cannot be archived. Hiding them
//  while work is running would leave those orders pointing at someone
//  nobody can look up — the same reason an elastic with reservations
//  is protected. Completed and cancelled orders are history and do not
//  block it.
// ─────────────────────────────────────────────────────────────
router.patch(
  "/:id/archive",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const wantArchived = req.body?.archived !== false; // default: archive

    const customer = await Customer.findById(id).select("_id name archived");
    if (!customer) return next(new ErrorHandler("Customer not found", 404));

    if (wantArchived) {
      const live = await Order.countDocuments({
        customer: customer._id,
        status: { $nin: ["Completed", "Cancelled"] },
      });
      if (live > 0) {
        return next(new ErrorHandler(
          `Cannot archive "${customer.name}" — ${live} order${live === 1 ? " is" : "s are"} still open. Complete or cancel them first.`,
          400
        ));
      }
    }

    customer.archived   = wantArchived;
    customer.archivedAt = wantArchived ? new Date() : undefined;
    await customer.save();

    res.json({
      success:    true,
      customerId: customer._id,
      name:       customer.name,
      archived:   customer.archived,
      message:    wantArchived
        ? `"${customer.name}" archived — hidden from lists`
        : `"${customer.name}" restored to active lists`,
    });
  })
);

router.get(
  "/customerDetail",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.query.id || ""))) {
      return next(new ErrorHandler("Customer not found", 404));
    }
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
// GET /api/v2/customer/:id/recent — the customer's recent paperwork
// in one read: latest orders, the challans that went out on them,
// and the invoices raised. A challan carries no customer reference
// (only the order's), so it is reached through the orders.
router.get(
  "/:id/recent",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const DeliveryChallan = require("../models/DeliveryChallan");
    const Invoice = require("../models/Invoice");

    const orders = await Order.find({ customer: id })
      .select("orderNo po status supplyDate createdAt")
      .sort({ createdAt: -1 })
      .lean();
    const orderIds = orders.map((o) => o._id);
    const orderNos = orders.map((o) => o.orderNo).filter((n) => n != null);
    const dcMatch = [{ order: { $in: orderIds } }];
    if (orderNos.length) dcMatch.push({ orderNo: { $in: orderNos } });

    const [dcs, dcTotal, invoices, invoiceTotal, invoiced] = await Promise.all([
      orderIds.length
        ? DeliveryChallan.find({ $or: dcMatch })
            .select("dcNumber status type dispatchDate totalQuantity orderNo order createdAt")
            .sort({ createdAt: -1 }).limit(limit).lean()
        : [],
      orderIds.length ? DeliveryChallan.countDocuments({ $or: dcMatch }) : 0,
      Invoice.find({ customer: id })
        .select("invoiceNumber invoiceDate status totals.grand einvoice.status einvoice.irn orderNo order createdAt")
        .sort({ createdAt: -1 }).limit(limit).lean(),
      Invoice.countDocuments({ customer: id }),
      Invoice.aggregate([
        { $match: { customer: new mongoose.Types.ObjectId(id), status: "issued" } },
        { $group: { _id: null, amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      orders: orders.slice(0, limit),
      orderTotal: orders.length,
      dcs, dcTotal,
      invoices, invoiceTotal,
      invoiced: { amount: invoiced[0]?.amount || 0, count: invoiced[0]?.count || 0 },
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

    const { phone, role, password } = req.body || {};
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!name || !email || !password) {
      return next(new ErrorHandler("name, email, and password are required", 400));
    }
    if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(new ErrorHandler("That is not an email address", 400));
    }
    // The same rule as a staff login (utils/passwordPolicy.js): this
    // one opens a customer's orders and invoices to whoever guesses it.
    const weak = require("../utils/passwordPolicy").passwordProblem(password, { email, name });
    if (weak) return next(new ErrorHandler(weak, 400));
    // Constrain the portal role to the known set rather than trusting
    // the raw body value (defence-in-depth; the schema enum also guards).
    const portalRole = ["buyer", "viewer", "accountant"].includes(role) ? role : "buyer";
    const dupe = await CustomerUser.findOne({ email });
    if (dupe) return next(new ErrorHandler("Email already registered", 409));

    const user = await CustomerUser.create({
      customer: customer._id,
      name,
      email,
      phone: typeof phone === "string" ? phone.trim().slice(0, 30) : "",
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

// ─────────────────────────────────────────────────────────────────
// A portal login, after it has been made.
//
// One could be created and listed and nothing else: a login given to a
// buyer who has since left the customer could not be switched off, a
// password that had got out could not be changed, and a login made by
// mistake could not be removed — short of editing the database.
//
// PATCH  /api/v2/customer/:id/portal-users/:userId
//        { status?: "active"|"disabled", password?, name?, phone?, role? }
// DELETE /api/v2/customer/:id/portal-users/:userId
//
// Switched off, or given a new password, the sessions it already has
// open end with it (models/CustomerUser.js tokenVersion). The login must
// be this customer's: an id from another customer is not found here.
// ─────────────────────────────────────────────────────────────────
const PORTAL_ROLES = ["buyer", "viewer", "accountant"];
const PORTAL_STATUSES = ["active", "disabled"];
const portalUserOut = (u) => ({
  _id: u._id, name: u.name, email: u.email, phone: u.phone, role: u.role,
  status: u.status, lastLoginAt: u.lastLoginAt || null,
});

async function loadPortalUser(req, next) {
  const { id, userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
    next(new ErrorHandler("Portal login not found", 404));
    return null;
  }
  const user = await CustomerUser.findOne({ _id: userId, customer: id });
  if (!user) next(new ErrorHandler("Portal login not found", 404));
  return user;
}

router.patch(
  "/:id/portal-users/:userId",
  catchAsyncErrors(async (req, res, next) => {
    const user = await loadPortalUser(req, next);
    if (!user) return;
    const b = req.body || {};
    let endSessions = false;

    if (b.status !== undefined) {
      if (!PORTAL_STATUSES.includes(b.status)) return next(new ErrorHandler("status must be active or disabled", 400));
      if (b.status === "disabled" && user.status !== "disabled") endSessions = true;
      user.status = b.status;
    }
    if (b.role !== undefined) {
      if (!PORTAL_ROLES.includes(b.role)) return next(new ErrorHandler("role must be buyer, viewer or accountant", 400));
      user.role = b.role;
    }
    if (b.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
      if (name.length < 2) return next(new ErrorHandler("name is required", 400));
      user.name = name;
    }
    if (b.phone !== undefined) user.phone = typeof b.phone === "string" ? b.phone.trim().slice(0, 30) : "";
    if (b.password !== undefined) {
      if (typeof b.password !== "string") return next(new ErrorHandler("password must be text", 400));
      // The rule a new login is held to (utils/passwordPolicy.js).
      const weak = require("../utils/passwordPolicy").passwordProblem(b.password, { email: user.email, name: user.name });
      if (weak) return next(new ErrorHandler(weak, 400));
      user.password = b.password; // hashed on save
      endSessions = true;
    }
    if (endSessions) user.tokenVersion = (user.tokenVersion ?? 0) + 1;

    await user.save();
    return res.json({ success: true, sessionsEnded: endSessions, user: portalUserOut(user) });
  })
);

router.delete(
  "/:id/portal-users/:userId",
  catchAsyncErrors(async (req, res, next) => {
    const user = await loadPortalUser(req, next);
    if (!user) return;
    await CustomerUser.deleteOne({ _id: user._id, customer: user.customer });
    return res.json({ success: true, removed: portalUserOut(user) });
  })
);

// A card or letterhead into the form, and who on file looks the same.
require("./partyIntake").mountPartyIntake(router, Customer, { kind: "customer" });

module.exports = router;

// api/elasticGroup.js
//
// CRUD for elastic groups (named bundles of elastics, optionally tied
// to a customer). Mount: app.use('/api/v2/elastic-group', require('./api/elasticGroup'));

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");

const ElasticGroup = require("../models/ElasticGroup");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

router.use(isAuthenticated);

const populate = (q) =>
  q
    .populate("customer", "name")
    .populate("items.elastic", "name weaveType");

// Validate + normalise an items array from the request body.
function cleanItems(items) {
  if (!Array.isArray(items)) return { error: "items must be an array" };
  const out = [];
  for (const [i, it] of items.entries()) {
    if (!it || !it.elastic || !mongoose.Types.ObjectId.isValid(it.elastic)) {
      return { error: `items[${i}].elastic is required and must be a valid id` };
    }
    const qty = Number(it.defaultQuantity);
    out.push({ elastic: it.elastic, defaultQuantity: Number.isFinite(qty) && qty > 0 ? qty : 0 });
  }
  return { items: out };
}

// ─────────────────────────────────────────────────────────────
//  GET /elastic-group
//    ?customerId=<id>  → that customer's groups + global groups
//    (no customerId)   → every group
//    ?includeInactive=1 to include archived groups
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  catchAsyncErrors(async (req, res, next) => {
    const { customerId, includeInactive } = req.query;
    const filter = {};
    if (!includeInactive) filter.isActive = true;
    if (customerId) {
      if (!mongoose.Types.ObjectId.isValid(customerId)) {
        return next(new ErrorHandler("Invalid customerId", 400));
      }
      // The customer's own groups plus global (customer: null) bundles.
      filter.$or = [{ customer: customerId }, { customer: null }];
    }
    const groups = await populate(ElasticGroup.find(filter).sort({ updatedAt: -1 })).lean();
    res.json({ success: true, count: groups.length, groups });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /elastic-group/:id
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid group id", 400));
    }
    const group = await populate(ElasticGroup.findById(req.params.id)).lean();
    if (!group) return next(new ErrorHandler("Elastic group not found", 404));
    res.json({ success: true, group });
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /elastic-group
//    { name, customer?, items: [{ elastic, defaultQuantity }] }
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { name, customer = null, items } = req.body;
    if (!name?.trim()) return next(new ErrorHandler("name is required", 400));
    if (customer && !mongoose.Types.ObjectId.isValid(customer)) {
      return next(new ErrorHandler("Invalid customer id", 400));
    }
    const parsed = cleanItems(items);
    if (parsed.error) return next(new ErrorHandler(parsed.error, 400));
    if (parsed.items.length === 0) return next(new ErrorHandler("Add at least one elastic", 400));

    const group = await ElasticGroup.create({
      name: name.trim(),
      customer: customer || null,
      items: parsed.items,
    });
    const full = await populate(ElasticGroup.findById(group._id)).lean();
    res.status(201).json({ success: true, group: full });
  })
);

// ─────────────────────────────────────────────────────────────
//  PUT /elastic-group/:id
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid group id", 400));
    }
    const { name, customer, items, isActive } = req.body;
    const update = {};
    if (name != null) {
      if (!name.trim()) return next(new ErrorHandler("name cannot be empty", 400));
      update.name = name.trim();
    }
    if (customer !== undefined) {
      if (customer && !mongoose.Types.ObjectId.isValid(customer)) {
        return next(new ErrorHandler("Invalid customer id", 400));
      }
      update.customer = customer || null;
    }
    if (items !== undefined) {
      const parsed = cleanItems(items);
      if (parsed.error) return next(new ErrorHandler(parsed.error, 400));
      if (parsed.items.length === 0) return next(new ErrorHandler("Add at least one elastic", 400));
      update.items = parsed.items;
    }
    if (isActive !== undefined) update.isActive = !!isActive;

    const group = await populate(
      ElasticGroup.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
    ).lean();
    if (!group) return next(new ErrorHandler("Elastic group not found", 404));
    res.json({ success: true, group });
  })
);

// ─────────────────────────────────────────────────────────────
//  DELETE /elastic-group/:id
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid group id", 400));
    }
    const group = await ElasticGroup.findByIdAndDelete(req.params.id);
    if (!group) return next(new ErrorHandler("Elastic group not found", 404));
    res.json({ success: true, message: "Elastic group deleted" });
  })
);

module.exports = router;

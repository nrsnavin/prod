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
const Customer     = require("../models/Customer");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

router.use(isAuthenticated);

// `archived` with each elastic: a group names its elastics for good, and
// one retired since is out of every picker — the order form has to be
// able to leave it off a new order rather than put it back on one.
const populate = (q) =>
  q
    .populate("customer", "name")
    .populate("items.elastic", "name weaveType archived");

// Validate + normalise an items array from the request body.
function cleanItems(items) {
  if (!Array.isArray(items)) return { error: "items must be an array" };
  const out = [];
  const seen = new Set();
  for (const [i, it] of items.entries()) {
    if (!it || !it.elastic || !mongoose.Types.ObjectId.isValid(it.elastic)) {
      return { error: `items[${i}].elastic is required and must be a valid id` };
    }
    // Once each. An order refuses one elastic on two lines, so a bundle
    // that named one twice filled the order form with a pair the order
    // then would not save. (Adding from the elastic list's selection has
    // always guarded this; making and editing a group did not.)
    const id = String(it.elastic);
    if (seen.has(id)) return { error: `items[${i}]: that elastic is already on the list — give it one line` };
    seen.add(id);
    const qty = Number(it.defaultQuantity);
    out.push({ elastic: it.elastic, defaultQuantity: Number.isFinite(qty) && qty > 0 ? qty : 0 });
  }
  return { items: out };
}

/** The group's name as text, trimmed; "" when it is not text or is blank. */
const cleanName = (name) => (typeof name === "string" ? name.trim() : "");

/** A customer that is one — or none, for a bundle anyone may use. */
async function customerProblem(customer) {
  if (!customer) return null;
  if (!mongoose.Types.ObjectId.isValid(String(customer))) return "Invalid customer id";
  return (await Customer.exists({ _id: customer })) ? null : "Choose a customer that exists";
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
    const { customer = null, items } = req.body || {};
    const name = cleanName(req.body?.name);
    if (!name) return next(new ErrorHandler("name is required", 400));
    const noCustomer = await customerProblem(customer);
    if (noCustomer) return next(new ErrorHandler(noCustomer, 400));
    const parsed = cleanItems(items);
    if (parsed.error) return next(new ErrorHandler(parsed.error, 400));
    if (parsed.items.length === 0) return next(new ErrorHandler("Add at least one elastic", 400));

    const group = await ElasticGroup.create({
      name,
      customer: customer || null,
      items: parsed.items,
    });
    const full = await populate(ElasticGroup.findById(group._id)).lean();
    res.status(201).json({ success: true, group: full });
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /elastic-group/:id/add-elastics   { elastics: [id, …] }
//
//  Adds elastics to a group from the elastic list's selection, keeping
//  the ones it has (and their default quantities). One conditional push
//  per elastic, so two people adding the same one at once add it once.
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/add-elastics",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid group id", 400));
    }
    const ids = Array.isArray(req.body?.elastics) ? [...new Set(req.body.elastics.map(String))] : [];
    if (ids.length === 0) return next(new ErrorHandler("Select at least one elastic", 400));
    if (ids.length > 200) return next(new ErrorHandler("At most 200 elastics at a time", 400));
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return next(new ErrorHandler("Invalid elastic id", 400));
    }
    if (!(await ElasticGroup.exists({ _id: req.params.id }))) {
      return next(new ErrorHandler("Group not found", 404));
    }

    let added = 0;
    for (const id of ids) {
      const r = await ElasticGroup.updateOne(
        { _id: req.params.id, "items.elastic": { $ne: new mongoose.Types.ObjectId(id) } },
        { $push: { items: { elastic: id, defaultQuantity: 0 } } }
      );
      added += r.modifiedCount;
    }
    const group = await populate(ElasticGroup.findById(req.params.id)).lean();
    res.json({ success: true, added, alreadyThere: ids.length - added, group });
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
    const { name, customer, items, isActive } = req.body || {};
    const update = {};
    if (name != null) {
      if (!cleanName(name)) return next(new ErrorHandler("name cannot be empty, and must be text", 400));
      update.name = cleanName(name);
    }
    if (customer !== undefined) {
      const noCustomer = await customerProblem(customer);
      if (noCustomer) return next(new ErrorHandler(noCustomer, 400));
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

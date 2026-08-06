'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER P&L API  —  /api/v2/pnl
//
//  Reading:
//    GET  /pnl/orders            one row per order — value, cost, margin
//    GET  /pnl/order/:orderId    the full breakdown for one order
//    GET  /pnl/settings          the ₹/meter conversion rate card
//
//  Writing (the three inputs the P&L needs that no other screen owns):
//    PUT  /pnl/order/:orderId/rates       selling rate per order line
//    PUT  /pnl/job/:jobId/cost-overrides  a job's actual conversion cost
//    PUT  /pnl/settings                   the rate card (admin only)
//
//  The whole router sits behind the `/order-pnl` feature, so margin can
//  be granted to the people who should see it without also handing over
//  the orders screen — and withheld from the people who shouldn't
//  without taking their orders screen away.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const catchAsyncErrors = require('../middleware/catchAsyncErrors.js');
const { isAdmin } = require('../middleware/auth.js');
const ErrorHandler = require('../utils/ErrorHandler.js');
const Order = require('../models/Order.js');
const JobOrder = require('../models/JobOrder.js');
const CostSettings = require('../models/CostSettings.js');
const { orderPnl } = require('../services/orderPnl.js');
const { buildOrderPnlPdf } = require('../utils/orderPnlPdf.js');
const { parseMoney, MAX_RATE, MAX_AMOUNT } = require('../utils/money.js');
const { getPdfBranding } = require('../services/documentSettings.js');
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint.js');

// A P&L is several queries per order, so the list is hard-capped rather
// than trusting a client-supplied limit. Asking for every order would
// otherwise be one URL away from a few thousand round trips.
const MAX_PAGE = 50;
const DEFAULT_PAGE = 25;

const RATE_CARD_FIELDS = [
  'finishingRatePerMeter',
  'checkingRatePerMeter',
  'packingRatePerMeter',
  'overheadRatePerMeter',
];

const OVERRIDE_FIELDS = ['finishing', 'checking', 'packing', 'overhead'];

// Orders that never became work carry no cost worth reporting, and
// listing them buries the ones that do.
const LIST_EXCLUDED_STATUSES = ['Deleted'];

// ── The rate card ────────────────────────────────────────────────
router.get(
  '/settings',
  catchAsyncErrors(async (_req, res) => {
    const doc = await CostSettings.findOne({ key: 'cost' }).lean();
    res.status(200).json({
      success: true,
      settings: {
        finishingRatePerMeter: doc?.finishingRatePerMeter ?? 0,
        checkingRatePerMeter:  doc?.checkingRatePerMeter ?? 0,
        packingRatePerMeter:   doc?.packingRatePerMeter ?? 0,
        overheadRatePerMeter:  doc?.overheadRatePerMeter ?? 0,
        notes:                 doc?.notes ?? '',
        configured:            Boolean(doc),
        updatedAt:             doc?.updatedAt ?? null,
      },
    });
  })
);

router.put(
  '/settings',
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const update = {};
    for (const field of RATE_CARD_FIELDS) {
      if (req.body[field] === undefined) continue;
      // Strict: null, '', true and 1e308 all pass a
      // Number.isFinite(Number(v)) check and none of them is a rate.
      // This one re-costs EVERY order in the factory, so it is the
      // last place to be lenient.
      const parsed = parseMoney(req.body[field], { max: MAX_RATE, label: field });
      if (!parsed.ok) return next(new ErrorHandler(parsed.reason, 400));
      update[field] = parsed.value;
    }
    if (req.body.notes !== undefined) update.notes = String(req.body.notes).slice(0, 2000);

    if (Object.keys(update).length === 0) {
      return next(new ErrorHandler('No rate card fields supplied', 400));
    }

    const settings = await CostSettings.findOneAndUpdate(
      { key: 'cost' },
      { $set: update, $setOnInsert: { key: 'cost' } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    res.status(200).json({ success: true, settings });
  })
);

// ── Selling rates on an order's lines ────────────────────────────
//
// Deliberately NOT part of /order/update-order: that route only edits
// an Open order, and the price is exactly the thing that gets agreed
// late, argued over, and corrected long after approval. Refusing to
// record the real price on an in-progress order would mean the P&L
// reports a margin nobody agreed to.
router.put(
  '/order/:orderId/rates',
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const { rates } = req.body;
    if (!Array.isArray(rates) || rates.length === 0) {
      return next(new ErrorHandler('rates must be a non-empty array of { elastic, rate }', 400));
    }

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler('Order not found', 404));

    const wanted = new Map();
    for (const r of rates) {
      const id = String(r?.elastic ?? '');
      if (!id) return next(new ErrorHandler('Every rate needs an elastic id', 400));
      // NOT allowNull. A rate of 0 is this app's signal for "not
      // priced", so accepting null here would silently un-price a line
      // and answer 200 OK. Clearing a price is not an operation.
      const parsed = parseMoney(r?.rate, { max: MAX_RATE, label: 'Selling rate' });
      if (!parsed.ok) return next(new ErrorHandler(parsed.reason, 400));
      wanted.set(id, parsed.value);
    }

    const previous = {};
    let applied = 0;
    for (const line of order.elasticOrdered) {
      const key = String(line.elastic);
      if (!wanted.has(key)) continue;
      previous[key] = line.rate ?? 0;
      line.rate = wanted.get(key);
      applied += 1;
    }

    // A rate for an elastic the order does not carry is a mis-click or a
    // stale form, not something to apply silently to nothing.
    if (applied === 0) {
      return next(new ErrorHandler(
        'None of those elastics are on this order', 400));
    }

    order.fingerprints.push(buildFingerprint(ACTION_CODES.ORDER_UPDATED, {
      entityId: order._id,
      actor: actorFromRequest(req),
      meta: {
        changedFields: ['elasticOrdered.rate'],
        previousValues: previous,
        newValues: Object.fromEntries(wanted),
        auditReason: 'Selling rates updated for order P&L',
      },
    }));
    await order.save();

    res.status(200).json({
      success: true,
      message: `Updated ${applied} selling rate(s)`,
      rates: order.elasticOrdered.map((l) => ({
        elastic: String(l.elastic),
        quantity: l.quantity,
        rate: l.rate ?? 0,
      })),
    });
  })
);

// ── A job's actual conversion cost ───────────────────────────────
router.put(
  '/job/:jobId/cost-overrides',
  isAdmin('admin', 'accounts', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      return next(new ErrorHandler('Invalid job id', 400));
    }
    const job = await JobOrder.findById(jobId);
    if (!job) return next(new ErrorHandler('Job not found', 404));

    const next$ = {};
    for (const field of OVERRIDE_FIELDS) {
      if (!(field in req.body)) continue;
      // null / "" clears the override and hands the line back to the
      // rate card — a real operation here, unlike on a selling rate.
      // 0 is a different answer again: "this stage cost nothing".
      const parsed = parseMoney(req.body[field], {
        max: MAX_AMOUNT, label: field, allowNull: true,
      });
      if (!parsed.ok) {
        return next(new ErrorHandler(`${parsed.reason}, or null to clear it`, 400));
      }
      next$[field] = parsed.value;
    }
    if (req.body.notes !== undefined) next$.notes = String(req.body.notes).slice(0, 2000);

    if (Object.keys(next$).length === 0) {
      return next(new ErrorHandler('No cost override fields supplied', 400));
    }

    job.costOverrides = { ...(job.costOverrides || {}), ...next$ };
    job.costOverrides.recordedBy = req.user?._id || null;
    job.costOverrides.recordedAt = new Date();
    await job.save();

    res.status(200).json({
      success: true,
      message: 'Cost overrides saved',
      costOverrides: job.costOverrides,
    });
  })
);

// ── One order's P&L, as a printed statement ──────────────────────
//
// Declared BEFORE /order/:orderId so the ".pdf" suffix is not swallowed
// by the id parameter. Both are fed by the same service, so the screen
// and the paper can never tell different stories.
router.get(
  '/order/:orderId.pdf',
  catchAsyncErrors(async (req, res, next) => {
    const pnl = await orderPnl(req.params.orderId);
    if (!pnl) return next(new ErrorHandler('Order not found', 404));

    pnl.branding = await getPdfBranding();
    const pdf = await buildOrderPnlPdf(pnl);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="order-pnl-${pnl.order.orderNo ?? req.params.orderId}.pdf"`
    );
    res.send(pdf);
  })
);

// ── One order's P&L ──────────────────────────────────────────────
router.get(
  '/order/:orderId',
  catchAsyncErrors(async (req, res, next) => {
    const pnl = await orderPnl(req.params.orderId);
    if (!pnl) return next(new ErrorHandler('Order not found', 404));
    res.status(200).json({ success: true, pnl });
  })
);

// ── Every order, one row each ────────────────────────────────────
//
// `sort=margin` ranks by margin PERCENT, `profit` by rupees. They
// disagree often enough to matter: a small order can be the best
// margin and irrelevant to the month.
router.get(
  '/orders',
  catchAsyncErrors(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
    const sort = ['margin', 'profit', 'value', 'recent'].includes(req.query.sort)
      ? req.query.sort : 'recent';

    const filter = { status: { $nin: LIST_EXCLUDED_STATUSES } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customer && mongoose.Types.ObjectId.isValid(String(req.query.customer))) {
      filter.customer = req.query.customer;
    }
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to) filter.date.$lte = new Date(req.query.to);
    }

    const total = await Order.countDocuments(filter);
    // Page over ORDERS at the database, then cost the page. Sorting by
    // margin cannot be pushed down — it does not exist until the P&L is
    // built — so that sort orders the page, and the response says so.
    const ids = await Order.find(filter)
      .select('_id')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const rows = [];
    for (const { _id } of ids) {
      const pnl = await orderPnl(_id);
      if (!pnl) continue;
      rows.push({
        ...pnl.order,
        orderValue: pnl.revenue.orderValue,
        invoiced: pnl.revenue.invoiced.amount,
        cost: pnl.costs.total,
        costs: pnl.costs,
        profit: pnl.totals.profit,
        marginPct: pnl.totals.marginPct,
        producedMeters: pnl.totals.producedMeters,
        jobs: pnl.jobs.length,
        warnings: pnl.warnings.length,
      });
    }

    // null margin (an unpriced order) sorts last in every ranking
    // rather than to the top as a fake -100%.
    const byNullLast = (get) => (a, b) => {
      const av = get(a), bv = get(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    };
    if (sort === 'margin') rows.sort(byNullLast((r) => r.marginPct));
    else if (sort === 'profit') rows.sort(byNullLast((r) => r.profit));
    else if (sort === 'value') rows.sort(byNullLast((r) => r.orderValue));

    res.status(200).json({
      success: true,
      rows,
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      sort,
      // The sort applies WITHIN the page, not across the whole result
      // set — say so, rather than letting a "top margin" heading imply
      // it searched everything.
      sortScope: sort === 'recent' ? 'all' : 'page',
      totals: {
        orderValue: Math.round(rows.reduce((s, r) => s + r.orderValue, 0) * 100) / 100,
        cost: Math.round(rows.reduce((s, r) => s + r.cost, 0) * 100) / 100,
        profit: Math.round(rows.reduce((s, r) => s + r.profit, 0) * 100) / 100,
      },
    });
  })
);

module.exports = router;

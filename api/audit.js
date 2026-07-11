'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Plant-wide audit feed.
//
//  Every meaningful state change already lands as a tamper-evident
//  fingerprint on its aggregate (Order / JobOrder / PurchaseOrder /
//  DeliveryChallan). This route reads them ACROSS collections so an
//  admin can answer "who did what today" without opening documents
//  one by one. Read-only — the fingerprints themselves are the record.
// ═══════════════════════════════════════════════════════════════════

const express = require("express");
const router  = express.Router();

const Order           = require("../models/Order");
const JobOrder        = require("../models/JobOrder");
const PurchaseOrder   = require("../models/PurchaseOrder");
const DeliveryChallan = require("../models/DeliveryChallan");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");

// Pull the most recent fingerprints from one collection, tagged with
// entity type + human number so the feed row is self-describing.
function recentFrom(Model, entityType, numberField, limit) {
  return Model.aggregate([
    { $match: { "fingerprints.0": { $exists: true } } },
    { $project: { fingerprints: 1, no: `$${numberField}` } },
    { $unwind: "$fingerprints" },
    { $sort: { "fingerprints.at": -1 } },
    { $limit: limit },
    { $project: {
        _id: 0,
        entityType,
        entityId: "$_id",
        entityNo: "$no",
        code:    "$fingerprints.code",
        label:   "$fingerprints.label",
        shortId: "$fingerprints.shortId",
        at:      "$fingerprints.at",
        actor:   "$fingerprints.actor",
        reason:  "$fingerprints.meta.auditReason",
      } },
  ]);
}

// GET /audit/recent?limit=50 — newest actions across all aggregates.
router.get(
  "/recent",
  catchAsyncErrors(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const [orders, jobs, pos, dcs] = await Promise.all([
      recentFrom(Order,           "Order",           "orderNo",    limit),
      recentFrom(JobOrder,        "JobOrder",        "jobOrderNo", limit),
      recentFrom(PurchaseOrder,   "PurchaseOrder",   "poNo",       limit),
      recentFrom(DeliveryChallan, "DeliveryChallan", "dcNumber",   limit),
    ]);

    const entries = [...orders, ...jobs, ...pos, ...dcs]
      .filter((e) => e.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);

    res.json({ success: true, count: entries.length, entries });
  })
);

module.exports = router;

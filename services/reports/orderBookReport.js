"use strict";
// ═════════════════════════════════════════════════════════════════
//  Order book & fulfillment report.
//
//  The window filters orders by placement date (order intake). Reports
//  ordered vs pending quantity, how much of the book is still open, how
//  much is overdue (open past its supplyDate as of `now`), and on-time
//  delivery — the share of window dispatches that went out on or before
//  the parent order's supplyDate (same rule as /dc/otd-stats).
//
//  Group-by: customer / status / supply-month. Orders carry no price,
//  so this report is quantity-based (meters), not value.
// ═════════════════════════════════════════════════════════════════

const Order = require("../../models/Order.js");
const DeliveryChallan = require("../../models/DeliveryChallan.js");
const { previousWindow } = require("./range.js");

const GROUP_BYS = ["customer", "status", "supplyMonth"];
const OPEN_STATUSES = ["Open", "Approved", "InProgress"];
const DAY_MS = 86_400_000;

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

// Exclude soft-deleted orders from every figure.
const matchFor = (from, to) => ({ date: { $gte: from, $lt: to }, status: { $nin: ["Deleted"] } });

async function _summary(from, to, now) {
  const [agg] = await Order.aggregate([
    { $match: matchFor(from, to) },
    { $group: {
        _id: null,
        orders: { $sum: 1 },
        orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } },
        pendingQty: { $sum: { $sum: "$pendingElastic.quantity" } },
        open: { $sum: { $cond: [{ $in: ["$status", OPEN_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] } },
        overdue: { $sum: { $cond: [
          { $and: [{ $in: ["$status", OPEN_STATUSES] }, { $lt: ["$supplyDate", now] }] }, 1, 0,
        ] } },
    } },
  ]);
  const r = agg || {};

  const otd = await _otd(from, to);

  return {
    orders: r.orders || 0,
    orderedQty: round(r.orderedQty || 0),
    pendingQty: round(r.pendingQty || 0),
    openOrders: r.open || 0,
    completedOrders: r.completed || 0,
    overdueOrders: r.overdue || 0,
    onTimePct: otd.onTimePct,
    otdConsidered: otd.considered,
  };
}

// On-time delivery over the window: non-cancelled, order-linked DCs
// dispatched in [from, to), on time when dispatchDate ≤ order.supplyDate.
async function _otd(from, to) {
  const dcs = await DeliveryChallan.find({
    order: { $ne: null },
    status: { $ne: "cancelled" },
    dispatchDate: { $gte: from, $lt: to },
  })
    .populate("order", "supplyDate")
    .select("dispatchDate order")
    .lean();

  let considered = 0;
  let onTime = 0;
  for (const dc of dcs) {
    const due = dc.order?.supplyDate ? new Date(dc.order.supplyDate) : null;
    if (!due) continue;
    considered += 1;
    // Compare on day granularity: same-day dispatch is on time.
    const lateDays = Math.ceil((new Date(dc.dispatchDate) - due) / DAY_MS);
    if (lateDays <= 0) onTime += 1;
  }
  return {
    considered,
    onTime,
    onTimePct: considered > 0 ? round((onTime / considered) * 100) : null,
  };
}

async function _rows(from, to, groupBy) {
  const match = matchFor(from, to);

  if (groupBy === "status") {
    const rows = await Order.aggregate([
      { $match: match },
      { $group: { _id: "$status", orders: { $sum: 1 }, orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } }, pendingQty: { $sum: { $sum: "$pendingElastic.quantity" } } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", orders: 1, orderedQty: 1, pendingQty: 1 } },
      { $sort: { orders: -1 } },
    ]);
    return rows.map((r) => ({ ...r, orderedQty: round(r.orderedQty), pendingQty: round(r.pendingQty) }));
  }

  if (groupBy === "supplyMonth") {
    const rows = await Order.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$supplyDate" } }, orders: { $sum: 1 }, pendingQty: { $sum: { $sum: "$pendingElastic.quantity" } } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", orders: 1, pendingQty: 1 } },
      { $sort: { label: 1 } },
    ]);
    return rows.map((r) => ({ ...r, pendingQty: round(r.pendingQty) }));
  }

  // customer (default)
  const rows = await Order.aggregate([
    { $match: match },
    { $group: { _id: "$customer", orders: { $sum: 1 }, orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } }, pendingQty: { $sum: { $sum: "$pendingElastic.quantity" } } } },
    { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "c" } },
    { $unwind: { path: "$c", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$c.name", "—"] }, orders: 1, orderedQty: 1, pendingQty: 1 } },
    { $sort: { pendingQty: -1 } },
  ]);
  return rows.map((r) => ({ ...r, orderedQty: round(r.orderedQty), pendingQty: round(r.pendingQty) }));
}

async function _series(from, to) {
  const rows = await Order.aggregate([
    { $match: matchFor(from, to) },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, quantity: { $sum: { $sum: "$elasticOrdered.quantity" } } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", quantity: 1 } },
  ]);
  return rows.map((r) => ({ date: r.date, quantity: round(r.quantity) }));
}

function _columns(groupBy) {
  if (groupBy === "supplyMonth") {
    return [
      { key: "label", header: "Supply month", format: "text" },
      { key: "orders", header: "Orders", format: "number" },
      { key: "pendingQty", header: "Pending", format: "number" },
    ];
  }
  return [
    { key: "label", header: groupBy === "status" ? "Status" : "Customer", format: "text" },
    { key: "orders", header: "Orders", format: "number" },
    { key: "orderedQty", header: "Ordered", format: "number" },
    { key: "pendingQty", header: "Pending", format: "number" },
  ];
}

async function orderBookReport({ from, to, groupBy = "customer", compare = false, now = new Date() }) {
  const gb = GROUP_BYS.includes(groupBy) ? groupBy : "customer";

  const [summary, rows, series] = await Promise.all([
    _summary(from, to, now),
    _rows(from, to, gb),
    _series(from, to),
  ]);

  const out = {
    range: { from, to },
    groupBy: gb,
    summary,
    columns: _columns(gb),
    rows,
    series,
    seriesKey: "quantity",
  };

  if (compare) {
    const prev = previousWindow({ from, to });
    const prevSummary = await _summary(prev.from, prev.to, now);
    out.comparison = {
      range: prev,
      summary: prevSummary,
      delta: {
        orders: summary.orders - prevSummary.orders,
        orderedQty: round(summary.orderedQty - prevSummary.orderedQty),
        orderedQtyPct: prevSummary.orderedQty > 0
          ? round(((summary.orderedQty - prevSummary.orderedQty) / prevSummary.orderedQty) * 100, 1)
          : null,
      },
    };
  }

  return out;
}

module.exports = { orderBookReport, GROUP_BYS };

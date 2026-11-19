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
//
//  A SUPPLY DATE IS A DAY, NOT A MOMENT
//
//  It is kept as the first moment of its day. Compared with a moment:
//    • a challan cut at nine on the promised date was ceil(0.15 of a
//      day) = 1 day late — every despatch that hit its date was a miss;
//    • an order due today was "past its date" from 05:30 that morning.
//  Both are compared by the day in India now: despatched on or before
//  the promised DAY is on time, and an order is overdue once its day
//  has passed — as /dc/otd-stats and the order status report have it.
//
//  PENDING is what is still to plan on orders that are still open. A
//  cancelled or completed order keeps its old figure on the record, but
//  none of it is open book.
//
//  …AND THAT IS NOT WHAT IS STILL TO DELIVER. `pendingQty` is the
//  orders' pendingElastic: what no job has been raised for. Shown as
//  "Pending", it read as the backlog — and a book planned onto jobs in
//  full, with nothing made, said "0 m pending". It keeps its key and is
//  now headed "Not yet planned"; `toDeliverQty` beside it is what the
//  customers are still owed: ordered less packed, line by line, on open
//  orders (services/deliveryRisk.js — the delivery-risk list's figure).
// ═════════════════════════════════════════════════════════════════

const Order = require("../../models/Order.js");
const DeliveryChallan = require("../../models/DeliveryChallan.js");
const { previousWindow } = require("./range.js");
const factoryDay = require("../../utils/factoryDay");
const { STILL_OWED_EXPR } = require("../deliveryRisk.js");

const GROUP_BYS = ["customer", "status", "supplyMonth"];
const OPEN_STATUSES = ["Open", "Approved", "InProgress"];

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

// Exclude soft-deleted orders from every figure.
const matchFor = (from, to) => ({ date: { $gte: from, $lt: to }, status: { $nin: ["Deleted"] } });

// What is still to plan on an order — nothing, once it is closed.
const PENDING_IF_OPEN = {
  $cond: [{ $in: ["$status", OPEN_STATUSES] }, { $sum: "$pendingElastic.quantity" }, 0],
};

// What the customer is still owed on an order — nothing, once it is closed.
const OWED_IF_OPEN = {
  $cond: [{ $in: ["$status", OPEN_STATUSES] }, STILL_OWED_EXPR, 0],
};

async function _summary(from, to, now) {
  // Today, as a calendar date: what a supply date is compared with.
  const today = factoryDay.calendarDay(now) || now;
  const [agg] = await Order.aggregate([
    { $match: matchFor(from, to) },
    { $group: {
        _id: null,
        orders: { $sum: 1 },
        orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } },
        pendingQty: { $sum: PENDING_IF_OPEN },
        toDeliverQty: { $sum: OWED_IF_OPEN },
        open: { $sum: { $cond: [{ $in: ["$status", OPEN_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] } },
        overdue: { $sum: { $cond: [
          { $and: [{ $in: ["$status", OPEN_STATUSES] }, { $lt: ["$supplyDate", today] }] }, 1, 0,
        ] } },
    } },
  ]);
  const r = agg || {};

  const otd = await _otd(from, to);

  return {
    orders: r.orders || 0,
    orderedQty: round(r.orderedQty || 0),
    pendingQty: round(r.pendingQty || 0),
    toDeliverQty: round(r.toDeliverQty || 0, 3),
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
    // By the day in India: a despatch on the promised date is on time,
    // whatever the hour (see the note at the top).
    const lateDays = factoryDay.daysBetween(due, dc.dispatchDate);
    if (lateDays == null) { considered -= 1; continue; }
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
      { $group: { _id: "$status", orders: { $sum: 1 }, orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } }, pendingQty: { $sum: PENDING_IF_OPEN }, toDeliverQty: { $sum: OWED_IF_OPEN } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", orders: 1, orderedQty: 1, pendingQty: 1, toDeliverQty: 1 } },
      { $sort: { orders: -1 } },
    ]);
    return rows.map((r) => ({ ...r, orderedQty: round(r.orderedQty), pendingQty: round(r.pendingQty), toDeliverQty: round(r.toDeliverQty, 3) }));
  }

  if (groupBy === "supplyMonth") {
    const rows = await Order.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$supplyDate", timezone: "Asia/Kolkata" } }, orders: { $sum: 1 }, pendingQty: { $sum: PENDING_IF_OPEN }, toDeliverQty: { $sum: OWED_IF_OPEN } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", orders: 1, pendingQty: 1, toDeliverQty: 1 } },
      { $sort: { label: 1 } },
    ]);
    return rows.map((r) => ({ ...r, pendingQty: round(r.pendingQty), toDeliverQty: round(r.toDeliverQty, 3) }));
  }

  // customer (default)
  const rows = await Order.aggregate([
    { $match: match },
    { $group: { _id: "$customer", orders: { $sum: 1 }, orderedQty: { $sum: { $sum: "$elasticOrdered.quantity" } }, pendingQty: { $sum: PENDING_IF_OPEN }, toDeliverQty: { $sum: OWED_IF_OPEN } } },
    { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "c" } },
    { $unwind: { path: "$c", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$c.name", "—"] }, orders: 1, orderedQty: 1, pendingQty: 1, toDeliverQty: 1 } },
    // Who is owed the most first (it was who had the most left to plan).
    { $sort: { toDeliverQty: -1, pendingQty: -1 } },
  ]);
  return rows.map((r) => ({ ...r, orderedQty: round(r.orderedQty), pendingQty: round(r.pendingQty), toDeliverQty: round(r.toDeliverQty, 3) }));
}

async function _series(from, to) {
  const rows = await Order.aggregate([
    { $match: matchFor(from, to) },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: "Asia/Kolkata" } }, quantity: { $sum: { $sum: "$elasticOrdered.quantity" } } } },
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
      { key: "toDeliverQty", header: "Still to deliver", format: "number" },
      { key: "pendingQty", header: "Not yet planned", format: "number" },
    ];
  }
  return [
    { key: "label", header: groupBy === "status" ? "Status" : "Customer", format: "text" },
    { key: "orders", header: "Orders", format: "number" },
    { key: "orderedQty", header: "Ordered", format: "number" },
    { key: "toDeliverQty", header: "Still to deliver", format: "number" },
    { key: "pendingQty", header: "Not yet planned", format: "number" },
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

"use strict";
// ═════════════════════════════════════════════════════════════════
//  Dispatch & customer-sales report.
//
//  Value-based commercial reporting off Delivery Challans — the only
//  place money is captured (orders carry no price). Counts REAL
//  dispatches (status dispatched|delivered; draft = not yet out,
//  cancelled = reversed), matched on dispatchDate over the window.
//
//  Summary + group-by (customer / elastic / day) + a daily value
//  series + period-over-period comparison. Columns carry a `format`
//  hint (text / number / currency) so one table renders every report.
// ═════════════════════════════════════════════════════════════════

const DeliveryChallan = require("../../models/DeliveryChallan.js");
const { previousWindow } = require("./range.js");

const GROUP_BYS = ["customer", "elastic", "day"];
const DISPATCHED = ["dispatched", "delivered"]; // real, non-cancelled movements

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

const matchFor = (from, to) => ({
  dispatchDate: { $gte: from, $lt: to },
  status: { $in: DISPATCHED },
});

async function _summary(from, to) {
  const agg = await DeliveryChallan.aggregate([
    { $match: matchFor(from, to) },
    { $group: {
        _id: null,
        dcs: { $sum: 1 },
        quantity: { $sum: "$totalQuantity" },
        amount: { $sum: "$totalAmount" },
        customers: { $addToSet: "$customer" },
    } },
  ]);
  const r = agg[0] || {};
  const quantity = round(r.quantity || 0);
  const amount = round(r.amount || 0);
  return {
    dcs: r.dcs || 0,
    quantity,
    amount,
    customers: (r.customers || []).filter(Boolean).length,
    avgRate: quantity > 0 ? round(amount / quantity, 2) : 0,
  };
}

function _finalizeRows(rows) {
  return rows.map((r) => ({
    ...r,
    quantity: round(r.quantity),
    amount: round(r.amount),
    avgRate: r.quantity > 0 ? round(r.amount / r.quantity, 2) : 0,
  }));
}

async function _rows(from, to, groupBy) {
  const match = matchFor(from, to);

  if (groupBy === "elastic") {
    const rows = await DeliveryChallan.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $group: {
          _id: "$items.elastic",
          label: { $first: "$items.elasticName" },
          quantity: { $sum: "$items.quantity" },
          amount: { $sum: "$items.amount" },
          _dcs: { $addToSet: "$_id" },
      } },
      { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$label", "—"] }, dcs: { $size: "$_dcs" }, quantity: 1, amount: 1 } },
      { $sort: { amount: -1 } },
    ]);
    return _finalizeRows(rows);
  }

  if (groupBy === "day") {
    const rows = await DeliveryChallan.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$dispatchDate" } }, dcs: { $sum: 1 }, quantity: { $sum: "$totalQuantity" }, amount: { $sum: "$totalAmount" } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", dcs: 1, quantity: 1, amount: 1 } },
      { $sort: { label: 1 } },
    ]);
    return _finalizeRows(rows);
  }

  // customer (default)
  const rows = await DeliveryChallan.aggregate([
    { $match: match },
    { $group: {
        _id: "$customer",
        label: { $first: "$customerName" },
        dcs: { $sum: 1 },
        quantity: { $sum: "$totalQuantity" },
        amount: { $sum: "$totalAmount" },
    } },
    { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$label", "—"] }, dcs: 1, quantity: 1, amount: 1 } },
    { $sort: { amount: -1 } },
  ]);
  return _finalizeRows(rows);
}

async function _series(from, to) {
  const rows = await DeliveryChallan.aggregate([
    { $match: matchFor(from, to) },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$dispatchDate" } }, amount: { $sum: "$totalAmount" } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", amount: 1 } },
  ]);
  return rows.map((r) => ({ date: r.date, amount: round(r.amount) }));
}

function _columns(groupBy) {
  const header = { customer: "Customer", elastic: "Elastic", day: "Date" }[groupBy];
  const cols = [{ key: "label", header, format: "text" }];
  cols.push({ key: "dcs", header: "DCs", format: "number" });
  cols.push({ key: "quantity", header: "Quantity", format: "number" });
  cols.push({ key: "amount", header: "Value", format: "currency" });
  return cols;
}

async function dispatchReport({ from, to, groupBy = "customer", compare = false }) {
  const gb = GROUP_BYS.includes(groupBy) ? groupBy : "customer";

  const [summary, rows, series] = await Promise.all([
    _summary(from, to),
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
    seriesKey: "amount",
  };

  if (compare) {
    const prev = previousWindow({ from, to });
    const prevSummary = await _summary(prev.from, prev.to);
    out.comparison = {
      range: prev,
      summary: prevSummary,
      delta: {
        amount: round(summary.amount - prevSummary.amount),
        quantity: round(summary.quantity - prevSummary.quantity),
        dcs: summary.dcs - prevSummary.dcs,
        amountPct: prevSummary.amount > 0
          ? round(((summary.amount - prevSummary.amount) / prevSummary.amount) * 100, 1)
          : null,
      },
    };
  }

  return out;
}

module.exports = { dispatchReport, GROUP_BYS };

"use strict";
// ═════════════════════════════════════════════════════════════════
//  Stock & purchases report.
//
//  Two concerns in one view:
//    • Stock valuation — a SNAPSHOT (as of now) of raw-material stock ×
//      current price, plus a low-stock count (stock ≤ minStock).
//    • Purchases — WINDOWED: PO value placed in the period (excluding
//      cancelled) and how much of it is still pending receipt.
//
//  Group-by material / category shows the stock snapshot (window-
//  independent); group-by supplier shows the PO register for the
//  window. Summary carries both sets of figures; the series and
//  comparison track purchase value.
// ═════════════════════════════════════════════════════════════════

const RawMaterial   = require("../../models/RawMaterial.js");
const PurchaseOrder = require("../../models/PurchaseOrder.js");
const { previousWindow } = require("./range.js");

const GROUP_BYS = ["material", "category", "supplier"];

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

// PO item pending value = price × max(0, quantity − received).
const PENDING_VALUE = {
  $sum: { $multiply: ["$items.price", { $max: [0, { $subtract: ["$items.quantity", { $ifNull: ["$items.receivedQuantity", 0] }] }] }] },
};
const ORDERED_VALUE = { $sum: { $multiply: ["$items.price", "$items.quantity"] } };

const poMatch = (from, to) => ({ date: { $gte: from, $lt: to }, status: { $ne: "Cancelled" } });

// Snapshot: current stock valuation + low-stock count. Not windowed.
async function _stockSnapshot() {
  const [agg] = await RawMaterial.aggregate([
    { $group: {
        _id: null,
        materials: { $sum: 1 },
        stockValue: { $sum: { $multiply: ["$stock", "$price"] } },
        lowStock: { $sum: { $cond: [{ $and: [{ $gt: ["$minStock", 0] }, { $lte: ["$stock", "$minStock"] }] }, 1, 0] } },
    } },
  ]);
  const r = agg || {};
  return {
    materials: r.materials || 0,
    stockValue: round(r.stockValue || 0),
    lowStock: r.lowStock || 0,
  };
}

// Windowed PO purchases.
async function _purchases(from, to) {
  const [agg] = await PurchaseOrder.aggregate([
    { $match: poMatch(from, to) },
    { $unwind: "$items" },
    { $group: { _id: null, pos: { $addToSet: "$_id" }, orderedValue: ORDERED_VALUE, pendingValue: PENDING_VALUE } },
    { $project: { _id: 0, pos: { $size: "$pos" }, orderedValue: 1, pendingValue: 1 } },
  ]);
  const r = agg || {};
  return {
    pos: r.pos || 0,
    purchaseValue: round(r.orderedValue || 0),
    pendingValue: round(r.pendingValue || 0),
  };
}

async function _summary(from, to) {
  const [stock, purchases] = await Promise.all([_stockSnapshot(), _purchases(from, to)]);
  return { ...stock, ...purchases };
}

async function _rows(from, to, groupBy) {
  if (groupBy === "category") {
    const rows = await RawMaterial.aggregate([
      { $group: { _id: "$category", items: { $sum: 1 }, stock: { $sum: "$stock" }, value: { $sum: { $multiply: ["$stock", "$price"] } } } },
      { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$_id", "—"] }, items: 1, stock: 1, value: 1 } },
      { $sort: { value: -1 } },
    ]);
    return rows.map((r) => ({ ...r, stock: round(r.stock, 2), value: round(r.value) }));
  }

  if (groupBy === "supplier") {
    const rows = await PurchaseOrder.aggregate([
      { $match: poMatch(from, to) },
      { $unwind: "$items" },
      { $group: { _id: "$supplier", _pos: { $addToSet: "$_id" }, orderedValue: ORDERED_VALUE, pendingValue: PENDING_VALUE } },
      { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "s" } },
      { $unwind: { path: "$s", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$s.name", "—"] }, pos: { $size: "$_pos" }, orderedValue: 1, pendingValue: 1 } },
      { $sort: { orderedValue: -1 } },
    ]);
    return rows.map((r) => ({ ...r, orderedValue: round(r.orderedValue), pendingValue: round(r.pendingValue) }));
  }

  // material (default) — stock valuation snapshot.
  const rows = await RawMaterial.aggregate([
    { $project: { _id: 0, key: "$_id", label: "$name", stock: 1, price: 1, minStock: 1, value: { $multiply: ["$stock", "$price"] } } },
    { $sort: { value: -1 } },
  ]);
  return rows.map((r) => ({
    key: r.key, label: r.label,
    stock: round(r.stock, 2), price: round(r.price, 2), value: round(r.value),
    low: r.minStock > 0 && r.stock <= r.minStock,
  }));
}

async function _series(from, to) {
  const rows = await PurchaseOrder.aggregate([
    { $match: poMatch(from, to) },
    { $unwind: "$items" },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, value: ORDERED_VALUE } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", value: 1 } },
  ]);
  return rows.map((r) => ({ date: r.date, value: round(r.value) }));
}

function _columns(groupBy) {
  if (groupBy === "category") {
    return [
      { key: "label", header: "Category", format: "text" },
      { key: "items", header: "Items", format: "number" },
      { key: "stock", header: "Stock (kg)", format: "number" },
      { key: "value", header: "Value", format: "currency" },
    ];
  }
  if (groupBy === "supplier") {
    return [
      { key: "label", header: "Supplier", format: "text" },
      { key: "pos", header: "POs", format: "number" },
      { key: "orderedValue", header: "Ordered", format: "currency" },
      { key: "pendingValue", header: "Pending", format: "currency" },
    ];
  }
  return [
    { key: "label", header: "Material", format: "text" },
    { key: "stock", header: "Stock (kg)", format: "number" },
    { key: "price", header: "Rate", format: "currency" },
    { key: "value", header: "Value", format: "currency" },
  ];
}

async function stockPurchasesReport({ from, to, groupBy = "material", compare = false }) {
  const gb = GROUP_BYS.includes(groupBy) ? groupBy : "material";

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
    seriesKey: "value",
  };

  if (compare) {
    const prev = previousWindow({ from, to });
    const prevPurchases = await _purchases(prev.from, prev.to);
    out.comparison = {
      range: prev,
      summary: prevPurchases,
      delta: {
        purchaseValue: round(summary.purchaseValue - prevPurchases.purchaseValue),
        purchaseValuePct: prevPurchases.purchaseValue > 0
          ? round(((summary.purchaseValue - prevPurchases.purchaseValue) / prevPurchases.purchaseValue) * 100, 1)
          : null,
      },
    };
  }

  return out;
}

module.exports = { stockPurchasesReport, GROUP_BYS };

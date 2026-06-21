'use strict';
//
// Evening report — sent at 9 PM. Covers what happened TODAY (the
// morning digest covers yesterday). Three sections:
//   • Production today (closed shifts so far)
//   • Wastage today
//   • Deliveries today (dispatched DCs)
//
// buildEveningReportData() does the aggregation; formatEveningReport()
// is a pure function over that data (unit-tested without a DB).
// Mirrors the morning-digest pattern so the WhatsApp message
// glance-reads the same way.

const ShiftPlan       = require("../models/ShiftPlan.js");
const Wastage         = require("../models/Wastage.js");
const DeliveryChallan = require("../models/DeliveryChallan.js");

// ── Pure formatter ───────────────────────────────────────────────
function formatEveningReport(d) {
  const lines = [`🌙 *Evening report* — ${d.dateLabel}`, ""];

  // Production today
  lines.push("📦 *Production (today)*");
  if (d.production.shifts > 0) {
    lines.push(`  ${_num(d.production.meters)} m across ${d.production.shifts} shift(s)`);
  } else {
    lines.push("  No shifts closed yet today.");
  }

  // Wastage today
  lines.push("", "♻️ *Wastage (today)*");
  if (d.wastage.entries > 0) {
    lines.push(`  ${_num(d.wastage.meters)} m over ${d.wastage.entries} entr${d.wastage.entries === 1 ? "y" : "ies"}` +
      (d.wastage.penalty > 0 ? ` · penalty ₹${_num(d.wastage.penalty)}` : ""));
    if (d.wastage.topReason) lines.push(`  Top reason: ${d.wastage.topReason}`);
  } else {
    lines.push("  None recorded. 👍");
  }

  // Deliveries today
  lines.push("", "🚚 *Deliveries (today)*");
  if (d.deliveries.count > 0) {
    lines.push(`  ${d.deliveries.count} DC(s) · ${_num(d.deliveries.totalQuantity)} m · ₹${_num(d.deliveries.totalAmount)}`);
    for (const dc of d.deliveries.items.slice(0, 5)) {
      const orderTag = dc.orderNo ? ` · Order #${dc.orderNo}` : "";
      lines.push(`  ${dc.dcNumber}${orderTag} · ${dc.customerName}: ${_num(dc.totalQuantity)} m`);
    }
    if (d.deliveries.items.length > 5) {
      lines.push(`  +${d.deliveries.items.length - 5} more`);
    }
  } else {
    lines.push("  No dispatches today.");
  }

  return lines.join("\n");
}

// ── Aggregator ───────────────────────────────────────────────────
async function buildEveningReportData(now = new Date()) {
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const endToday   = new Date(now); endToday.setHours(23, 59, 59, 999);

  const [production, wastage, deliveries] = await Promise.all([
    _production(startToday, endToday),
    _wastage(startToday, endToday),
    _deliveries(startToday, endToday),
  ]);

  return {
    dateLabel: startToday.toLocaleDateString("en-IN",
      { day: "numeric", month: "short", year: "numeric" }),
    production, wastage, deliveries,
  };
}

async function _production(start, end) {
  const rows = await ShiftPlan.aggregate([
    { $match: { date: { $gte: start, $lte: end } } },
    { $group: { _id: null,
                meters: { $sum: "$totalProduction" },
                shifts: { $sum: 1 } } },
  ]);
  const r = rows[0] || {};
  return { meters: Math.round(r.meters || 0), shifts: r.shifts || 0 };
}

async function _wastage(start, end) {
  const rows = await Wastage.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: null,
                meters:  { $sum: "$quantity" },
                penalty: { $sum: "$penalty"  },
                entries: { $sum: 1 } } },
  ]);
  const r = rows[0] || {};
  let topReason = null;
  if ((r.entries || 0) > 0) {
    const byReason = await Wastage.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: "$reason", n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 1 },
    ]);
    topReason = byReason[0]?._id || null;
  }
  return {
    meters:  Math.round(r.meters  || 0),
    penalty: Math.round(r.penalty || 0),
    entries: r.entries || 0,
    topReason,
  };
}

async function _deliveries(start, end) {
  const dcs = await DeliveryChallan.find({
    dispatchDate: { $gte: start, $lte: end },
  })
    .select("dcNumber orderNo customerName totalQuantity totalAmount dispatchDate")
    .sort({ dispatchDate: 1 })
    .lean();

  const totalQuantity = dcs.reduce((s, d) => s + (Number(d.totalQuantity) || 0), 0);
  const totalAmount   = dcs.reduce((s, d) => s + (Number(d.totalAmount)   || 0), 0);

  return {
    count: dcs.length,
    totalQuantity: Math.round(totalQuantity),
    totalAmount:   Math.round(totalAmount),
    items: dcs.map((d) => ({
      dcNumber:      d.dcNumber,
      orderNo:       d.orderNo,
      customerName:  d.customerName,
      totalQuantity: Math.round(Number(d.totalQuantity) || 0),
    })),
  };
}

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : String(n);
}

module.exports = {
  buildEveningReportData,
  formatEveningReport,
};

"use strict";
// ═════════════════════════════════════════════════════════════════
//  Production report.
//
//  Meters of good (admin-verified, status:"closed") production over a
//  window, with a summary, a group-by breakdown (machine / shift /
//  elastic / operator / day), a daily series for the chart, and an
//  optional comparison against the preceding window of equal length.
//
//  ShiftDetail.productionMeters is the shift's canonical TOTAL meters,
//  so machine/shift/operator/day grouping sums it directly. Elastic
//  grouping fans each shift's meters equally across its head→elastic
//  snapshot so the elastic rows still reconcile to the grand total
//  (shifts with no elastic snapshot can't be attributed and are noted).
//
//  Wastage is matched on its own createdAt over the same window.
//  Everything here is read-only aggregation — no session, no writes.
// ═════════════════════════════════════════════════════════════════

const ShiftDetail = require("../../models/ShiftDetail.js");
const Wastage     = require("../../models/Wastage.js");
const { previousWindow } = require("./range.js");

const GROUP_BYS = ["machine", "shift", "operator", "elastic", "day"];

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

// ── Summary block for one [from, to) window ──────────────────────
async function _summary(from, to) {
  const [prodAgg, mdAgg, wasteAgg] = await Promise.all([
    ShiftDetail.aggregate([
      { $match: { status: "closed", date: { $gte: from, $lt: to } } },
      { $group: {
          _id: null,
          meters:   { $sum: "$productionMeters" },
          shifts:   { $sum: 1 },
          machines: { $addToSet: "$machine" },
      } },
    ]),
    // Distinct machine-days (utilisation denominator).
    ShiftDetail.aggregate([
      { $match: { status: "closed", date: { $gte: from, $lt: to } } },
      { $group: { _id: { m: "$machine", d: { $dateToString: { format: "%Y-%m-%d", date: "$date" } } } } },
      { $count: "machineDays" },
    ]),
    Wastage.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, meters: { $sum: "$quantity" }, penalty: { $sum: "$penalty" }, entries: { $sum: 1 } } },
    ]),
  ]);

  const p = prodAgg[0] || {};
  const meters = round(p.meters || 0);
  const shifts = p.shifts || 0;
  const wasteMeters = round(wasteAgg[0]?.meters || 0);

  return {
    meters,
    shifts,
    activeMachines: (p.machines || []).length,
    machineDays: mdAgg[0]?.machineDays || 0,
    avgPerShift: shifts > 0 ? round(meters / shifts, 1) : 0,
    wastageMeters: wasteMeters,
    // Wastage as a share of good output; 0 when nothing was produced.
    wastagePct: meters > 0 ? round((wasteMeters / meters) * 100, 2) : 0,
    wastagePenalty: round(wasteAgg[0]?.penalty || 0),
  };
}

// ── Group-by rows ────────────────────────────────────────────────
async function _rows(from, to, groupBy) {
  const match = { status: "closed", date: { $gte: from, $lt: to } };

  if (groupBy === "elastic") {
    const rows = await ShiftDetail.aggregate([
      { $match: match },
      { $addFields: { _hc: { $size: { $ifNull: ["$elastics", []] } } } },
      { $match: { _hc: { $gt: 0 } } },
      { $unwind: "$elastics" },
      { $group: {
          _id: "$elastics.elastic",
          meters: { $sum: { $divide: ["$productionMeters", "$_hc"] } },
          _shifts: { $addToSet: "$_id" },
      } },
      { $addFields: { shifts: { $size: "$_shifts" } } },
      { $lookup: { from: "elastics", localField: "_id", foreignField: "_id", as: "e" } },
      { $unwind: { path: "$e", preserveNullAndEmptyArrays: true } },
      { $project: {
          _id: 0,
          key: "$_id",
          label: { $ifNull: ["$e.name", "Unknown elastic"] },
          meters: 1, shifts: 1,
      } },
      { $sort: { meters: -1 } },
    ]);
    return rows.map((r) => ({ ...r, meters: round(r.meters), avgPerShift: r.shifts ? round(r.meters / r.shifts, 1) : 0 }));
  }

  const field = { machine: "$machine", shift: "$shift", operator: "$employee", day: null }[groupBy];

  // Day grouping keys on a formatted date string.
  const groupId = groupBy === "day"
    ? { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
    : field;

  const pipeline = [
    { $match: match },
    { $group: { _id: groupId, meters: { $sum: "$productionMeters" }, shifts: { $sum: 1 } } },
  ];

  if (groupBy === "machine") {
    pipeline.push(
      { $lookup: { from: "machines", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, key: "$_id", label: { $concat: ["Machine ", { $ifNull: ["$m.ID", "—"] }] }, meters: 1, shifts: 1 } },
      { $sort: { meters: -1 } },
    );
  } else if (groupBy === "operator") {
    pipeline.push(
      { $lookup: { from: "employees", localField: "_id", foreignField: "_id", as: "e" } },
      { $unwind: { path: "$e", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, key: "$_id", label: { $ifNull: ["$e.name", "Unassigned"] }, meters: 1, shifts: 1 } },
      { $sort: { meters: -1 } },
    );
  } else if (groupBy === "shift") {
    pipeline.push(
      { $project: { _id: 0, key: "$_id", label: "$_id", meters: 1, shifts: 1 } },
      { $sort: { label: 1 } },
    );
  } else {
    // day
    pipeline.push(
      { $project: { _id: 0, key: "$_id", label: "$_id", meters: 1, shifts: 1 } },
      { $sort: { label: 1 } },
    );
  }

  const rows = await ShiftDetail.aggregate(pipeline);
  return rows.map((r) => ({
    ...r,
    meters: round(r.meters),
    avgPerShift: r.shifts ? round(r.meters / r.shifts, 1) : 0,
  }));
}

// ── Daily series (chart) ─────────────────────────────────────────
async function _series(from, to) {
  const rows = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: from, $lt: to } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, meters: { $sum: "$productionMeters" } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", meters: 1 } },
  ]);
  return rows.map((r) => ({ date: r.date, meters: round(r.meters) }));
}

const GROUP_LABELS = {
  machine: "Machine", shift: "Shift", operator: "Operator",
  elastic: "Elastic", day: "Day",
};

/**
 * @param {{from:Date,to:Date,groupBy?:string,compare?:boolean}} opts
 */
async function productionReport({ from, to, groupBy = "machine", compare = false }) {
  const gb = GROUP_BYS.includes(groupBy) ? groupBy : "machine";

  const [summary, rows, series] = await Promise.all([
    _summary(from, to),
    _rows(from, to, gb),
    _series(from, to),
  ]);

  const out = {
    range: { from, to },
    groupBy: gb,
    summary,
    columns: [
      { key: "label", header: GROUP_LABELS[gb] },
      { key: "meters", header: "Meters" },
      { key: "shifts", header: "Shifts" },
      { key: "avgPerShift", header: "Avg/Shift" },
    ],
    rows,
    series,
  };

  if (compare) {
    const prev = previousWindow({ from, to });
    const prevSummary = await _summary(prev.from, prev.to);
    out.comparison = {
      range: prev,
      summary: prevSummary,
      delta: {
        meters: round(summary.meters - prevSummary.meters),
        shifts: summary.shifts - prevSummary.shifts,
        wastageMeters: round(summary.wastageMeters - prevSummary.wastageMeters),
        // % change in output, guarding a zero baseline.
        metersPct: prevSummary.meters > 0
          ? round(((summary.meters - prevSummary.meters) / prevSummary.meters) * 100, 1)
          : null,
      },
    };
  }

  return out;
}

module.exports = { productionReport, GROUP_BYS };

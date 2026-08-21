"use strict";
// ═════════════════════════════════════════════════════════════════
//  Stock movement ledger report.
//
//  A complete raw-material in/out ledger over the window, built from
//  the two authoritative logs: MaterialInward (receipts) and
//  MaterialOut (consumption / adjustments, excluding reversed rows).
//  Reports inward qty, outward qty and net movement, grouped by
//  material or day, with a daily net series and a period comparison.
//
//  Quantity-based (kg). The two collections are aggregated separately
//  and merged in JS so each group-by row reconciles to the totals.
// ═════════════════════════════════════════════════════════════════

const MaterialInward = require("../../models/MaterialInward.js");
const MaterialOut    = require("../../models/MaterialOut.cjs");
const RawMaterial    = require("../../models/RawMaterial.js");
const { previousWindow } = require("./range.js");

const GROUP_BYS = ["material", "day", "lot"];

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

const inMatch  = (from, to) => ({ inwardDate: { $gte: from, $lt: to } });
const outMatch = (from, to) => ({ outwardDate: { $gte: from, $lt: to }, reversed: { $ne: true } });

async function _totals(from, to) {
  const [inAgg, outAgg] = await Promise.all([
    MaterialInward.aggregate([
      { $match: inMatch(from, to) },
      { $group: { _id: null, qty: { $sum: "$quantity" }, n: { $sum: 1 } } },
    ]),
    MaterialOut.aggregate([
      { $match: outMatch(from, to) },
      { $group: { _id: null, qty: { $sum: "$quantity" }, n: { $sum: 1 } } },
    ]),
  ]);
  const inQty = round(inAgg[0]?.qty || 0);
  const outQty = round(outAgg[0]?.qty || 0);
  return {
    inQty,
    outQty,
    net: round(inQty - outQty),
    inCount: inAgg[0]?.n || 0,
    outCount: outAgg[0]?.n || 0,
  };
}

// Merge two [{ _id, qty }] aggregations keyed by _id into ledger rows.
function _merge(inRows, outRows) {
  const map = new Map();
  const bump = (key, field, qty) => {
    const k = key == null ? "null" : String(key);
    if (!map.has(k)) map.set(k, { key, inQty: 0, outQty: 0 });
    map.get(k)[field] += Number(qty) || 0;
  };
  for (const r of inRows) bump(r._id, "inQty", r.qty);
  for (const r of outRows) bump(r._id, "outQty", r.qty);
  return [...map.values()].map((r) => ({
    key: r.key,
    inQty: round(r.inQty),
    outQty: round(r.outQty),
    net: round(r.inQty - r.outQty),
  }));
}

async function _rows(from, to, groupBy) {
  if (groupBy === "day") {
    const fmt = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field } });
    const [inRows, outRows] = await Promise.all([
      MaterialInward.aggregate([{ $match: inMatch(from, to) }, { $group: { _id: fmt("$inwardDate"), qty: { $sum: "$quantity" } } }]),
      MaterialOut.aggregate([{ $match: outMatch(from, to) }, { $group: { _id: fmt("$outwardDate"), qty: { $sum: "$quantity" } } }]),
    ]);
    return _merge(inRows, outRows)
      .map((r) => ({ ...r, label: r.key }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  if (groupBy === "lot") {
    // ── Grouped by dye lot ──────────────────────────────────────────
    // Only what the documents THEMSELVES recorded. A receipt keyed with
    // a lot number and an adjustment that named one both carry it; an
    // order approval never did, because it is a debit against the
    // pooled balance and nobody chose a bag.
    //
    // Those unattributed rows are reported together under one heading
    // rather than dropped or spread across the lots. The material page
    // infers a lot for them (services/lotAttribution.js), and that is
    // right for reading one material's history — but a REPORT that
    // silently folded inferences into its totals would be presenting a
    // reading as a measurement, and a total is exactly where that does
    // the most damage.
    const lotKey = { $ifNull: ["$lotNo", ""] };
    const [inRows, outRows] = await Promise.all([
      MaterialInward.aggregate([{ $match: inMatch(from, to) }, { $group: { _id: lotKey, qty: { $sum: "$quantity" } } }]),
      MaterialOut.aggregate([{ $match: outMatch(from, to) }, { $group: { _id: lotKey, qty: { $sum: "$quantity" } } }]),
    ]);
    return _merge(inRows, outRows)
      .map((r) => ({
        ...r,
        label: String(r.key || "").trim() || "No lot recorded",
        unattributed: !String(r.key || "").trim(),
      }))
      // Unattributed last, then busiest first. It is usually the
      // largest row and putting it at the top would bury the lots.
      .sort((a, b) =>
        Number(a.unattributed) - Number(b.unattributed) ||
        (b.inQty + b.outQty) - (a.inQty + a.outQty));
  }

  // material (default)
  const [inRows, outRows] = await Promise.all([
    MaterialInward.aggregate([{ $match: inMatch(from, to) }, { $group: { _id: "$rawMaterial", qty: { $sum: "$quantity" } } }]),
    MaterialOut.aggregate([{ $match: outMatch(from, to) }, { $group: { _id: "$rawMaterial", qty: { $sum: "$quantity" } } }]),
  ]);
  const merged = _merge(inRows, outRows);

  // Resolve material names in one round-trip.
  const ids = merged.map((r) => r.key).filter(Boolean);
  const mats = ids.length
    ? await RawMaterial.find({ _id: { $in: ids } }).select("name").lean()
    : [];
  const nameById = Object.fromEntries(mats.map((m) => [String(m._id), m.name]));

  return merged
    .map((r) => ({ ...r, label: nameById[String(r.key)] || "—" }))
    .sort((a, b) => (b.inQty + b.outQty) - (a.inQty + a.outQty));
}

async function _series(from, to) {
  const rows = await _rows(from, to, "day");
  return rows.map((r) => ({ date: r.label, net: r.net }));
}

function _columns(groupBy) {
  const header = groupBy === "day" ? "Date" : groupBy === "lot" ? "Dye lot" : "Material";
  return [
    { key: "label", header, format: "text" },
    { key: "inQty", header: "In (kg)", format: "number" },
    { key: "outQty", header: "Out (kg)", format: "number" },
    { key: "net", header: "Net", format: "number" },
  ];
}

async function stockMovementsReport({ from, to, groupBy = "material", compare = false }) {
  const gb = GROUP_BYS.includes(groupBy) ? groupBy : "material";

  const [summary, rows, series] = await Promise.all([
    _totals(from, to),
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
    seriesKey: "net",
  };

  if (compare) {
    const prev = previousWindow({ from, to });
    const prevTotals = await _totals(prev.from, prev.to);
    out.comparison = {
      range: prev,
      summary: prevTotals,
      delta: {
        inQty: round(summary.inQty - prevTotals.inQty),
        outQty: round(summary.outQty - prevTotals.outQty),
        net: round(summary.net - prevTotals.net),
      },
    };
  }

  return out;
}

module.exports = { stockMovementsReport, GROUP_BYS };

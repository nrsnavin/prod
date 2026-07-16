'use strict';
//
// Morning digest — one consolidated "state of the factory" WhatsApp
// message sent ~9 AM. Folds the owner's daily wants into a single
// glanceable message instead of four separate pings:
//   • yesterday's production total
//   • yesterday's wastage summary
//   • raw-material projected stockouts
//   • machines maintenance-due / overdue
//
// buildDigestData() does the DB aggregation; formatDigest() is a
// pure function over that data (unit-tested without a DB). Mirrors
// the existing /projected-stockout and /maintenance-due route logic
// so the numbers match what the admin app shows.

const ShiftPlan       = require("../models/ShiftPlan.js");
const ShiftDetail     = require("../models/ShiftDetail.js");
const Wastage         = require("../models/Wastage.js");
const RawMaterial     = require("../models/RawMaterial.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const Machine         = require("../models/Machine.js");
const MachineIssue    = require("../models/MachineIssue.js");
const Order           = require("../models/Order.js");
const DeliveryChallan = require("../models/DeliveryChallan.js");
const Attendance      = require("../models/Attendence.js");
const LeaveRequest    = require("../models/LeaveRequest.js");
const EmployeeFeedback= require("../models/EmployeeFeedback.js");

// ── Pure formatter ───────────────────────────────────────────────
function formatDigest(d) {
  const lines = [`☀️ *Morning digest* — ${d.dateLabel}`, ""];

  // Production
  lines.push("📦 *Production (yesterday)*");
  if (d.production.shifts > 0) {
    lines.push(`  ${_num(d.production.meters)} m across ${d.production.shifts} shift(s)`);
  } else {
    lines.push("  No closed shifts.");
  }

  // Wastage
  lines.push("", "♻️ *Wastage (yesterday)*");
  if (d.wastage.entries > 0) {
    lines.push(`  ${_num(d.wastage.meters)} m over ${d.wastage.entries} entr${d.wastage.entries === 1 ? "y" : "ies"}` +
      (d.wastage.penalty > 0 ? ` · penalty ₹${_num(d.wastage.penalty)}` : ""));
    if (d.wastage.topReason) lines.push(`  Top reason: ${d.wastage.topReason}`);
  } else {
    lines.push("  None recorded. 👍");
  }

  // Stockouts
  lines.push("", "⚠️ *Projected stockouts*");
  if (d.stockouts.length > 0) {
    for (const s of d.stockouts.slice(0, 5)) {
      lines.push(`  ${s.name}: ~${s.daysToStockout}d left (stock ${_num(s.stock)})`);
    }
    if (d.stockouts.length > 5) lines.push(`  +${d.stockouts.length - 5} more`);
  } else {
    lines.push("  None within horizon. 👍");
  }

  // Order activity (low-priority edits)
  if (d.orderActivity && d.orderActivity.edited > 0) {
    lines.push("", `✏️ *Orders edited yesterday*: ${d.orderActivity.edited}`);
  }

  // Commercial glance — dispatch value, order backlog, low stock.
  if (d.commercial) {
    const c = d.commercial;
    lines.push("", "🧾 *Commercial*");
    lines.push(`  Dispatched: ₹${_num(c.dispatchValue)} · ${c.dispatchDcs} DC(s)`);
    lines.push(`  Order book: ${c.openOrders} open · ${_num(c.pendingMeters)} m pending` +
      (c.overdueOrders > 0 ? ` · ${c.overdueOrders} overdue` : ""));
    if (c.lowStock > 0) lines.push(`  ⚠️ ${c.lowStock} material(s) at/below reorder`);
  }

  // Predicted late (ML)
  lines.push("", "⏰ *Predicted late* (ML)");
  if ((d.predictedLate || []).length > 0) {
    for (const o of d.predictedLate.slice(0, 5)) {
      lines.push(`  Order #${o.orderNo}${o.customerName ? ` · ${o.customerName}` : ""}: ${o.lateWorkingDays}d late`);
    }
    if (d.predictedLate.length > 5) lines.push(`  +${d.predictedLate.length - 5} more`);
  } else {
    lines.push("  All in-flight orders on track. 👍");
  }

  // Posterior drift (ML-detected machine/elastic slowdown)
  if ((d.posteriorDrift || []).length > 0) {
    lines.push("", "📊 *Posterior drift* (7d vs prior 7d)");
    for (const drift of d.posteriorDrift.slice(0, 5)) {
      const label = `${drift.machineLabel || "?"} · ${drift.elasticName || "?"}`;
      lines.push(`  ${label}: ↓${Math.round(drift.dropPct)}%`);
    }
    if (d.posteriorDrift.length > 5) lines.push(`  +${d.posteriorDrift.length - 5} more`);
  }

  // Attendance (yesterday vs 7d baseline)
  if (d.attendance) {
    lines.push("", "👷 *Attendance (yesterday)*");
    const a = d.attendance;
    if (a.totalEffective > 0) {
      const pctLabel = a.percentOfBaseline != null
        ? ` (${Math.round(a.percentOfBaseline)}% of 7d baseline)`
        : "";
      lines.push(`  ${a.totalEffective} effective present${pctLabel}`);
      if (a.absent > 0) lines.push(`  ${a.absent} absent · ${a.onLeave} on leave`);
    } else {
      lines.push("  No attendance marked.");
    }
  }

  // Leave requests pending decision
  if (d.leave && d.leave.pending > 0) {
    lines.push("", `🗓️ *Leave requests pending*: ${d.leave.pending}`);
  }

  // Open employee complaints
  if (d.complaints) {
    if (d.complaints.openCount > 0) {
      lines.push("", `📣 *Open complaints*: ${d.complaints.openCount}` +
        (d.complaints.newYesterday > 0 ? ` (${d.complaints.newYesterday} new yesterday)` : ""));
    }
  }

  // Maintenance
  lines.push("", "🔧 *Maintenance due*");
  if (d.maintenance.length > 0) {
    for (const m of d.maintenance.slice(0, 5)) {
      lines.push(`  ${m.ID}: ${m.overdue ? "OVERDUE" : `in ${m.daysUntil}d`}`);
    }
    if (d.maintenance.length > 5) lines.push(`  +${d.maintenance.length - 5} more`);
  } else {
    lines.push("  Nothing due. 👍");
  }

  // Repeat-offender machines (frequent breakdowns)
  if ((d.repeatOffenders || []).length > 0) {
    lines.push("", `🚨 *Frequent breakdowns* (${d.issueThresh ?? 3}+ in ${d.issueWindow ?? 30}d)`);
    for (const r of d.repeatOffenders.slice(0, 5)) {
      lines.push(`  ${r.ID || "?"}: ${r.count} issues${r.openCount > 0 ? ` · ${r.openCount} open` : ""}`);
    }
    if (d.repeatOffenders.length > 5) lines.push(`  +${d.repeatOffenders.length - 5} more`);
  }

  return lines.join("\n");
}

// ── Aggregator ───────────────────────────────────────────────────
async function buildDigestData(now = new Date(), opts = {}) {
  const horizonDays  = opts.stockoutHorizonDays  || 7;
  const lookbackDays = opts.stockoutLookbackDays || 30;
  const maintDays    = opts.maintenanceDays       || 14;
  const issueWindow  = opts.issueWindowDays       || 30;
  const issueThresh  = opts.issueThreshold        || 3;

  // "Yesterday" window — local midnight to midnight. Kept simple
  // (server tz); the digest is a glance, not an accounting report.
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const startYday  = new Date(startToday.getTime() - 86_400_000);

  const [production, wastage, stockouts, maintenance, predictedLate, orderActivity, posteriorDrift,
         attendance, leave, complaints, repeatOffenders, commercial] =
    await Promise.all([
      _production(startYday, startToday),
      _wastage(startYday, startToday),
      _stockouts(now, lookbackDays, horizonDays),
      _maintenance(now, maintDays),
      _predictedLate(now),
      _orderActivity(startYday, startToday),
      _posteriorDrift(now),
      _attendance(startYday, startToday),
      _leavePending(),
      _complaints(startYday, startToday),
      _repeatOffenders(now, issueWindow, issueThresh),
      _commercial(startYday, startToday, now),
    ]);

  return {
    dateLabel: startYday.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    production, wastage, stockouts, maintenance, predictedLate, orderActivity, posteriorDrift,
    attendance, leave, complaints, repeatOffenders, commercial,
    issueWindow, issueThresh,
  };
}

// Yesterday's attendance summary across both shifts + 7d baseline.
async function _attendance(start, end) {
  try {
    const rows = await Attendance.find({
      date: { $gte: start, $lt: end },
    }).select("status").lean();
    let present = 0, late = 0, halfDay = 0, absent = 0, onLeave = 0;
    for (const r of rows) {
      if (r.status === "present")       present += 1;
      else if (r.status === "late")     late    += 1;
      else if (r.status === "half_day") halfDay += 1;
      else if (r.status === "absent")   absent  += 1;
      else if (r.status === "on_leave") onLeave += 1;
    }
    const totalEffective = present + late + halfDay * 0.5;

    // 7d trailing baseline (exclude yesterday). Average per distinct
    // date so a thin day doesn't pull the baseline down.
    const histStart = new Date(start.getTime() - 7 * 86_400_000);
    const histRows  = await Attendance.find({
      date: { $gte: histStart, $lt: start },
    }).select("status date").lean();
    let percentOfBaseline = null;
    if (histRows.length > 0) {
      const byDay = new Map();
      for (const r of histRows) {
        const k = new Date(r.date).toISOString().slice(0, 10);
        if (!byDay.has(k)) byDay.set(k, 0);
        const w = r.status === "present" || r.status === "late" ? 1
                : r.status === "half_day" ? 0.5 : 0;
        byDay.set(k, byDay.get(k) + w);
      }
      const days = [...byDay.values()];
      const baseline = days.reduce((a, b) => a + b, 0) / days.length;
      if (baseline > 0) percentOfBaseline = (totalEffective / baseline) * 100;
    }
    return { totalEffective, present, late, halfDay, absent, onLeave, percentOfBaseline };
  } catch (err) {
    console.warn(`[digest._attendance] ${err.message}`);
    return { totalEffective: 0, present: 0, late: 0, halfDay: 0,
             absent: 0, onLeave: 0, percentOfBaseline: null };
  }
}

async function _leavePending() {
  try {
    const pending = await LeaveRequest.countDocuments({ status: "pending" });
    return { pending };
  } catch (err) {
    console.warn(`[digest._leavePending] ${err.message}`);
    return { pending: 0 };
  }
}

async function _complaints(start, end) {
  try {
    const [openCount, newYesterday] = await Promise.all([
      EmployeeFeedback.countDocuments({
        type: "complaint",
        status: { $in: ["open", "in_review"] },
      }),
      EmployeeFeedback.countDocuments({
        type: "complaint",
        createdAt: { $gte: start, $lt: end },
      }),
    ]);
    return { openCount, newYesterday };
  } catch (err) {
    console.warn(`[digest._complaints] ${err.message}`);
    return { openCount: 0, newYesterday: 0 };
  }
}

// Posterior drift — flags (elastic, machine) pairs whose per-head
// production rate dropped > 25% comparing the last 7 days to the 7
// days before that. Indicates machine slowdown, operator change, or
// yarn quality drift. Skips pairs that had no shifts in the recent
// window (machine was off — not a slowdown).
async function _posteriorDrift(now) {
  const recentStart = new Date(now.getTime() - 7  * 86_400_000);
  const olderStart  = new Date(now.getTime() - 14 * 86_400_000);

  const rows = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: olderStart } } },
    { $unwind: "$elastics" },
    { $project: {
        machine:    1,
        elasticId: "$elastics.elastic",
        productionMeters: 1,
        bucket: {
          $cond: [{ $gte: ["$date", recentStart] }, "recent", "older"],
        },
      } },
    { $group: {
        _id: { machine: "$machine", elastic: "$elasticId", bucket: "$bucket" },
        total: { $sum: "$productionMeters" },
        n:     { $sum: 1 },
      } },
  ]);

  // Pivot: { pairKey: { recent: {total, n}, older: {total, n} } }
  const byPair = new Map();
  for (const r of rows) {
    const key = `${r._id.machine}|${r._id.elastic}`;
    if (!byPair.has(key)) byPair.set(key, { machine: r._id.machine, elastic: r._id.elastic, recent: null, older: null });
    byPair.get(key)[r._id.bucket] = { total: r.total, n: r.n };
  }

  const drifts = [];
  for (const p of byPair.values()) {
    if (!p.recent || !p.older) continue;
    if (p.recent.n < 2 || p.older.n < 2) continue; // not enough samples
    const recentAvg = p.recent.total / p.recent.n;
    const olderAvg  = p.older.total  / p.older.n;
    if (!(olderAvg > 0)) continue;
    const dropPct = (1 - recentAvg / olderAvg) * 100;
    if (dropPct < 25) continue;
    drifts.push({ machine: p.machine, elastic: p.elastic, dropPct, recentAvg, olderAvg });
  }
  // Hydrate names — cheap because the list is small.
  if (drifts.length > 0) {
    const Machine = require("../models/Machine.js");
    const Elastic = require("../models/Elastic.js");
    const machineIds = [...new Set(drifts.map((d) => d.machine.toString()))];
    const elasticIds = [...new Set(drifts.map((d) => d.elastic.toString()))];
    const [machines, elastics] = await Promise.all([
      Machine.find({ _id: { $in: machineIds } }).select("ID").lean(),
      Elastic.find({ _id: { $in: elasticIds } }).select("name").lean(),
    ]);
    const mById = Object.fromEntries(machines.map((m) => [m._id.toString(), m.ID]));
    const eById = Object.fromEntries(elastics.map((e) => [e._id.toString(), e.name]));
    for (const d of drifts) {
      d.machineLabel = mById[d.machine.toString()];
      d.elasticName  = eById[d.elastic.toString()];
    }
  }
  drifts.sort((a, b) => b.dropPct - a.dropPct);
  return drifts;
}

// Count yesterday's order edits (Open-state updates) so the digest
// surfaces routine, non-urgent edit volume the owner doesn't need
// real-time pings for. Reads fingerprint timestamps because the
// Order doc only stores the latest updatedItemsAt and we want a
// per-day count.
async function _orderActivity(start, end) {
  const Order = require("../models/Order.js");
  const rows = await Order.aggregate([
    { $match: { fingerprints: { $exists: true, $ne: [] } } },
    { $unwind: "$fingerprints" },
    { $match: {
        "fingerprints.code": "ORDER_UPDATED",
        "fingerprints.at":   { $gte: start, $lt: end },
      } },
    { $group: { _id: "$_id" } }, // dedupe per order in case of multiple edits
    { $count: "n" },
  ]);
  return { edited: rows[0]?.n || 0 };
}

// Predicted-late: walks every active order, runs the running-ETA
// helper, surfaces the ones the ML predicts will miss supplyDate.
// Reuses the same _computeRunningEtaForOrder + _loadPlantMetersPerMachineDay
// the route uses, so the numbers match the order detail card.
async function _predictedLate(now) {
  // ETA engine now lives in its own service — import it directly rather
  // than reaching through the order router. Kept as a local require so a
  // load-order hiccup here degrades to "skip section" instead of crashing
  // digest generation.
  const { _computeRunningEtaForOrder, _loadPlantMetersPerMachineDay } =
    require("../services/etaService.js") || {};
  if (!_computeRunningEtaForOrder) return []; // helpers not exposed → skip section

  const orders = await Order.find({
    status: { $in: ["Approved", "InProgress"] },
    supplyDate: { $exists: true, $ne: null },
  })
    .select("_id orderNo customer supplyDate elasticOrdered producedElastic status")
    .populate("customer", "name")
    .lean();
  if (orders.length === 0) return [];

  const plantRate = await _loadPlantMetersPerMachineDay(now);
  const out = [];
  for (const order of orders) {
    try {
      const r = await _computeRunningEtaForOrder(order, plantRate, now);
      if (!r?.ok || !r.risk?.late) continue;
      out.push({
        orderNo:         order.orderNo,
        customerName:    order.customer?.name,
        expectedDate:    r.expectedDate,
        supplyDate:      order.supplyDate,
        lateWorkingDays: r.risk.lateWorkingDays || 0,
      });
    } catch (_) { /* one bad order doesn't block the digest */ }
  }
  out.sort((a, b) => (b.lateWorkingDays || 0) - (a.lateWorkingDays || 0));
  return out;
}

// Commercial glance — yesterday's dispatch value (from the reports
// stack), the current open-order backlog (open / overdue / pending
// meters, as of now), and the live low-stock count. Mirrors the
// numbers the on-demand reports show so the morning digest and the
// Reports section agree.
async function _commercial(startYday, startToday, now) {
  const [dcAgg, orderAgg, lowAgg] = await Promise.all([
    DeliveryChallan.aggregate([
      { $match: { status: { $in: ["dispatched", "delivered"] }, dispatchDate: { $gte: startYday, $lt: startToday } } },
      { $group: { _id: null, dcs: { $sum: 1 }, amount: { $sum: "$totalAmount" } } },
    ]),
    Order.aggregate([
      { $match: { status: { $in: ["Open", "Approved", "InProgress"] } } },
      { $group: {
          _id: null,
          open: { $sum: 1 },
          overdue: { $sum: { $cond: [{ $lt: ["$supplyDate", now] }, 1, 0] } },
          pending: { $sum: { $sum: "$pendingElastic.quantity" } },
      } },
    ]),
    RawMaterial.aggregate([
      { $group: { _id: null, low: { $sum: { $cond: [{ $and: [{ $gt: ["$minStock", 0] }, { $lte: ["$stock", "$minStock"] }] }, 1, 0] } } } },
    ]),
  ]);
  return {
    dispatchDcs:   dcAgg[0]?.dcs || 0,
    dispatchValue: Math.round(dcAgg[0]?.amount || 0),
    openOrders:    orderAgg[0]?.open || 0,
    overdueOrders: orderAgg[0]?.overdue || 0,
    pendingMeters: Math.round(orderAgg[0]?.pending || 0),
    lowStock:      lowAgg[0]?.low || 0,
  };
}

async function _production(start, end) {
  const rows = await ShiftPlan.aggregate([
    { $match: { date: { $gte: start, $lt: end } } },
    { $group: { _id: null, meters: { $sum: "$totalProduction" }, shifts: { $sum: 1 } } },
  ]);
  const r = rows[0] || {};
  return { meters: Math.round(r.meters || 0), shifts: r.shifts || 0 };
}

async function _wastage(start, end) {
  const rows = await Wastage.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    { $group: {
        _id: null,
        meters:  { $sum: "$quantity" },
        penalty: { $sum: "$penalty" },
        entries: { $sum: 1 },
      } },
  ]);
  const r = rows[0] || {};
  // Most common reason yesterday (best-effort, small set).
  let topReason = null;
  if ((r.entries || 0) > 0) {
    const byReason = await Wastage.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: "$reason", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    topReason = byReason[0]?._id || null;
  }
  return {
    meters:  Math.round(r.meters || 0),
    penalty: Math.round(r.penalty || 0),
    entries: r.entries || 0,
    topReason,
  };
}

// Lean version of the /projected-stockout route logic.
async function _stockouts(now, lookbackDays, horizonDays) {
  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const mats = await RawMaterial.find({
    $expr: { $gt: ["$stock", "$minStock"] },
    stock: { $gt: 0 }, minStock: { $gt: 0 },
  }).select("name stock minStock").lean();
  if (mats.length === 0) return [];

  const totals = await MaterialOutward.aggregate([
    { $match: {
        rawMaterial: { $in: mats.map((m) => m._id) },
        outwardDate: { $gte: since },
        reversed:    { $ne: true },
      } },
    { $group: { _id: "$rawMaterial", total: { $sum: "$quantity" } } },
  ]);
  const consumedById = new Map(totals.map((t) => [String(t._id), t.total]));

  const out = [];
  for (const m of mats) {
    const consumed = consumedById.get(String(m._id)) || 0;
    if (consumed <= 0) continue;
    const dailyRate = consumed / lookbackDays;
    const daysToStockout = m.stock / dailyRate;
    if (daysToStockout >= horizonDays) continue;
    out.push({
      name: m.name, stock: m.stock,
      daysToStockout: parseFloat(daysToStockout.toFixed(1)),
    });
  }
  out.sort((a, b) => a.daysToStockout - b.daysToStockout);
  return out;
}

// Lean version of the /maintenance-due route logic.
async function _maintenance(now, days) {
  const horizon = new Date(now.getTime() + days * 86_400_000);
  const machines = await Machine.find().select("ID serviceLogs").lean();
  const due = [];
  for (const m of machines) {
    const dated = (m.serviceLogs || [])
      .filter((l) => l.nextServiceDate)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    if (dated.length === 0) continue;
    const next = new Date(dated[0].nextServiceDate);
    if (Number.isNaN(next.getTime()) || next > horizon) continue;
    due.push({
      ID: m.ID,
      overdue: next < now,
      daysUntil: Math.ceil((next - now) / 86_400_000),
    });
  }
  due.sort((a, b) => a.daysUntil - b.daysUntil);
  return due;
}

// Machines reporting issues frequently in the window — same repeat-
// offender signal as GET /machine-issue/anomalies.
async function _repeatOffenders(now, days, threshold) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await MachineIssue.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: {
        _id: "$machine",
        count:     { $sum: 1 },
        openCount: { $sum: { $cond: [{ $in: ["$status", ["open", "acknowledged", "in_progress"]] }, 1, 0] } },
    } },
    { $match: { count: { $gte: threshold } } },
    { $sort: { count: -1 } },
    { $lookup: { from: "machines", localField: "_id", foreignField: "_id", as: "m" } },
    { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, ID: "$m.ID", count: 1, openCount: 1 } },
  ]);
  return rows;
}

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : String(n);
}

module.exports = {
  buildDigestData,
  formatDigest,
};

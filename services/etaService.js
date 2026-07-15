"use strict";
// ═════════════════════════════════════════════════════════════════
//  ETA engine — the running/entry-time completion forecast.
//
//  Extracted verbatim from api/order.js (Phase 4 god-file split) so
//  the HTTP layer stays thin and the forecast math has one home. Both
//  the order routes and the daily digest (utils/digest.js) consume
//  these; nothing here touches req/res, so it can be unit-tested and
//  reused without spinning up Express.
//
//  Numbers are deterministic and rule-based; the Bayesian posterior,
//  plant blend, and cold-start fallback are the same three tiers the
//  order detail card renders.
// ═════════════════════════════════════════════════════════════════

const Job         = require("../models/JobOrder.js");
const Machine     = require("../models/Machine.js");
const ShiftDetail = require("../models/ShiftDetail.js");
const { memoizeAsync } = require("../utils/memo.js");
const { estimateOrderEta } = require("../utils/orderEta.js");
const { estimateRunningOrderEta } = require("../utils/runningOrderEta.js");
const { getPairRate, toMetersPerMachineDay } = require("../utils/etaPosterior.js");
const C = require("../utils/etaConfig.js");

// ═════════════════════════════════════════════════════════════════
//  Shared helper — compute running ETA for a single order.
//
//  Resolves active jobs, builds the rate input from the per-pair
//  Bayesian posterior (with plant + cold-start fallbacks), and
//  feeds the structured input into the pure math estimator.
//
//  Callers pass a hydrated `plantMetersPerMachineDay` so a bulk
//  request can amortise the one expensive plant aggregation across
//  many orders.
// ═════════════════════════════════════════════════════════════════
async function _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines = 1) {
  const activeJobs = await Job.find({
    order: order._id,
    status: { $nin: ["completed", "cancelled"] },
  })
    .populate({ path: "machine", select: "ID NoOfHead elastics status" })
    .lean();

  // No JobOrder yet — common for orders that were just approved but
  // haven't been planned, and for legacy orders that pre-date the ML
  // ETA layer. Fall back to an entry-time-style estimate so the UI
  // can still show a forward date instead of an empty card. The order
  // will run across the free machines, so pass that count through.
  if (activeJobs.length === 0) {
    return _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now, freeMachines);
  }

  const jobs = [];
  const rateSources = { posterior: 0, plant: 0, coldstart: 0, missing: 0 };

  for (const job of activeJobs) {
    const machine = job.machine;
    if (!machine?._id) continue;

    const noOfHead = Number(machine.NoOfHead) || 1;

    const headsByElastic = {};
    for (const h of machine.elastics || []) {
      const id = h.elastic?.toString();
      if (!id) continue;
      headsByElastic[id] = (headsByElastic[id] || 0) + 1;
    }

    const producedMap = {};
    for (const p of job.producedElastic || []) {
      if (!p?.elastic) continue;
      producedMap[p.elastic.toString()] = Number(p.quantity) || 0;
    }

    const elasticRows = [];
    for (const e of job.elastics || []) {
      // Defensive — legacy job orders occasionally have a null
      // elastic ref (data older than the schema gate). Skip rather
      // than throwing "cannot read 'toString' of null".
      if (!e?.elastic) continue;
      const elasticId = e.elastic.toString();
      const planned   = Number(e.quantity) || 0;
      const produced  = producedMap[elasticId] || 0;
      const remaining = Math.max(0, planned - produced);

      let metersPerHeadPerShift = null;
      let rateSource = "missing";
      const post = await getPairRate(elasticId, machine._id);
      if (post && post.informative) {
        metersPerHeadPerShift = post.metersPerHeadPerShift;
        rateSource = "posterior";
      } else if (plantMetersPerMachineDay && plantMetersPerMachineDay > 0) {
        metersPerHeadPerShift =
          plantMetersPerMachineDay / Math.max(1, noOfHead) / Math.max(1, C.SHIFTS_PER_DAY);
        rateSource = "plant";
      } else {
        metersPerHeadPerShift =
          C.COLDSTART_METERS_PER_HEAD_DAY * C.LOOM_EFFICIENCY / Math.max(1, C.SHIFTS_PER_DAY);
        rateSource = "coldstart";
      }
      rateSources[rateSource] += 1;

      // Machine.elastics may not include this job's elastic in its
      // head map (existing/legacy orders where the head-elastic
      // mapping wasn't kept in sync). Falling back to 1 head keeps
      // the estimate conservative but visible.
      const headsAssigned = headsByElastic[elasticId] || 1;

      elasticRows.push({
        elastic:         elasticId,
        plannedMeters:   planned,
        producedMeters:  produced,
        remainingMeters: remaining,
        headsAssigned,
        metersPerHeadPerShift,
        metersPerMachineDay: Math.round(
          toMetersPerMachineDay(metersPerHeadPerShift, noOfHead, C.SHIFTS_PER_DAY)
        ),
        rateSource,
        posteriorObservations: post?.observations || 0,
      });
    }

    jobs.push({
      job:          job._id,
      jobOrderNo:   job.jobOrderNo,
      status:       job.status,
      machineId:    machine._id,
      machineLabel: machine.ID || null,
      noOfHead,
      elastics:     elasticRows,
    });
  }

  const result = estimateRunningOrderEta({
    jobs,
    today:      now,
    supplyDate: order.supplyDate,
  });

  return { ...result, rateSources };
}

// ─────────────────────────────────────────────────────────────────
// Entry-time fallback — for orders that don't have an active job
// yet (just approved, or legacy). Reuses the entry-time estimator
// (utils/orderEta.js) on the order's *remaining* quantities so the
// shape matches the running-ETA contract the UI already renders.
// ─────────────────────────────────────────────────────────────────
function _fallbackEntryTimeEta(order, plantMetersPerMachineDay, now, freeMachines = 1) {
  const producedMap = {};
  for (const p of order.producedElastic || []) {
    if (!p?.elastic) continue;
    producedMap[p.elastic.toString()] = Number(p.quantity) || 0;
  }
  const lines = (order.elasticOrdered || [])
    .filter((e) => e?.elastic)
    .map((e) => {
      const id = e.elastic.toString();
      const planned   = Number(e.quantity) || 0;
      const produced  = producedMap[id] || 0;
      return { elastic: id, quantity: Math.max(0, planned - produced) };
    })
    .filter((l) => l.quantity > 0);

  if (lines.length === 0) {
    return { ok: false, reason: "NOTHING_REMAINING" };
  }

  const aggregates = {
    plantRate:          plantMetersPerMachineDay,
    elasticRate:        {},
    consistencyScore:   70,
    attendanceMomentum: 1,
    machineHealth:      1,
    // Real-world: an approved order will be run across the machines that
    // are free, not a single loom. estimateOrderEta caps this by how many
    // machines the job can actually keep busy, so an over-count is safe.
    freeMachines:       Math.max(1, Number(freeMachines) || 1),
    machineNoOfHeadAvg: 4,
  };

  const result = estimateOrderEta({
    lines,
    today:      now,
    supplyDate: order.supplyDate,
    aggregates,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason || "NO_RATE" };
  }

  // Reshape to match the running-eta contract — same fields the UI
  // already knows how to render. perJob is empty (no jobs yet); the
  // assumptions list explains the fallback in plain language.
  const rateSource = result.usedColdStart ? "coldstart" : "plant";
  return {
    ok:           true,
    expectedDate: result.expectedDate,
    workingDays:  result.workingDays,
    weavingDays:  result.weavingDays || (result.workingDays - (result.leadDays || 0)),
    leadDays:     result.leadDays || 0,
    perJob:       [],
    risk:         result.risk,
    assumptions:  [
      "Production hasn't started on this order yet — estimate uses the plant-wide rate.",
      ...(result.assumptions || []),
    ],
    rateSources:  {
      posterior: 0,
      plant:     rateSource === "plant" ? 1 : 0,
      coldstart: rateSource === "coldstart" ? 1 : 0,
      missing:   0,
    },
    usedEntryTimeFallback: true,
  };
}

// ═════════════════════════════════════════════════════════════════
// Shared helper — plant rate aggregation. One round-trip, used by
// every running-ETA caller. Memoized (60s): this 30-day scan runs on
// every ETA-bearing request and only moves when a shift is verified —
// caching keeps the read side off the transactional path. TTL 0 under
// jest so tests stay isolated.
// ═════════════════════════════════════════════════════════════════
const _loadPlantMetersPerMachineDay = memoizeAsync(async function (now) {
  const since = new Date(now.getTime() - C.RATE_LOOKBACK_DAYS * 86_400_000);
  const plantShiftAgg = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: since } } },
    { $group: {
        _id: { machine: "$machine", date: {
          $dateToString: { format: "%Y-%m-%d", date: "$date" } } },
        meters: { $sum: "$productionMeters" },
      } },
    { $group: {
        _id: null,
        totalMeters: { $sum: "$meters" },
        machineDays: { $sum: 1 },
      } },
  ]);
  const plantRow = plantShiftAgg[0] || {};
  return (plantRow.machineDays || 0) > 0
    ? plantRow.totalMeters / plantRow.machineDays
    : null;
}, process.env.NODE_ENV === "test" ? 0 : 60_000);

// Count the machines currently free to take on an order. Used to size
// the parallelism for approved-but-unplanned orders so their ETA
// reflects running across several looms, not a single machine. Loaded
// once per request and threaded into the per-order estimator.
async function _loadFreeMachineCount() {
  const n = await Machine.countDocuments({ status: "free" });
  return Math.max(1, n);
}

module.exports = {
  _computeRunningEtaForOrder,
  _fallbackEntryTimeEta,
  _loadPlantMetersPerMachineDay,
  _loadFreeMachineCount,
};

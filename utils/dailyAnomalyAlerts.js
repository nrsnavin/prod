'use strict';
//
// Per-day anomaly stream — fired from the digest cron so they show
// up at the start of the working day, but as separate WhatsApp pings
// (not one giant digest) so the owner can act on each one in
// isolation.
//
// Each helper reuses the digest's existing aggregators where it can
// so the numbers match what the digest text shows.
//
// notify() throttles per-event, so a chronic condition only repeats
// on the cadence the settings allow.

const Wastage         = require("../models/Wastage.js");
const RawMaterial     = require("../models/RawMaterial.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const EtaRatePosterior = require("../models/EtaRatePosterior.js");
const { notify }      = require("./notify.js");
const { buildDigestData } = require("./digest.js");

const PROJECTED_HORIZON_DAYS = 3;        // ≤3 days = pre-critical
const WASTAGE_SPIKE_MULT     = 2.0;      // 2× the 30d baseline = anomaly
const WASTAGE_MIN_BASELINE   = 50;       // ignore quiet weeks (m/day)
const POSTERIOR_STALE_DAYS   = 3;        // no shift cascade in 3d → stale
const POSTERIOR_MIN_PAIRS    = 5;        // skip on tiny plant

// ── projectedStockoutAlert ────────────────────────────────────────
// Fire when ≥1 material projects out within 3 working days. The
// digest already shows the 7d list as a section — this is the
// urgent slice fired as a separate ping per material so the owner
// can act on each one without parsing the digest text.
async function checkProjectedStockouts(now = new Date()) {
  try {
    // The digest aggregator already produces `stockouts[]` with the
    // 7-day projection; we filter to ≤3 days.
    const data = await buildDigestData(now);
    const urgent = (data.stockouts || []).filter(
      (s) => Number(s.daysToStockout) <= PROJECTED_HORIZON_DAYS,
    );
    if (urgent.length === 0) return;

    await notify("projectedStockoutAlert", {
      items: urgent.map((s) => ({
        name:           s.name,
        stock:          s.stock,
        daysToStockout: s.daysToStockout,
      })),
      // Entity key = the comma-joined material names so the
      // throttle pins to the set in alarm, not to a single SKU.
      _entity: { type: "ProjectedStockout", id: urgent.map((s) => s.name).sort().join(",") },
    });
  } catch (err) {
    console.warn(`[dailyAnomalyAlerts] projectedStockouts: ${err.message}`);
  }
}

// ── posteriorDriftDetected ────────────────────────────────────────
// Reuse the digest's posterior-drift computation; fire one ping per
// drifted pair. Throttled per (machine,elastic).
async function checkPosteriorDrifts(now = new Date()) {
  try {
    const data = await buildDigestData(now);
    const drifts = data.posteriorDrift || [];
    for (const d of drifts) {
      await notify("posteriorDriftDetected", {
        machineLabel: d.machineLabel,
        elasticName:  d.elasticName,
        dropPct:      d.dropPct,
        recentAvg:    Math.round(d.recentAvg),
        olderAvg:     Math.round(d.olderAvg),
        _entity: { type: "PosteriorDrift",
                   id: `${d.machine}|${d.elastic}` },
      });
    }
  } catch (err) {
    console.warn(`[dailyAnomalyAlerts] posteriorDrifts: ${err.message}`);
  }
}

// ── wastageAnomalyDay ─────────────────────────────────────────────
// Compares yesterday's wastage meters against the trailing 30d
// daily average. Fires when yesterday ≥ 2× baseline AND the
// baseline itself is above a noise floor.
async function checkWastageAnomalyDay(now = new Date()) {
  try {
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const startYday  = new Date(startToday.getTime() - 86_400_000);
    const startHist  = new Date(startToday.getTime() - 30 * 86_400_000);

    const [ydayRows, histRows] = await Promise.all([
      Wastage.aggregate([
        { $match: { createdAt: { $gte: startYday, $lt: startToday } } },
        { $group: { _id: null, meters: { $sum: "$quantity" },
                    entries: { $sum: 1 } } },
      ]),
      Wastage.aggregate([
        { $match: { createdAt: { $gte: startHist, $lt: startYday } } },
        { $group: {
            _id: {
              $dateToString: { date: "$createdAt", format: "%Y-%m-%d" },
            },
            meters: { $sum: "$quantity" },
        } },
      ]),
    ]);
    const yday = ydayRows[0]?.meters || 0;
    if (yday <= 0) return;
    if (histRows.length === 0) return;
    const baseline = histRows.reduce((a, b) => a + b.meters, 0) / histRows.length;
    if (baseline < WASTAGE_MIN_BASELINE) return;
    const multiplier = yday / baseline;
    if (multiplier < WASTAGE_SPIKE_MULT) return;

    const topReasonRows = await Wastage.aggregate([
      { $match: { createdAt: { $gte: startYday, $lt: startToday } } },
      { $group: { _id: "$reason", n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 1 },
    ]);
    const dateLabel = startYday.toLocaleDateString("en-IN",
      { day: "2-digit", month: "short", year: "numeric" });

    await notify("wastageAnomalyDay", {
      dateLabel,
      metersYesterday: Math.round(yday),
      baseline:        Math.round(baseline),
      multiplier,
      topReason:       topReasonRows[0]?._id || null,
      _entity: { type: "WastageDay", id: startYday.toISOString().slice(0, 10) },
    });
  } catch (err) {
    console.warn(`[dailyAnomalyAlerts] wastageAnomalyDay: ${err.message}`);
  }
}

// ── mlPosteriorStale ──────────────────────────────────────────────
// If a meaningful share of the ETA rate posteriors haven't been
// updated in POSTERIOR_STALE_DAYS, something is broken in the
// production-shift verify cascade — ETA predictions will drift
// silently. Quiet on tiny plants (few pairs total).
async function checkMlPosteriorStale(now = new Date()) {
  try {
    const cutoff = new Date(now.getTime() - POSTERIOR_STALE_DAYS * 86_400_000);
    const total = await EtaRatePosterior.countDocuments({});
    if (total < POSTERIOR_MIN_PAIRS) return;
    const stale = await EtaRatePosterior.countDocuments({
      $or: [
        { lastUpdatedAt: { $lt: cutoff } },
        { lastUpdatedAt: { $exists: false } },
      ],
    });
    // <50% stale = some pairs are just inactive, not broken
    if (stale / total < 0.5) return;

    await notify("mlPosteriorStale", {
      staleDays:   POSTERIOR_STALE_DAYS,
      activePairs: total,
      stalePairs:  stale,
      _entity: { type: "MlHealth", id: "posterior" },
    });
  } catch (err) {
    console.warn(`[dailyAnomalyAlerts] mlPosteriorStale: ${err.message}`);
  }
}

async function runDailyAnomalyAlerts(now = new Date()) {
  await checkProjectedStockouts(now);
  await checkPosteriorDrifts(now);
  await checkWastageAnomalyDay(now);
  await checkMlPosteriorStale(now);
}

module.exports = {
  checkProjectedStockouts,
  checkPosteriorDrifts,
  checkWastageAnomalyDay,
  checkMlPosteriorStale,
  runDailyAnomalyAlerts,
  PROJECTED_HORIZON_DAYS,
  WASTAGE_SPIKE_MULT,
  WASTAGE_MIN_BASELINE,
  POSTERIOR_STALE_DAYS,
  POSTERIOR_MIN_PAIRS,
};

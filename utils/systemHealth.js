'use strict';
//
// Notification self-health checks. The digest cron runs these at the
// end of its run; surfaced from there because cron is the one thing
// guaranteed to fire daily even when no user activity is happening.
// Each helper queries the Notification audit log and only pings the
// owner when something is actually wrong. notify() handles per-event
// throttling so a chronic condition doesn't spam.

const Notification = require("../models/Notification.js");
const { notify }   = require("./notify.js");

const DELIVERY_WINDOW_HOURS  = 24;
const DELIVERY_ERROR_FLOOR   = 3;        // tolerate <3 transient errors
const DELIVERY_ERROR_RATIO   = 0.20;     // 20%+ error rate → fire
const DIGEST_SKIP_HOURS      = 25;       // 25h window catches a missed daily run
const DRY_RUN_WINDOW_HOURS   = 24;
const DRY_RUN_FLOOR          = 5;        // <5 dry-runs in 24h is noise, not a config gap

async function _windowSince(hours) {
  return new Date(Date.now() - hours * 3600_000);
}

// Fire when notification deliveries are systematically failing.
// Looks back DELIVERY_WINDOW_HOURS and checks the error ratio.
async function checkNotificationDeliveryFailed() {
  try {
    const since = await _windowSince(DELIVERY_WINDOW_HOURS);
    const rows = await Notification.aggregate([
      { $match: { createdAt: { $gte: since },
                   status:    { $in: ["sent", "error"] } } },
      { $group: { _id: "$status", n: { $sum: 1 },
                  reasons: { $push: "$reason" } } },
    ]);
    if (!rows.length) return;
    const counts = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    const errorRows = rows.find((r) => r._id === "error");
    const errors = counts.error || 0;
    const total  = (counts.sent || 0) + errors;
    if (errors < DELIVERY_ERROR_FLOOR) return;
    if (errors / total < DELIVERY_ERROR_RATIO) return;

    const topReason = _modeReason(errorRows?.reasons || []);
    await notify("notificationDeliveryFailed", {
      windowLabel:   `last ${DELIVERY_WINDOW_HOURS}h`,
      errorCount:    errors,
      totalAttempts: total,
      topReason,
      _entity: { type: "NotificationHealth", id: "delivery" },
    });
  } catch (err) {
    console.warn(`[systemHealth] deliveryFailed check: ${err.message}`);
  }
}

// Fire when no morningDigest "sent" or "dry_run" row exists in the
// last DIGEST_SKIP_HOURS. Note: this is fired from the digest cron
// itself — so if the cron ISN'T running, this won't fire either.
// That's a known limitation; admins also have the explainer route.
// The case we DO catch: cron ran (so this code executes) but
// previous runs are missing → cron was wedged for a while and
// recently un-wedged.
async function checkCronDigestSkipped() {
  try {
    const since = await _windowSince(DIGEST_SKIP_HOURS);
    const last = await Notification.findOne({
      event:  "morningDigest",
      status: { $in: ["sent", "dry_run"] },
      createdAt: { $lt: since },
    }).sort({ createdAt: -1 }).select("createdAt").lean();

    const recent = await Notification.findOne({
      event:  "morningDigest",
      status: { $in: ["sent", "dry_run"] },
      createdAt: { $gte: since },
    }).select("_id").lean();

    if (recent) return;       // a recent digest exists → cron is healthy
    if (!last) return;        // no digest ever → fresh install, not a skipped cron
    const lastSentLabel = new Date(last.createdAt).toLocaleString("en-IN");
    await notify("cronDigestSkipped", {
      lastSentLabel,
      _entity: { type: "NotificationHealth", id: "cron" },
    });
  } catch (err) {
    console.warn(`[systemHealth] cronDigest check: ${err.message}`);
  }
}

// Fire when WhatsApp is still in dry-run mode after grace period.
// dry_run rows happen when sendWhatsApp() short-circuits because
// Twilio creds are unset — useful in dev, a config gap in prod.
async function checkDryRunStillActive() {
  try {
    const since = await _windowSince(DRY_RUN_WINDOW_HOURS);
    const dryRunCount = await Notification.countDocuments({
      createdAt: { $gte: since },
      status:    "dry_run",
    });
    if (dryRunCount < DRY_RUN_FLOOR) return;
    await notify("notifyDryRunStillActive", {
      windowLabel: `last ${DRY_RUN_WINDOW_HOURS}h`,
      dryRunCount,
      _entity: { type: "NotificationHealth", id: "dryRun" },
    });
  } catch (err) {
    console.warn(`[systemHealth] dryRun check: ${err.message}`);
  }
}

// Run all three in sequence. Called from the digest cron.
async function runSystemHealthChecks() {
  await checkCronDigestSkipped();
  await checkNotificationDeliveryFailed();
  await checkDryRunStillActive();
}

function _modeReason(reasons) {
  const counts = new Map();
  for (const r of reasons) {
    if (!r) continue;
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  let top = null, n = 0;
  for (const [k, v] of counts) if (v > n) { top = k; n = v; }
  return top;
}

module.exports = {
  checkNotificationDeliveryFailed,
  checkCronDigestSkipped,
  checkDryRunStillActive,
  runSystemHealthChecks,
  DELIVERY_ERROR_FLOOR,
  DELIVERY_ERROR_RATIO,
  DIGEST_SKIP_HOURS,
  DRY_RUN_FLOOR,
};

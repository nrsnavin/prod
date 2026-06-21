// models/NotificationSettings.js
//
// Singleton-style config for owner WhatsApp notifications.
//
// Per-event configuration is stored as Mixed because the orchestrator
// supports two shapes for backward compatibility:
//
//   1. Legacy:  events.orderCreated = true       (Boolean toggle)
//   2. Current: events.orderCreated = {
//        enabled:         true,
//        recipients:      ["+91..."],    // empty = use global recipients
//        tier:            "realtime",    // realtime | hourly | daily
//        throttleSeconds: 30,             // 0 = no throttle
//      }
//
// The orchestrator calls normalizeEventConfig() at use-time so both
// shapes work without a migration. Admin app PUT can write either.
const mongoose = require("mongoose");

// Anchor metadata for each event we know about. tier defaults are
// the orchestrator's hint about how urgent the event is; the per-
// event config can override.
const EVENT_DEFAULTS = {
  orderCreated:           { tier: "realtime" },
  orderApproved:          { tier: "realtime" },
  orderCancelled:         { tier: "realtime" },
  orderForceApproved:     { tier: "realtime" },
  orderCompleted:         { tier: "realtime" },
  orderProductionStarted: { tier: "realtime" },
  orderPredictedLate:     { tier: "daily"    },
  morningDigest:          { tier: "daily"    },
  machineBreakdown:       { tier: "realtime" },
  shiftBelowThreshold:    { tier: "realtime" },
  wastageHighEvent:       { tier: "realtime" },
  anomalyDetected:        { tier: "realtime" },
};

function normalizeEventConfig(value, eventName) {
  const tierDefault = EVENT_DEFAULTS[eventName]?.tier || "realtime";
  if (typeof value === "boolean") {
    return {
      enabled:         value,
      recipients:      [],
      tier:            tierDefault,
      throttleSeconds: 0,
    };
  }
  if (value && typeof value === "object") {
    return {
      enabled:         value.enabled !== false,
      recipients:      Array.isArray(value.recipients) ? value.recipients.filter(Boolean) : [],
      tier:            value.tier || tierDefault,
      throttleSeconds: Number(value.throttleSeconds) || 0,
    };
  }
  return {
    enabled:         true,
    recipients:      [],
    tier:            tierDefault,
    throttleSeconds: 0,
  };
}

const NotificationSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: "owner", unique: true },

    // Global recipients fallback. Per-event recipients (when set)
    // override this list — but if an event's recipients is empty,
    // we fall through to this global list.
    recipients: { type: [String], default: [] },

    enabled: { type: Boolean, default: true },

    // Per-event config. Mixed so we accept both Boolean (legacy) and
    // Object (current) values without a migration. normalizeEventConfig
    // unifies the shapes at read time.
    events: {
      orderCreated:           { type: mongoose.Schema.Types.Mixed, default: true },
      orderApproved:          { type: mongoose.Schema.Types.Mixed, default: true },
      orderCancelled:         { type: mongoose.Schema.Types.Mixed, default: true },
      orderForceApproved:     { type: mongoose.Schema.Types.Mixed, default: true },
      orderCompleted:         { type: mongoose.Schema.Types.Mixed, default: true },
      orderProductionStarted: { type: mongoose.Schema.Types.Mixed, default: true },
      orderPredictedLate:     { type: mongoose.Schema.Types.Mixed, default: true },
      morningDigest:          { type: mongoose.Schema.Types.Mixed, default: true },
      machineBreakdown:       { type: mongoose.Schema.Types.Mixed, default: true },
      shiftBelowThreshold:    { type: mongoose.Schema.Types.Mixed, default: true },
      wastageHighEvent:       { type: mongoose.Schema.Types.Mixed, default: true },
      // anomalyDetected defaults to a 1h throttle per (event, entity.id).
      // entity.id is the machine, so the orchestrator coalesces multiple
      // anomaly signals on the same machine into one ping per hour.
      anomalyDetected: {
        type: mongoose.Schema.Types.Mixed,
        default: { enabled: true, recipients: [], tier: "realtime", throttleSeconds: 3600 },
      },
    },

    // Quiet hours — wall-clock window in `timezone`. Non-realtime
    // events are deferred when `isInQuietHours(now)` is true. Real-
    // time events ignore the window because their urgency is the
    // whole point.
    quietHours: {
      start: { type: Number, default: null }, // 0-23
      end:   { type: Number, default: null }, // 0-23
    },
    timezone: { type: String, default: "Asia/Kolkata" },
  },
  { timestamps: true }
);

NotificationSettingsSchema.statics.load = async function () {
  let doc = await this.findOne({ singleton: "owner" });
  if (!doc) doc = await this.create({ singleton: "owner" });
  return doc;
};

// Returns the normalized config for one event — never throws,
// always returns a fully-shaped object.
NotificationSettingsSchema.methods.getEventConfig = function (eventName) {
  return normalizeEventConfig(this.events?.[eventName], eventName);
};

// True iff the wall-clock hour in this settings' timezone falls
// inside [start, end). Handles wrap-around windows (e.g. 22-7).
NotificationSettingsSchema.methods.isInQuietHours = function (now = new Date()) {
  const { start, end } = this.quietHours || {};
  if (start == null || end == null) return false;
  // Hour in the configured timezone. Intl is the only stdlib API
  // that gives us a tz-aware hour without a dep.
  const hour = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: this.timezone || "Asia/Kolkata",
      hour: "2-digit", hour12: false,
    }).format(now),
    10
  );
  if (Number.isNaN(hour)) return false;
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Wrap-around: e.g. 22-7 means 22, 23, 0, 1, ..., 6.
  return hour >= start || hour < end;
};

// Expose for tests + the GET /settings normalizer.
NotificationSettingsSchema.statics.normalizeEventConfig = normalizeEventConfig;
NotificationSettingsSchema.statics.EVENT_DEFAULTS         = EVENT_DEFAULTS;

module.exports = mongoose.model("NotificationSettings", NotificationSettingsSchema);

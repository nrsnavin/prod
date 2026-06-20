// models/NotificationSettings.js
//
// Singleton-style config for owner WhatsApp notifications. There is
// only ever one of these documents — use NotificationSettings.load()
// to fetch-or-create it.
//
// Secrets (Twilio SID / auth token) are NEVER stored here — those
// live in env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_WHATSAPP_FROM). This doc only holds the toggles and
// recipient numbers an admin can change at runtime without a deploy.
const mongoose = require("mongoose");

const NotificationSettingsSchema = new mongoose.Schema(
  {
    // Marker so load() always finds the same doc.
    singleton: { type: String, default: "owner", unique: true },

    // E.164 numbers (e.g. "+919876543210"). Owner-only for v1 but a
    // list so we can add managers later without a schema change.
    recipients: { type: [String], default: [] },

    // Master kill-switch. When false, notify() short-circuits.
    enabled: { type: Boolean, default: true },

    // Per-event toggles. Default everything on; an admin can mute
    // any channel from the settings screen.
    events: {
      orderCreated:       { type: Boolean, default: true },
      orderApproved:      { type: Boolean, default: true },
      orderForceApproved: { type: Boolean, default: true },
      orderPredictedLate: { type: Boolean, default: true },
      morningDigest:   { type: Boolean, default: true },
      dailyProduction: { type: Boolean, default: true },
      dailyWastage:    { type: Boolean, default: true },
      stockout:        { type: Boolean, default: true },
      maintenanceDue:  { type: Boolean, default: true },
    },

    // Quiet hours — local-time window during which non-urgent
    // notifications are suppressed (digest still queues for the
    // morning send). Stored as 0–23 hours; null disables.
    quietHours: {
      start: { type: Number, default: null }, // e.g. 22
      end:   { type: Number, default: null }, // e.g. 7
    },

    // IANA tz for interpreting quiet hours + digest schedule.
    timezone: { type: String, default: "Asia/Kolkata" },
  },
  { timestamps: true }
);

// Fetch-or-create the single settings doc.
NotificationSettingsSchema.statics.load = async function () {
  let doc = await this.findOne({ singleton: "owner" });
  if (!doc) doc = await this.create({ singleton: "owner" });
  return doc;
};

module.exports = mongoose.model("NotificationSettings", NotificationSettingsSchema);

// models/Notification.js
//
// Audit log of every outbound notification attempt. Written by
// utils/notify.js for every event the orchestrator processes —
// regardless of whether the send succeeded, was skipped (muted /
// no recipients), ran in dry-run mode (provider not configured),
// or hit a provider error.
//
// This gives the admin app a queryable surface to:
//   - count messages by event type per day / month (cost tracking)
//   - find failed deliveries to a specific recipient
//   - reconstruct "who told the system to do what" months later
//   - debug why an expected notification didn't arrive
const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    // What event triggered this (orderCreated, orderApproved, …).
    event: { type: String, required: true, index: true },

    // Recipient address. E.164 for WhatsApp.
    recipient: { type: String, required: true, index: true },

    // Channel used. Just "whatsapp" for now, but kept open for
    // future channels (sms, email, push) without a schema migration.
    channel: { type: String, default: "whatsapp", index: true },

    // Outcome of the send attempt.
    //   sent     - provider accepted the message
    //   dry_run  - provider not configured; message logged but not sent
    //   skipped  - orchestrator chose not to send (muted / no recipient /
    //              event filter)
    //   error    - provider rejected the message
    status: {
      type: String,
      required: true,
      enum: ["sent", "dry_run", "skipped", "error"],
      index: true,
    },

    // Human reason when status != "sent". e.g. "event muted",
    // "no recipients", or the provider error message.
    reason: { type: String },

    // Provider message id when status == "sent". e.g. Twilio SID.
    providerId: { type: String, index: true },

    // The verbatim message body that was attempted, so audits can
    // replay what the recipient actually saw (or would have seen).
    // Optional because "skipped" rows are written before the body
    // is formatted (e.g. when there are no recipients to send to).
    body: { type: String, default: "" },

    // Reference to the entity the notification was about (when
    // there is one). Lets the order detail screen render its own
    // recent-notifications timeline.
    entity: {
      type:    { type: String },                // "Order" | "Job" | …
      id:      { type: mongoose.Types.ObjectId, refPath: "entity.type" },
    },

    // Snapshot of the actor that triggered the notification, when
    // known. Mostly populated by the calling route (e.g. /approve
    // passes the JWT user).
    actor: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Compound index for the common dashboard query: "show me the
// latest N notifications for this event over the last K days".
NotificationSchema.index({ event: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);

const mongoose = require("mongoose");

// Transactional outbox for external side-effects (WhatsApp alerts,
// notifications). The event is written INSIDE the business transaction
// (utils/outbox.enqueue), so "the commit happened but the alert was
// never sent" and "the alert went out for a rolled-back commit" both
// become impossible. A small in-process dispatcher delivers pending
// events with exponential backoff and marks them sent/failed.
const OutboxSchema = new mongoose.Schema(
  {
    // Handler key — utils/outboxHandlers.js maps this to a function.
    kind:    { type: String, required: true },
    payload: { type: Object, default: {} },

    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed"],
      default: "pending",
    },
    attempts:      { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError:     { type: String, default: "" },
    sentAt:        { type: Date },
  },
  { timestamps: true }
);

// The dispatcher's claim query: due pending events, oldest first.
OutboxSchema.index({ status: 1, nextAttemptAt: 1 });
// Housekeeping: delivered events expire after 30 days.
OutboxSchema.index(
  { sentAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30, partialFilterExpression: { status: "sent" } }
);

module.exports = mongoose.model("Outbox", OutboxSchema);

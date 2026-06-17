'use strict';
//
// Notification orchestration. One entry point — notify(eventType,
// payload) — that:
//   1. loads the NotificationSettings doc
//   2. checks the master switch + the per-event toggle
//   3. formats a WhatsApp message for the event
//   4. fans it out to every configured recipient via sendWhatsApp
//
// notify() NEVER throws. Callers fire-and-forget it from inside
// business operations (order create, shift verify, …) wrapped so a
// notification failure can't roll back the operation.
//
// Message formatters are pure functions (no I/O) so they're unit-
// testable without a provider or a DB — see tests/utils/notify.test.js.

const NotificationSettings = require("../models/NotificationSettings.js");
const { sendWhatsApp }     = require("./whatsapp.js");

// ── Pure formatters ──────────────────────────────────────────────
// Each returns a plain-text WhatsApp body. Keep them short — owner
// alerts are glanceable, not reports.

const fmt = {
  orderCreated(p) {
    const lines = [
      "🧾 *New order created*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.po ? `PO: ${p.po}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.totalMeters ? `Qty: ${_num(p.totalMeters)} m` : null,
      p.lineCount ? `Items: ${p.lineCount}` : null,
      p.supplyDate ? `Supply by: ${_date(p.supplyDate)}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  },

  orderForceApproved(p) {
    return [
      "⚠️ *Order force-approved* (guardrail override)",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.by ? `By: ${p.by}` : null,
      p.reason ? `Reason: ${p.reason}` : null,
    ].filter(Boolean).join("\n");
  },

  orderPredictedLate(p) {
    return [
      "⏰ *Order predicted late*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.expectedDate ? `Predicted: ${_date(p.expectedDate)}` : null,
      p.supplyDate ? `Promised: ${_date(p.supplyDate)}` : null,
      p.lateWorkingDays ? `Late by: ${p.lateWorkingDays} working day(s)` : null,
    ].filter(Boolean).join("\n");
  },

  // The digest text is built by utils/digest.js and passed through
  // pre-formatted; this formatter is just the pass-through so the
  // orchestrator's toggle/recipient logic still applies.
  morningDigest(p) {
    return p?.body || null;
  },

  test(p) {
    return p?.body || "✅ Test message from your factory notifications. If you can read this, WhatsApp alerts are working.";
  },
};

function formatMessage(eventType, payload) {
  const f = fmt[eventType];
  return f ? f(payload || {}) : null;
}

// Map eventType → the settings.events flag that gates it.
const EVENT_FLAG = {
  orderCreated:       "orderCreated",
  orderForceApproved: "orderForceApproved",
  orderPredictedLate: "orderPredictedLate",
  morningDigest:      "morningDigest",
  // `test` is always allowed (used to verify wiring) — no flag.
};

// ── Orchestrator ─────────────────────────────────────────────────
async function notify(eventType, payload = {}) {
  try {
    const settings = await NotificationSettings.load();
    if (!settings.enabled) return { skipped: "disabled" };

    const flag = EVENT_FLAG[eventType];
    if (flag && settings.events?.[flag] === false) {
      return { skipped: `event ${eventType} muted` };
    }

    const recipients = (settings.recipients || []).filter(Boolean);
    if (recipients.length === 0) return { skipped: "no recipients" };

    const body = formatMessage(eventType, payload);
    if (!body) return { skipped: `no formatter for ${eventType}` };

    const results = [];
    for (const to of recipients) {
      results.push(await sendWhatsApp(to, body));
    }
    return { sent: results.filter((r) => r.sent).length, results };
  } catch (err) {
    console.warn(`[notify] ${eventType} failed: ${err?.message}`);
    return { error: err?.message };
  }
}

// ── helpers ──────────────────────────────────────────────────────
function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : String(n);
}
function _date(d) {
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch (_) {
    return String(d);
  }
}

module.exports = {
  notify,
  formatMessage, // exported for unit tests
  fmt,
};

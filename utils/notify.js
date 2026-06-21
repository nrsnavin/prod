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
const Notification         = require("../models/Notification.js");
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

  orderApproved(p) {
    return [
      "✅ *Order approved*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.totalMeters ? `Qty: ${_num(p.totalMeters)} m` : null,
      p.by ? `By: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
      p.supplyDate ? `Supply by: ${_date(p.supplyDate)}` : null,
    ].filter(Boolean).join("\n");
  },

  orderCancelled(p) {
    return [
      "❌ *Order cancelled*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.previousStatus ? `Previous status: ${p.previousStatus}` : null,
      p.releasedReservations ? `Reservations released: ${p.releasedReservations}` : null,
      p.refundedMaterials ? `Materials refunded: ${p.refundedMaterials}` : null,
      p.reason ? `Reason: ${p.reason}` : null,
      p.by ? `By: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
    ].filter(Boolean).join("\n");
  },

  orderForceApproved(p) {
    return [
      "⚠️ *Order force-approved* (guardrail override)",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.by ? `By: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
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
  orderApproved:      "orderApproved",
  orderCancelled:     "orderCancelled",
  orderForceApproved: "orderForceApproved",
  orderPredictedLate: "orderPredictedLate",
  morningDigest:      "morningDigest",
  // `test` is always allowed (used to verify wiring) — no flag.
};

// ── Orchestrator ─────────────────────────────────────────────────
//
// Every outcome (sent / dry_run / skipped / error) gets recorded in
// the Notification audit log so the admin app and ops queries have
// a queryable trail. `payload` may carry an `entity` field
// ({ type, id }) and an `actor` field — these are stamped on the
// log row when present so we can later answer "show me every
// notification this order produced" without joining backwards from
// fingerprints.
async function notify(eventType, payload = {}) {
  // Pull the audit-only fields out so they don't show up in the
  // message body. They still ride along into the Notification rows.
  const auditEntity = payload?._entity || null;
  const auditActor  = payload?._actor  || null;

  try {
    const settings = await NotificationSettings.load();
    if (!settings.enabled) {
      await _audit({
        event: eventType, status: "skipped", reason: "notifications disabled",
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: "disabled" };
    }

    const flag = EVENT_FLAG[eventType];
    if (flag && settings.events?.[flag] === false) {
      await _audit({
        event: eventType, status: "skipped", reason: `event ${eventType} muted`,
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: `event ${eventType} muted` };
    }

    const recipients = (settings.recipients || []).filter(Boolean);
    if (recipients.length === 0) {
      await _audit({
        event: eventType, status: "skipped", reason: "no recipients",
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: "no recipients" };
    }

    const body = formatMessage(eventType, payload);
    if (!body) {
      await _audit({
        event: eventType, status: "skipped", reason: `no formatter for ${eventType}`,
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: `no formatter for ${eventType}` };
    }

    const results = [];
    for (const to of recipients) {
      const r = await sendWhatsApp(to, body);
      results.push(r);
      // One audit row per recipient per attempt — keeps the cost
      // metering accurate when recipients > 1.
      const status = r.sent
        ? "sent"
        : r.dryRun
          ? "dry_run"
          : "error";
      await _audit({
        event:      eventType,
        recipient:  to,
        body,
        status,
        reason:     r.error || (r.dryRun ? "provider not configured" : undefined),
        providerId: r.providerId,
        entity:     auditEntity,
        actor:      auditActor,
      });
    }
    return { sent: results.filter((r) => r.sent).length, results };
  } catch (err) {
    console.warn(`[notify] ${eventType} failed: ${err?.message}`);
    // Best-effort audit even on orchestrator crash.
    try {
      await _audit({
        event: eventType, status: "error", reason: err?.message || "unknown",
        entity: auditEntity, actor: auditActor, body: "(no body — error before format)",
      });
    } catch (_) { /* swallow — audit must not throw */ }
    return { error: err?.message };
  }
}

// Internal — never throws. Skips the recipient field on skipped/error
// rows where we haven't picked a recipient yet ("no recipients", or
// orchestrator-level errors before fan-out).
async function _audit({ event, recipient, body, status, reason, providerId, entity, actor }) {
  try {
    await Notification.create({
      event,
      recipient: recipient || "—",
      channel:   "whatsapp",
      status,
      reason,
      providerId,
      body:     body || "",
      entity:   entity || undefined,
      actor:    actor  || undefined,
    });
  } catch (err) {
    console.warn(`[notify:audit] failed to write Notification row: ${err?.message}`);
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

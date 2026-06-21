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

  machineBreakdown(p) {
    return [
      "🚨 *Machine breakdown*",
      p.machineId ? `Machine: ${p.machineId}` : null,
      p.previousStatus ? `Was: ${p.previousStatus}` : null,
      p.orderRunning ? `Was running order: #${p.orderRunning}` : null,
      p.by ? `Reported by: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
    ].filter(Boolean).join("\n");
  },

  shiftBelowThreshold(p) {
    return [
      "📉 *Low-output shift*",
      p.machineId ? `Machine: ${p.machineId}` : null,
      p.shift ? `Shift: ${p.shift}` : null,
      p.date ? `Date: ${_date(p.date)}` : null,
      p.produced != null ? `Produced: ${_num(p.produced)} m` : null,
      p.baseline != null ? `Plant baseline: ${_num(p.baseline)} m` : null,
      p.percentOfBaseline != null
        ? `That's ${Math.round(p.percentOfBaseline)}% of baseline.` : null,
    ].filter(Boolean).join("\n");
  },

  wastageHighEvent(p) {
    return [
      "♻️ *High wastage event*",
      p.jobNo ? `Job: #${p.jobNo}` : null,
      p.elasticName ? `Elastic: ${p.elasticName}` : null,
      p.quantity != null ? `Wastage: ${_num(p.quantity)} m` : null,
      p.dailyProduction != null ? `Today's production: ${_num(p.dailyProduction)} m` : null,
      p.percent != null ? `That's ${Math.round(p.percent)}% — above 10% threshold.` : null,
      p.reason ? `Reason: ${p.reason}` : null,
      p.employee ? `Operator: ${p.employee}` : null,
    ].filter(Boolean).join("\n");
  },

  orderCompleted(p) {
    return [
      "🎉 *Order completed*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.totalMeters ? `Qty: ${_num(p.totalMeters)} m` : null,
      p.releasedReservations ? `Reservations released: ${p.releasedReservations}` : null,
      p.by ? `By: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
      p.onTime !== undefined ? (p.onTime ? "✓ On time" : "⚠️ Late vs supply") : null,
    ].filter(Boolean).join("\n");
  },

  orderProductionStarted(p) {
    return [
      "🛠️ *Production started*",
      p.orderNo ? `Order #${p.orderNo}` : null,
      p.customerName ? `Customer: ${p.customerName}` : null,
      p.totalMeters ? `Qty: ${_num(p.totalMeters)} m` : null,
      p.by ? `By: ${p.by}` : null,
      p.via ? `Via: ${p.via}` : null,
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
// Legacy alias map — orchestrator now reads settings.getEventConfig()
// which uses normalizeEventConfig, so this just declares the known
// event types. Kept for compatibility with tests that referenced
// EVENT_FLAG.
const EVENT_FLAG = {
  orderCreated:           "orderCreated",
  orderApproved:          "orderApproved",
  orderCancelled:         "orderCancelled",
  orderForceApproved:     "orderForceApproved",
  orderCompleted:         "orderCompleted",
  orderProductionStarted: "orderProductionStarted",
  orderPredictedLate:     "orderPredictedLate",
  morningDigest:          "morningDigest",
  machineBreakdown:       "machineBreakdown",
  shiftBelowThreshold:    "shiftBelowThreshold",
  wastageHighEvent:       "wastageHighEvent",
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
//
// Per-event behaviour driven by NotificationSettings.events[ev]:
//   - enabled         — kill switch per event
//   - recipients[]    — overrides the global recipients when set
//   - tier            — realtime ignores quiet hours; daily/hourly defer
//   - throttleSeconds — N seconds since the last "sent" row for
//                       (event, entity.id) → skip "throttled"
async function notify(eventType, payload = {}) {
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

    const cfg = settings.getEventConfig(eventType);
    if (!cfg.enabled) {
      await _audit({
        event: eventType, status: "skipped", reason: `event ${eventType} muted`,
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: `event ${eventType} muted` };
    }

    // Quiet hours — only suppresses non-realtime tiers. Real-time
    // events are urgent by definition, so they punch through.
    if (cfg.tier !== "realtime" && settings.isInQuietHours()) {
      await _audit({
        event: eventType, status: "skipped",
        reason: `deferred — quiet hours (tier=${cfg.tier})`,
        entity: auditEntity, actor: auditActor,
      });
      return { skipped: "quiet hours" };
    }

    // Per-event throttle. Looks for any recent "sent" row that
    // matches the same (event, entity.id) within the throttle
    // window. Without an entity we can't safely dedupe (would risk
    // suppressing legitimately distinct messages), so skip the
    // check in that case.
    if (cfg.throttleSeconds > 0 && auditEntity?.id) {
      const since = new Date(Date.now() - cfg.throttleSeconds * 1000);
      const recent = await Notification.findOne({
        event:       eventType,
        "entity.id": auditEntity.id,
        status:      "sent",
        createdAt:   { $gte: since },
      }).sort({ createdAt: -1 }).lean();
      if (recent) {
        const ago = Math.round((Date.now() - new Date(recent.createdAt).getTime()) / 1000);
        await _audit({
          event: eventType, status: "skipped",
          reason: `throttled (last sent ${ago}s ago, window ${cfg.throttleSeconds}s)`,
          entity: auditEntity, actor: auditActor,
        });
        return { skipped: "throttled" };
      }
    }

    // Recipient resolution — per-event override falls through to
    // the global list when the per-event recipients[] is empty.
    const recipients = (cfg.recipients.length > 0 ? cfg.recipients : (settings.recipients || []))
      .filter(Boolean);
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

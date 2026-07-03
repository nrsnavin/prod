// api/notify.js
//
// Admin-only management surface for owner WhatsApp notifications.
//
//   GET  /api/v2/notify/settings        read current config + provider status
//   PUT  /api/v2/notify/settings        update recipients / toggles / quiet hours
//   POST /api/v2/notify/test            send a test message to all recipients
//
// Secrets are never read or written here — they live in env. This
// route only exposes whether the provider is *configured*, so the
// admin UI can show a "connect WhatsApp" hint when creds are absent.
const express          = require("express");
const router           = express.Router();
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const ErrorHandler     = require("../utils/ErrorHandler.js");

const NotificationSettings = require("../models/NotificationSettings.js");
const { notify }           = require("../utils/notify.js");
const { isConfigured, PROVIDER } = require("../utils/whatsapp.js");
const { buildDigestData, formatDigest } = require("../utils/digest.js");
const Notification = require("../models/Notification.js");
const {
  verifyTwilioSignature, parseCommand, twimlReply, getWhatsAppBotToken,
} = require("../utils/whatsappInbound.js");
const NotifSettings = NotificationSettings;
const axios         = require("axios");
const Order         = require("../models/Order.js");

// Build a normalized events map so the admin app always sees
// {enabled,recipients,tier,throttleSeconds} per event regardless of
// whether storage holds the legacy Boolean or the new Object shape.
function _normalizedEvents(s) {
  const out = {};
  // Iterate over the known event keys (declared in the schema).
  for (const ev of Object.keys(s.events?.toObject?.() ?? s.events ?? {})) {
    out[ev] = s.getEventConfig(ev);
  }
  return out;
}

// Validate one per-event config block. Returns null on success or
// an error string on failure.
function _validateEventConfig(ev, value) {
  if (typeof value === "boolean") return null; // legacy toggle
  if (!value || typeof value !== "object") return `events.${ev} must be a boolean or object`;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    return `events.${ev}.enabled must be boolean`;
  if (value.recipients !== undefined) {
    if (!Array.isArray(value.recipients))
      return `events.${ev}.recipients must be an array`;
    const bad = value.recipients.find((r) => typeof r !== "string" || !/^\+\d{8,15}$/.test(r));
    if (bad) return `events.${ev}.recipients has invalid number: ${bad}`;
  }
  if (value.tier !== undefined && !["realtime", "hourly", "daily"].includes(value.tier))
    return `events.${ev}.tier must be one of realtime|hourly|daily`;
  if (value.throttleSeconds !== undefined && (!Number.isFinite(value.throttleSeconds) || value.throttleSeconds < 0))
    return `events.${ev}.throttleSeconds must be a non-negative number`;
  return null;
}

// ── GET settings ──────────────────────────────────────────────────
router.get(
  "/settings",
  catchAsyncErrors(async (_req, res) => {
    const s = await NotificationSettings.load();
    res.json({
      success: true,
      settings: {
        enabled:    s.enabled,
        recipients: s.recipients,
        events:     _normalizedEvents(s),
        quietHours: s.quietHours,
        timezone:   s.timezone,
      },
      provider: {
        name:       PROVIDER,
        configured: isConfigured(), // false → running in dry-run mode
      },
    });
  })
);

// ── PUT settings ──────────────────────────────────────────────────
router.put(
  "/settings",
  catchAsyncErrors(async (req, res, next) => {
    const { enabled, recipients, events, quietHours, timezone } = req.body || {};
    const s = await NotificationSettings.load();

    if (typeof enabled === "boolean") s.enabled = enabled;

    if (recipients !== undefined) {
      if (!Array.isArray(recipients)) {
        return next(new ErrorHandler("recipients must be an array of E.164 numbers", 400));
      }
      const bad = recipients.find((r) => typeof r !== "string" || !/^\+\d{8,15}$/.test(r));
      if (bad !== undefined) {
        return next(new ErrorHandler(`invalid number: ${bad} (use +countrycode...)`, 400));
      }
      s.recipients = recipients;
    }

    // events can be a partial map: { orderCreated: false } or
    // { orderCreated: { enabled: true, recipients: ["+91..."],
    // throttleSeconds: 30 } }. We merge per-event into the current
    // config so callers don't have to send the whole object.
    if (events && typeof events === "object") {
      for (const [ev, value] of Object.entries(events)) {
        if (s.events[ev] === undefined) continue; // ignore unknown events
        const err = _validateEventConfig(ev, value);
        if (err) return next(new ErrorHandler(err, 400));
        if (typeof value === "boolean") {
          // Preserve the existing rich fields, flip enabled.
          const current = s.getEventConfig(ev);
          s.events[ev] = { ...current, enabled: value };
        } else {
          const current = s.getEventConfig(ev);
          s.events[ev] = { ...current, ...value };
        }
      }
      s.markModified("events");
    }

    if (quietHours && typeof quietHours === "object") {
      const within = (n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 23);
      if (!within(quietHours.start) || !within(quietHours.end)) {
        return next(new ErrorHandler("quietHours.start/end must be 0-23 or null", 400));
      }
      s.quietHours = { start: quietHours.start ?? null, end: quietHours.end ?? null };
    }

    if (typeof timezone === "string" && timezone) s.timezone = timezone;

    await s.save();
    res.json({
      success: true,
      settings: {
        enabled: s.enabled, recipients: s.recipients,
        events: _normalizedEvents(s),
        quietHours: s.quietHours, timezone: s.timezone,
      },
    });
  })
);

// ── POST test ─────────────────────────────────────────────────────
// Sends a test message so the owner can confirm the pipe end-to-end.
// In dry-run mode (creds absent) this returns the preview instead of
// sending — still useful to confirm recipients + formatting.
router.post(
  "/test",
  catchAsyncErrors(async (req, res) => {
    const result = await notify("test", { body: req.body?.message });
    res.json({
      success: true,
      result,
      hint: isConfigured()
        ? undefined
        : "Provider not configured — message was logged (dry-run), not sent. Set the Twilio env vars to send for real.",
    });
  })
);

// ── POST run-digest ───────────────────────────────────────────────
// Builds the morning digest and sends it. Designed to be called by a
// scheduler at ~9 AM. Two auth paths:
//   • the normal admin gate (when an admin triggers it from the UI), or
//   • an x-cron-secret header matching env CRON_SECRET (so an external
//     cron / cloud scheduler can fire it without a login session).
// The mount applies ADMIN_GATE; this handler additionally lets a
// valid cron secret through by short-circuiting before the gate runs
// — but since the gate is mount-level, we instead expose the secret
// path as a sibling unguarded route registered in app.js. To keep it
// simple here, this route trusts the mount's admin gate; the cron
// secret variant is handled in app.js (see runDigestPublic).
router.post(
  "/run-digest",
  catchAsyncErrors(async (req, res) => {
    const result = await runDigest(req.query.dryReturn === "1");
    res.json({ success: true, ...result });
  })
);

// Shared digest runner — builds + sends, returns a summary. Exported
// so app.js can wire the cron-secret public route to the same logic.
async function runDigest(returnTextOnly = false) {
  const data = await buildDigestData(new Date());
  const text = formatDigest(data);
  if (returnTextOnly) return { preview: text, sent: false };

  // Build + publish a PDF version so the WhatsApp ping carries an
  // attachment Twilio fetches by URL. PDF generation failures are
  // non-fatal — the text body still ships.
  let mediaUrl = null;
  try {
    const { buildMorningDigestPdf } = require("../utils/reportPdf.js");
    const { publishPdf, pdfFilename } = require("../utils/reportPublisher.js");
    const pdf = await buildMorningDigestPdf(data);
    const published = await publishPdf(pdf, pdfFilename("morning-digest"));
    mediaUrl = published.url;
  } catch (err) {
    console.warn(`[runDigest] PDF render/publish failed: ${err?.message}`);
  }

  const notifyResult = await notify("morningDigest", { body: text, _mediaUrl: mediaUrl });

  // Piggy-back on the daily cron to surface notification-system
  // health: delivery failures, missed cron runs, lingering dry-run.
  // Each helper is self-throttled via NotificationSettings so a
  // chronic condition only pings on its own cadence.
  try {
    const { runSystemHealthChecks } = require("../utils/systemHealth.js");
    await runSystemHealthChecks();
  } catch (err) {
    console.warn(`[runDigest] health checks crashed: ${err?.message}`);
  }

  // Per-event anomaly stream — fired as separate WhatsApp pings so
  // each one is individually actionable, throttled via NotificationSettings.
  try {
    const { runDailyAnomalyAlerts } = require("../utils/dailyAnomalyAlerts.js");
    await runDailyAnomalyAlerts(new Date());
  } catch (err) {
    console.warn(`[runDigest] anomaly alerts crashed: ${err?.message}`);
  }

  return { notifyResult, preview: text, mediaUrl };
}

router.runDigest = runDigest;

// ── POST run-evening-report ───────────────────────────────────────
// Same shape as run-digest. The 9 PM cron triggers this; covers
// what happened TODAY (the morning digest covers yesterday).
router.post(
  "/run-evening-report",
  catchAsyncErrors(async (req, res) => {
    const result = await runEveningReport(req.query.dryReturn === "1");
    res.json({ success: true, ...result });
  })
);

async function runEveningReport(returnTextOnly = false) {
  const { buildEveningReportData, formatEveningReport } =
    require("../utils/eveningReport.js");
  const data = await buildEveningReportData(new Date());
  const text = formatEveningReport(data);
  if (returnTextOnly) return { preview: text, sent: false };

  let mediaUrl = null;
  try {
    const { buildEveningReportPdf } = require("../utils/reportPdf.js");
    const { publishPdf, pdfFilename } = require("../utils/reportPublisher.js");
    const pdf = await buildEveningReportPdf(data);
    const published = await publishPdf(pdf, pdfFilename("evening-report"));
    mediaUrl = published.url;
  } catch (err) {
    console.warn(`[runEveningReport] PDF render/publish failed: ${err?.message}`);
  }

  const notifyResult = await notify("eveningReport", { body: text, _mediaUrl: mediaUrl });
  return { notifyResult, preview: text, mediaUrl };
}

router.runEveningReport = runEveningReport;

// ─────────────────────────────────────────────────────────────────
// Inbound WhatsApp webhook — Twilio fires this on every reply.
// Mounted as a sibling route in app.js (NOT behind ADMIN_GATE) so
// Twilio's public POST can reach it. Auth is the Twilio signature
// + the sender allow-list, not an admin JWT.
//
// Currently supports only:
//   APPROVE 1042
//   APPROVE 1042 force: <reason>
//
// Architecture: webhook validates → internal axios call to the
// existing /api/v2/order/approve route with a system "WhatsApp Bot"
// admin JWT. Zero risk to the 250-line approve logic; exact same
// code path; audit trail includes both the bot user and the
// originating WhatsApp number.
// ─────────────────────────────────────────────────────────────────
async function handleIncoming(req) {
  const from = req.body?.From || "";        // "whatsapp:+91…"
  const body = req.body?.Body || "";

  // 1. Twilio signature — proves the call really came from Twilio.
  //    This handler triggers a real order approval (deducts stock),
  //    so the signature is MANDATORY in production: if the auth token
  //    isn't configured, we fail closed rather than trusting the
  //    attacker-controlled `From` allow-list alone. Only a non-
  //    production env is allowed to skip (local dry-run testing).
  const token = process.env.TWILIO_AUTH_TOKEN;
  const isProd = process.env.NODE_ENV === "PRODUCTION";
  if (!token) {
    if (isProd) {
      console.error("[whatsapp:incoming] TWILIO_AUTH_TOKEN unset in production — rejecting");
      return { status: 503, body: twimlReply("Webhook not configured.") };
    }
    console.warn("[whatsapp:incoming] TWILIO_AUTH_TOKEN unset — signature check skipped (non-prod only)");
  } else {
    // Pin the signed URL to the configured public base URL rather than
    // trusting req.host / X-Forwarded-Proto, which a proxy hop lets an
    // attacker influence. PUBLIC_BASE_URL must match the URL Twilio is
    // configured to POST to (the webhook URL in the Twilio console).
    const base = (process.env.PUBLIC_BASE_URL
      || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const url = `${base}${req.originalUrl}`;
    const sig = req.get("x-twilio-signature");
    const ok = verifyTwilioSignature({
      url, body: req.body, signature: sig, authToken: token,
    });
    if (!ok) {
      console.warn(`[whatsapp:incoming] bad signature from ${from}`);
      return { status: 403, body: twimlReply("Unauthorized.") };
    }
  }

  // 2. Allow-list: sender's E.164 must be in NotificationSettings.recipients.
  const senderE164 = from.replace(/^whatsapp:/i, "").trim();
  const settings = await NotifSettings.load();
  if (!(settings.recipients || []).includes(senderE164)) {
    console.warn(`[whatsapp:incoming] sender ${senderE164} not on allow-list`);
    return {
      status: 200,
      body: twimlReply(`Your number (${senderE164}) is not authorized to act on orders.`),
    };
  }

  // 3. Parse the command.
  const cmd = parseCommand(body);
  if (!cmd) {
    return {
      status: 200,
      body: twimlReply(
        "Sorry, I didn't recognize that command. Reply with:\n" +
        "  APPROVE <orderNo>\n" +
        "  APPROVE <orderNo> force: <reason>"
      ),
    };
  }

  // 4. Look up the order by orderNo (the WhatsApp body has the human
  //    number, not the _id).
  const order = await Order.findOne({ orderNo: cmd.orderNo }).lean();
  if (!order) {
    return { status: 200, body: twimlReply(`Order #${cmd.orderNo} not found.`) };
  }
  if (order.status !== "Open") {
    return {
      status: 200,
      body: twimlReply(`Order #${cmd.orderNo} is ${order.status} — cannot approve.`),
    };
  }

  // 5. Internal call to /api/v2/order/approve. Uses the WhatsApp Bot
  //    admin JWT; the route handles transactions, stock checks,
  //    reservations, fingerprints, and the orderForceApproved
  //    notification all by itself.
  try {
    const botToken = await getWhatsAppBotToken();
    const port = process.env.PORT || 2701;
    const internalUrl = `http://localhost:${port}/api/v2/order/approve`;
    const payload = {
      orderId:     order._id.toString(),
      force:       cmd.force,
      forceReason: cmd.forceReason,
      // Per-call audit context — the existing actorFromRequest
      // picks up the JWT user but this extra meta is recorded in
      // the request body for the route to optionally surface.
      whatsappActor: { from: senderE164 },
    };
    const res = await axios.post(internalUrl, payload, {
      headers: { Cookie: `token=${botToken}` },
      timeout: 30_000,
      // Don't throw on 4xx — we want to read the body and surface it.
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.success) {
      return {
        status: 200,
        body:   twimlReply(
          `✓ Order #${cmd.orderNo} approved${cmd.force ? " (forced)" : ""}.\n` +
          `Raw stock deducted, elastic stock reserved.`
        ),
      };
    }
    // Failure — pass the API's message to the user.
    const msg = res.data?.message || `HTTP ${res.status}`;
    // Specifically mention the force command when stock is short.
    const hint = res.data?.code === "INSUFFICIENT_STOCK"
      ? `\nReply: APPROVE ${cmd.orderNo} force: <reason>`
      : "";
    return {
      status: 200,
      body:   twimlReply(`✗ Could not approve #${cmd.orderNo}: ${msg}${hint}`),
    };
  } catch (err) {
    console.warn(`[whatsapp:incoming] internal call failed: ${err?.message}`);
    return {
      status: 200,
      body:   twimlReply(`✗ Could not approve #${cmd.orderNo} — server error.`),
    };
  }
}

router.handleIncoming = handleIncoming;

// ─────────────────────────────────────────────────────────────────
// Audit-log surface.
//
//   GET /api/v2/notify/log?event=…&recipient=…&status=…&limit=50
//   GET /api/v2/notify/stats?days=30
//
// Both admin-gated by the mount in app.js. Designed to drive a
// future settings/log screen + cost dashboards.
// ─────────────────────────────────────────────────────────────────
router.get(
  "/log",
  catchAsyncErrors(async (req, res) => {
    const { event, recipient, status, entityType, entityId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    const q = {};
    if (event)      q.event      = event;
    if (recipient)  q.recipient  = recipient;
    if (status)     q.status     = status;
    if (entityType) q["entity.type"] = entityType;
    if (entityId)   q["entity.id"]   = entityId;

    const rows = await Notification.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, count: rows.length, rows });
  })
);

router.get(
  "/stats",
  catchAsyncErrors(async (req, res) => {
    const days  = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await Notification.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: {
          _id: { event: "$event", status: "$status" },
          count: { $sum: 1 },
        } },
      { $sort: { "_id.event": 1, "_id.status": 1 } },
    ]);

    // Pivot into a friendlier shape for the admin app.
    const byEvent = {};
    for (const r of rows) {
      const ev = r._id.event;
      byEvent[ev] ??= { event: ev, sent: 0, dry_run: 0, skipped: 0, error: 0, total: 0 };
      byEvent[ev][r._id.status] = r.count;
      byEvent[ev].total += r.count;
    }
    res.json({ success: true, days, events: Object.values(byEvent) });
  })
);

module.exports = router;

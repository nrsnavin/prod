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
        events:     s.events,
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
      // Light validation — must look like +<digits>.
      const bad = recipients.find((r) => typeof r !== "string" || !/^\+\d{8,15}$/.test(r));
      if (bad !== undefined) {
        return next(new ErrorHandler(`invalid number: ${bad} (use +countrycode...)`, 400));
      }
      s.recipients = recipients;
    }

    if (events && typeof events === "object") {
      for (const [k, v] of Object.entries(events)) {
        if (s.events[k] !== undefined && typeof v === "boolean") s.events[k] = v;
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
    res.json({ success: true, settings: {
      enabled: s.enabled, recipients: s.recipients, events: s.events,
      quietHours: s.quietHours, timezone: s.timezone,
    } });
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

module.exports = router;

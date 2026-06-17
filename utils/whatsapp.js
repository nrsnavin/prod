'use strict';
//
// Provider-agnostic WhatsApp sender.
//
// One exported function — sendWhatsApp(to, body) — with a Twilio
// adapter behind it, called over Twilio's REST API with axios (no
// SDK dependency). Swapping to an India BSP later means writing a
// second adapter and flipping WHATSAPP_PROVIDER; no caller changes.
//
// Dry-run by default: if the provider isn't fully configured (creds
// missing), the message is logged, not sent, and the call resolves
// with { sent: false, dryRun: true }. This lets the whole pipeline
// be built and reviewed before a single real message goes out.
//
// Never throws — notification delivery must never break a business
// operation. Failures resolve with { sent: false, error }.

const axios = require("axios");

const PROVIDER = (process.env.WHATSAPP_PROVIDER || "twilio").toLowerCase();

// ── Twilio adapter ────────────────────────────────────────────────
function twilioConfig() {
  return {
    sid:   process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from:  process.env.TWILIO_WHATSAPP_FROM, // e.g. "whatsapp:+14155238886" (sandbox)
  };
}

function twilioConfigured() {
  const c = twilioConfig();
  return Boolean(c.sid && c.token && c.from);
}

async function twilioSend(to, body) {
  const c = twilioConfig();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`;
  // Twilio wants "whatsapp:+E164" on both ends.
  const toAddr   = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromAddr = c.from.startsWith("whatsapp:") ? c.from : `whatsapp:${c.from}`;

  const params = new URLSearchParams({ To: toAddr, From: fromAddr, Body: body });
  const res = await axios.post(url, params.toString(), {
    auth: { username: c.sid, password: c.token },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10_000,
  });
  return { sid: res.data?.sid, status: res.data?.status };
}

// ── Public API ────────────────────────────────────────────────────

function isConfigured() {
  switch (PROVIDER) {
    case "twilio": return twilioConfigured();
    default:       return false;
  }
}

/**
 * Send one WhatsApp message. Resolves (never rejects) with a result
 * object the caller can log:
 *   { sent: true,  provider, providerId }
 *   { sent: false, dryRun: true, preview }     ← creds missing
 *   { sent: false, error }                     ← provider failed
 */
async function sendWhatsApp(to, body) {
  if (!to || !body) {
    return { sent: false, error: "missing to/body" };
  }

  if (!isConfigured()) {
    // Dry-run — log exactly what would have been sent.
    console.log(
      `[whatsapp:dry-run] → ${to}\n` +
      `${body}\n` +
      `[whatsapp:dry-run] (set ${PROVIDER.toUpperCase()} env vars to send for real)`
    );
    return { sent: false, dryRun: true, preview: { to, body } };
  }

  try {
    let providerResult;
    switch (PROVIDER) {
      case "twilio":
        providerResult = await twilioSend(to, body);
        break;
      default:
        return { sent: false, error: `unknown provider: ${PROVIDER}` };
    }
    return { sent: true, provider: PROVIDER, providerId: providerResult.sid, status: providerResult.status };
  } catch (err) {
    // Surface Twilio's structured error message when present.
    const msg = err?.response?.data?.message || err?.message || "send failed";
    console.warn(`[whatsapp] send to ${to} failed: ${msg}`);
    return { sent: false, error: msg };
  }
}

module.exports = {
  sendWhatsApp,
  isConfigured,
  PROVIDER,
};

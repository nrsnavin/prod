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

async function twilioSend(to, body, mediaUrl) {
  const c = twilioConfig();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`;
  // Twilio wants "whatsapp:+E164" on both ends.
  const toAddr   = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromAddr = c.from.startsWith("whatsapp:") ? c.from : `whatsapp:${c.from}`;

  const params = new URLSearchParams({ To: toAddr, From: fromAddr, Body: body });
  if (mediaUrl) params.set("MediaUrl", mediaUrl);
  const res = await axios.post(url, params.toString(), {
    auth: { username: c.sid, password: c.token },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10_000,
  });
  return { sid: res.data?.sid, status: res.data?.status };
}

// ── A long message goes in parts ─────────────────────────────────
// Twilio refuses a body over 1,600 characters (error 21617): nothing is
// cut, nothing is split, the whole message is rejected. The morning
// digest on a busy day runs to about 1,800, the month-close checklist
// further — so the day there was most to say, nothing was said. A body
// over the limit is sent as several messages, broken between lines.
//
// Kept under the limit with room to spare: the provider counts emoji and
// other characters outside the basic set as more than one.
const MAX_BODY = 1500;

/** `body` as the pieces to send: each within MAX_BODY, broken at a line where there is one. */
function partsOf(body) {
  const text = String(body);
  if (text.length <= MAX_BODY) return [text];
  const parts = [];
  let part = "";
  const flush = () => { if (part.trim()) parts.push(part); part = ""; };
  for (const line of text.split("\n")) {
    // One line longer than a whole message: cut it where it must be.
    if (line.length > MAX_BODY) {
      flush();
      for (let i = 0; i < line.length; i += MAX_BODY) parts.push(line.slice(i, i + MAX_BODY));
      continue;
    }
    if (part && part.length + 1 + line.length > MAX_BODY) flush();
    part = part ? `${part}\n${line}` : line;
  }
  flush();
  // A blank line that fell at a break is not worth starting a message with.
  return parts.map((p) => p.replace(/^\n+|\n+$/g, "")).filter(Boolean);
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
async function sendWhatsApp(to, body, opts = {}) {
  if (!to || !body) {
    return { sent: false, error: "missing to/body" };
  }
  const mediaUrl = opts?.mediaUrl;

  if (!isConfigured()) {
    // Dry-run — log exactly what would have been sent.
    console.log(
      `[whatsapp:dry-run] → ${to}\n` +
      `${body}\n` +
      (mediaUrl ? `[whatsapp:dry-run] media: ${mediaUrl}\n` : "") +
      `[whatsapp:dry-run] (set ${PROVIDER.toUpperCase()} env vars to send for real)`
    );
    return { sent: false, dryRun: true, preview: { to, body, mediaUrl } };
  }

  if (PROVIDER !== "twilio") return { sent: false, error: `unknown provider: ${PROVIDER}` };

  // Surface Twilio's structured error message when present.
  const reasonOf = (err) => err?.response?.data?.message || err?.message || "send failed";
  const parts = partsOf(body);
  let first;
  try {
    // A picture goes with the first part.
    first = await twilioSend(to, parts[0], mediaUrl);
  } catch (err) {
    const msg = reasonOf(err);
    console.warn(`[whatsapp] send to ${to} failed: ${msg}`);
    return { sent: false, error: msg };
  }
  const out = { sent: true, provider: PROVIDER, providerId: first.sid, status: first.status };
  if (parts.length === 1) return out;

  // The rest, in order. The message has gone once its first part has: a
  // later part failing is said, and is not a reason to send it all again.
  out.parts = parts.length;
  for (let i = 1; i < parts.length; i += 1) {
    try {
      await twilioSend(to, parts[i]);
    } catch (err) {
      const msg = `part ${i + 1} of ${parts.length} was not sent: ${reasonOf(err)}`;
      console.warn(`[whatsapp] send to ${to}: ${msg}`);
      return { ...out, partial: true, error: msg };
    }
  }
  return out;
}

module.exports = {
  sendWhatsApp,
  isConfigured,
  partsOf,
  MAX_BODY,
  PROVIDER,
};

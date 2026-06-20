'use strict';
//
// Inbound WhatsApp utilities — parser, Twilio signature verification,
// and the "WhatsApp Bot" admin JWT used for internal calls from the
// webhook back into the existing /approve route.
//
// Keeping these pure-ish (no Express coupling) so the heavy logic
// is unit-testable.

const crypto = require("crypto");
const User   = require("../models/User.js");

// ── Twilio signature verification ────────────────────────────────
// https://www.twilio.com/docs/usage/security#validating-requests
//
// Signature = HMAC-SHA1(authToken, URL + sortedFormDataKVs).toBase64
// We must construct the same string Twilio did:
//   - full URL the webhook was POSTed to (incl. proto + host + path)
//   - then for each form param, sorted alphabetically by key,
//     concatenate `${key}${value}` with no separator
function verifyTwilioSignature({ url, body, signature, authToken }) {
  if (!authToken || !signature || !url) return false;
  const params = body || {};
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + (params[k] ?? "");
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(data, "utf8")
    .digest("base64");
  // constant-time compare
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature, "utf8")
  );
}

// ── Command parser ──────────────────────────────────────────────
// Owner-friendly grammar: case-insensitive, whitespace tolerant.
//
//   APPROVE 1042
//   APPROVE 1042 force: customer escalation
//   APPROVE 1042 FORCE: rush, owner approved
//
// Returns { action, orderNo, force, forceReason } or null when the
// message isn't a recognized command.
function parseCommand(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  // tolerant regex — `force` can be uppercase, with or without colon,
  // followed by any reason. orderNo is a positive integer.
  const m = trimmed.match(
    /^approve\s+(\d+)(?:\s+force\s*[:\-]?\s*(.+))?$/i
  );
  if (!m) return null;
  const orderNo     = Number(m[1]);
  const forceReason = (m[2] || "").trim();
  return {
    action:      "approve",
    orderNo,
    force:       forceReason.length > 0,
    forceReason,
  };
}

// ── TwiML response builder ──────────────────────────────────────
// Twilio sends our XML back as the WhatsApp reply, so we don't need
// to make a separate outbound API call. Simple <Response><Message>.
function twimlReply(text) {
  // basic XML-escape so order numbers / reasons can't break the body
  const safe = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

// ── WhatsApp Bot admin user — used to mint a JWT for internal
//   calls from the webhook back into /api/v2/order/approve. The
//   admin auth gate accepts that token; the order's fingerprints
//   record this user as actor and a per-action meta entry preserves
//   the originating WhatsApp number for the audit trail.
const BOT_EMAIL = "whatsapp-bot@internal.local";
const BOT_NAME  = "WhatsApp Bot";

let _cachedBotToken = null;
let _cachedBotTokenExpiresAt = 0;

async function getWhatsAppBotToken() {
  // Cache the JWT for ~23h (default JWT_EXPIRES is 24h). Re-mint
  // a few minutes before expiry to be safe.
  if (_cachedBotToken && Date.now() < _cachedBotTokenExpiresAt) {
    return _cachedBotToken;
  }
  let bot = await User.findOne({ email: BOT_EMAIL });
  if (!bot) {
    // Random password — the account is never used for interactive
    // login. JWT auth alone is sufficient.
    const rand = crypto.randomBytes(24).toString("hex");
    bot = await User.create({
      name:     BOT_NAME,
      email:    BOT_EMAIL,
      password: rand,
      role:     "admin",
    });
  }
  _cachedBotToken = bot.getJwtToken();
  _cachedBotTokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return _cachedBotToken;
}

module.exports = {
  verifyTwilioSignature,
  parseCommand,
  twimlReply,
  getWhatsAppBotToken,
  BOT_EMAIL,
  BOT_NAME,
};

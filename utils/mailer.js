"use strict";

// ══════════════════════════════════════════════════════════════
//  MAILER  (SMTP via nodemailer)
//
//  Transactional email for the ERP — currently password-reset
//  links. Configured entirely through env (config/.env):
//
//    SMTP_HOST     e.g. smtp.hostinger.com
//    SMTP_PORT     465 (SSL) or 587 (STARTTLS)
//    SMTP_USER     the mailbox login, e.g. no-reply@baluelastics.com
//    SMTP_PASS     that mailbox's password
//    SMTP_FROM     display From, e.g. "Balu Elastics ERP <no-reply@baluelastics.com>"
//                  (falls back to SMTP_USER if unset)
//    WEB_URL       public web app origin, e.g. https://erp.baluelastics.com
//                  (used to build the reset link target)
//
//  If SMTP is not configured the mailer degrades gracefully: it
//  logs a warning and returns { skipped:true } instead of throwing,
//  so a half-provisioned server never 500s the forgot-password
//  endpoint. The route above it always returns a generic success
//  regardless, so a mail failure never leaks account existence.
// ══════════════════════════════════════════════════════════════

const nodemailer = require("nodemailer");

let _transport = null;

// The last send failure, kept in memory so an admin can find out WHY
// mail is not arriving without reading the server log.
//
// Every caller of this module swallows failures on purpose — the
// password-reset and OTP routes must answer identically whether or not
// an account exists, or they become an account-enumeration oracle. The
// cost of that was total silence: an unconfigured or misconfigured
// mailer looked exactly like a working one from every angle a person
// can see, including from the login screen of the only sign-in method
// the UI offers.
let _lastError = null;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Mask a login for display — enough to recognise, not enough to reuse. */
function _maskUser(u) {
  if (!u) return null;
  const [name, domain] = String(u).split("@");
  if (!domain) return `${name.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${domain}`;
}

/**
 * What ops needs to answer "why is no mail arriving?".
 *
 * Deliberately free of the password. `configured:false` means the
 * process has no SMTP settings at all — nothing has ever been
 * attempted, and no amount of retrying will help.
 */
function status() {
  return {
    configured: isConfigured(),
    host:       process.env.SMTP_HOST || null,
    port:       Number(process.env.SMTP_PORT) || (isConfigured() ? 465 : null),
    secure:     (Number(process.env.SMTP_PORT) || 465) === 465,
    user:       _maskUser(process.env.SMTP_USER),
    from:       process.env.SMTP_FROM || _maskUser(process.env.SMTP_USER),
    lastError:  _lastError,
  };
}

/** Drop the cached transport so a re-read of the env takes effect. */
function resetTransport() {
  _transport = null;
}

function transport() {
  if (_transport) return _transport;
  if (!isConfigured()) return null;

  const port = Number(process.env.SMTP_PORT) || 465;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transport;
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

// Low-level send. Resolves { skipped:true } when SMTP is unconfigured
// so callers can stay indifferent to deployment state.
async function sendMail({ to, subject, text, html }) {
  const t = transport();
  if (!t) {
    // The subject is NOT logged. A sign-in code is the first thing in
    // the OTP subject line, so this used to print live one-time codes
    // into the server log in plaintext — on exactly the deployments
    // where nobody was receiving them, and therefore where people would
    // go looking through the log.
    console.warn(`[mailer] SMTP not configured — skipping email to ${to}`);
    _lastError = {
      at: new Date().toISOString(),
      reason: "SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS unset)",
    };
    return { skipped: true, reason: "not-configured" };
  }
  try {
    const info = await t.sendMail({ from: fromAddress(), to, subject, text, html });
    _lastError = null;
    return { skipped: false, messageId: info.messageId };
  } catch (err) {
    // Recorded before rethrowing. Callers swallow this to protect the
    // anti-enumeration contract, so this record is the only place the
    // reason survives.
    _lastError = { at: new Date().toISOString(), reason: err.message };
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
//  Password-reset email
// ─────────────────────────────────────────────────────────────
async function sendPasswordResetEmail({ to, name, resetUrl, ttlMinutes }) {
  const who = name ? name.split(" ")[0] : "there";
  const subject = "Reset your Balu Elastics ERP password";
  const text = [
    `Hi ${who},`,
    ``,
    `We received a request to reset the password for your Balu Elastics ERP account.`,
    `Open the link below to choose a new password. It expires in ${ttlMinutes} minutes.`,
    ``,
    resetUrl,
    ``,
    `If you didn't request this, you can safely ignore this email — your password stays unchanged.`,
    ``,
    `— Balu Elastics ERP`,
  ].join("\n");

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="font-size:18px;margin:0 0 12px">Reset your password</h2>
    <p style="font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${who}, we received a request to reset the password for your
      <strong>Balu Elastics ERP</strong> account. Click the button below to
      choose a new password. This link expires in <strong>${ttlMinutes} minutes</strong>.
    </p>
    <p style="margin:0 0 20px">
      <a href="${resetUrl}"
         style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;
                padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">
        Reset password
      </a>
    </p>
    <p style="font-size:12px;line-height:1.6;color:#64748b;margin:0 0 8px">
      Or paste this link into your browser:<br>
      <span style="word-break:break-all;color:#1e3a5f">${resetUrl}</span>
    </p>
    <p style="font-size:12px;line-height:1.6;color:#64748b;margin:16px 0 0">
      If you didn't request this, ignore this email — your password stays unchanged.
    </p>
  </div>`;

  return sendMail({ to, subject, text, html });
}

// ─────────────────────────────────────────────────────────────
//  Login OTP email
// ─────────────────────────────────────────────────────────────
async function sendLoginOtpEmail({ to, name, code, ttlMinutes }) {
  const who = name ? name.split(" ")[0] : "there";
  const subject = `${code} is your Balu Elastics ERP sign-in code`;
  const text = [
    `Hi ${who},`,
    ``,
    `Your sign-in code for Balu Elastics ERP is:`,
    ``,
    `    ${code}`,
    ``,
    `It expires in ${ttlMinutes} minutes. If you didn't try to sign in, you can ignore this email.`,
    ``,
    `— Balu Elastics ERP`,
  ].join("\n");

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="font-size:18px;margin:0 0 12px">Your sign-in code</h2>
    <p style="font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${who}, use this code to sign in to <strong>Balu Elastics ERP</strong>.
      It expires in <strong>${ttlMinutes} minutes</strong>.
    </p>
    <p style="margin:0 0 20px">
      <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;
                   border-radius:10px;padding:14px 28px;font-size:28px;font-weight:800;
                   letter-spacing:8px;color:#1e3a5f">${code}</span>
    </p>
    <p style="font-size:12px;line-height:1.6;color:#64748b;margin:0">
      If you didn't try to sign in, ignore this email — nobody can access your
      account without this code.
    </p>
  </div>`;

  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendMail, sendPasswordResetEmail, sendLoginOtpEmail,
  isConfigured, status, resetTransport,
};

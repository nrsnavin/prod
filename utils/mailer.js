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

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
    console.warn(`[mailer] SMTP not configured — skipping email to ${to} ("${subject}")`);
    return { skipped: true };
  }
  const info = await t.sendMail({ from: fromAddress(), to, subject, text, html });
  return { skipped: false, messageId: info.messageId };
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

module.exports = { sendMail, sendPasswordResetEmail, isConfigured };

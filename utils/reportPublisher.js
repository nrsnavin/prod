'use strict';
//
// Persists a generated PDF under public/reports/ and returns the
// public URL Twilio can fetch. The static mount in app.js exposes
// /public/* so the URL becomes
//   ${PUBLIC_BASE_URL}/public/reports/<filename>.
//
// PUBLIC_BASE_URL must be reachable from Twilio's servers (i.e.
// the prod host, not localhost) — falls back to a sane default
// matching the deployed server. If neither is available, the
// caller should send the WhatsApp message without media.

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const REPORTS_DIR = path.join(__dirname, "..", "public", "reports");
const RETENTION_DAYS = 14;       // sweep out PDFs older than this on each run

function _baseUrl() {
  return (process.env.PUBLIC_BASE_URL
    || "http://13.233.117.153:2701").replace(/\/$/, "");
}

async function publishPdf(buffer, filename) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("publishPdf requires a Buffer");
  }
  await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
  const fullPath = path.join(REPORTS_DIR, filename);
  await fs.promises.writeFile(fullPath, buffer);
  _sweepOld().catch(() => { /* sweep is best-effort */ });
  return {
    path: fullPath,
    url:  `${_baseUrl()}/public/reports/${filename}`,
  };
}

async function _sweepOld() {
  try {
    const entries = await fs.promises.readdir(REPORTS_DIR);
    const cutoff  = Date.now() - RETENTION_DAYS * 86_400_000;
    await Promise.all(entries.map(async (name) => {
      if (!name.endsWith(".pdf")) return;
      try {
        const s = await fs.promises.stat(path.join(REPORTS_DIR, name));
        if (s.mtimeMs < cutoff) {
          await fs.promises.unlink(path.join(REPORTS_DIR, name));
        }
      } catch { /* ignore single-file errors */ }
    }));
  } catch { /* ignore */ }
}

// The report PDFs are served from an unauthenticated static mount
// (Twilio must fetch them by URL to attach them to WhatsApp), so the
// ONLY confidentiality control is that the filename is unguessable.
// A minute-resolution timestamp alone is trivially enumerable, so we
// append 128 bits of crypto-random entropy. An attacker can no longer
// iterate timestamps to harvest a day's reports.
function pdfFilename(prefix, date = new Date()) {
  const iso   = date.toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const token = crypto.randomBytes(16).toString("hex"); // 128-bit
  return `${prefix}-${iso}-${token}.pdf`;
}

module.exports = { publishPdf, pdfFilename, REPORTS_DIR };

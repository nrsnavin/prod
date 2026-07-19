"use strict";

// ══════════════════════════════════════════════════════════════
//  Error reporting — surfaces unexpected 5xx failures so ops can
//  see them instead of learning about outages from a user on
//  WhatsApp.
//
//  Two sinks, both optional and both fail-open (a reporting failure
//  must never take down the request path):
//
//   1. Structured stderr line — always on. One JSON object per 5xx,
//      matching the shape of middleware/requestLogger so the two
//      streams line up. Zero dependencies.
//
//   2. Sentry — engaged only when SENTRY_DSN is set AND the
//      @sentry/node package is actually installed. The require is
//      wrapped in try/catch so the app runs fine without the
//      dependency (this checkout may carry no package.json); once
//      ops runs `npm i @sentry/node` and sets SENTRY_DSN, errors
//      start flowing with no code change.
//
//  Only genuine server faults (statusCode >= 500) are reported.
//  Expected 4xx (validation, auth, 409 conflicts) are normal traffic
//  and would just be noise.
// ══════════════════════════════════════════════════════════════

let _sentry = null;
let _sentryReady = false;

// Lazily initialise Sentry on first use. Kept out of module load so a
// missing package / bad DSN can never crash the server at boot.
function _initSentry() {
  if (_sentryReady) return _sentry;
  _sentryReady = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const Sentry = require("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      release: process.env.GIT_COMMIT_SHA || process.env.COMMIT_SHA || undefined,
      tracesSampleRate: 0,
    });
    _sentry = Sentry;
    console.log("[errorReporter] Sentry initialised");
  } catch (err) {
    // Package not installed or init failed — fall back to stderr only.
    console.warn(`[errorReporter] Sentry unavailable (${err.message}); using stderr only`);
    _sentry = null;
  }
  return _sentry;
}

// Report a server-side failure. `req` is optional — pass it from the
// Express error handler so the log carries request context.
function reportError(err, req) {
  try {
    const line = {
      ts:     new Date().toISOString(),
      level:  "error",
      status: (err && err.statusCode) || 500,
      name:   (err && err.name) || "Error",
      msg:    (err && err.message) || String(err),
    };
    if (req) {
      line.method = req.method;
      line.path   = req.originalUrl ? req.originalUrl.split("?")[0] : req.url;
      if (req.user && req.user._id) line.user = req.user._id.toString();
      const ip = req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress);
      if (ip) line.ip = String(ip).split(",")[0].trim();
    }
    // The stack is the actionable part — keep it on its own field so the
    // JSON line stays greppable and the trace stays readable.
    if (err && err.stack) line.stack = err.stack;
    console.error(JSON.stringify(line));
  } catch (_) {
    /* never let reporting break the response */
  }

  try {
    const sentry = _initSentry();
    if (sentry) {
      sentry.withScope((scope) => {
        if (req) {
          scope.setTag("method", req.method);
          scope.setTag("path", req.originalUrl ? req.originalUrl.split("?")[0] : req.url);
          if (req.user && req.user._id) scope.setUser({ id: req.user._id.toString() });
        }
        sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      });
    }
  } catch (_) {
    /* fail-open */
  }
}

module.exports = { reportError };

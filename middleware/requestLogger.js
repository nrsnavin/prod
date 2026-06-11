"use strict";

// ══════════════════════════════════════════════════════════════
//  Structured request logging — zero-dependency stand-in for
//  morgan/winston (this checkout carries no package.json, so new
//  deps can't be installed from here). Emits one JSON line per
//  completed request on stdout:
//
//    {"ts":"2026-06-12T10:00:00.000Z","method":"POST",
//     "path":"/api/v2/order/approve","status":200,"ms":41,
//     "user":"6647...","ip":"10.0.0.5"}
//
//  Notes:
//   • Logs on the response 'finish' event so the status code and
//     latency are accurate.
//   • Reads req.user populated by isAuthenticated when present —
//     mounted BEFORE auth, the field is simply absent for
//     unauthenticated traffic.
//   • Never throws: a logging failure must not take down the
//     request path.
// ══════════════════════════════════════════════════════════════
module.exports = function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    try {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line = {
        ts:     new Date().toISOString(),
        method: req.method,
        path:   req.originalUrl?.split("?")[0] ?? req.url,
        status: res.statusCode,
        ms:     Math.round(ms * 10) / 10,
      };
      if (req.user?._id) line.user = req.user._id.toString();
      const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;
      if (ip) line.ip = String(ip).split(",")[0].trim();
      console.log(JSON.stringify(line));
    } catch (_) {
      /* never let logging break a request */
    }
  });

  next();
};

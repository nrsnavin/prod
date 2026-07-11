'use strict';
//
// Shared guard for edit/delete routes that must capture an audit reason.
// Reads `auditReason` from the JSON body (PUT/POST) or the query string
// (DELETE, whose axios client sends params not a body). Returns the
// trimmed reason, or null when it's missing/too short.

function requireReason(req) {
  // Accept `auditReason` (web + new mobile) or a plain `reason` fallback so
  // older mobile builds that posted `reason` (e.g. order delete) keep working.
  const reason = String(
    req?.body?.auditReason || req?.query?.auditReason ||
    req?.body?.reason || req?.query?.reason || ""
  ).trim();
  if (reason.length < 3) return null;
  return reason;
}

module.exports = { requireReason };

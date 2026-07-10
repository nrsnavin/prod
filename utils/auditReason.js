'use strict';
//
// Shared guard for edit/delete routes that must capture an audit reason.
// Reads `auditReason` from the JSON body (PUT/POST) or the query string
// (DELETE, whose axios client sends params not a body). Returns the
// trimmed reason, or null when it's missing/too short.

function requireReason(req) {
  const reason = String(req?.body?.auditReason || req?.query?.auditReason || "").trim();
  if (reason.length < 3) return null;
  return reason;
}

module.exports = { requireReason };

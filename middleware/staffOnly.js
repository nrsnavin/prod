"use strict";
// ══════════════════════════════════════════════════════════════════
//  NOT FOR A WORKER'S OWN LOGIN
//
//  A worker's self-service login carries the role "production" — the
//  same as a supervisor's — so a role gate alone lets it through. Most
//  modules are closed to it anyway by their feature key, which a worker
//  login is never given. The always-on modules (machine issues, notices,
//  feedback, …) have no key to refuse with: everyone may open them. Their
//  STAFF side — closing an issue, publishing a notice — is guarded here.
//
//  Use after isAuthenticated (and the role gate). What makes a login
//  self-service is decided in utils/features.js, as everywhere else.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require("../utils/ErrorHandler");
const { isSelfServiceOnly } = require("../utils/features");

function staffOnly(req, _res, next) {
  if (!req.user) return next(new ErrorHandler("Please login to continue", 401));
  if (isSelfServiceOnly(req.user)) {
    return next(new ErrorHandler("This is for office staff — an employee login cannot do it", 403));
  }
  return next();
}

module.exports = { staffOnly };

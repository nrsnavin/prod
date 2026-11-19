"use strict";
// ══════════════════════════════════════════════════════════════════
//  WHEN A HANDLER CATCHES ITS OWN ERRORS
//
//  Sixty-six handlers — payroll, attendance, leave, jobs, shifts — were
//  written with their own try/catch and answered a failure themselves:
//
//      catch (e) { res.status(500).json({ success: false, message: e.message }) }
//
//  That skipped everything the central error handler does. A bad id was
//  a 500 with a cast error in it instead of a 400; a crash was read out
//  to the screen word for word; and nothing was reported or, in most of
//  them, even logged — a fault in payroll left no trace on the server.
//
//  sendError hands the error to that same central handler
//  (middleware/error.js), so these routes answer like every other.
// ══════════════════════════════════════════════════════════════════

const errorHandler = require("../middleware/error");
const ErrorHandler = require("./ErrorHandler");

/**
 * Answer `err` the way the app answers every error.
 *
 * @param {string} [fallback] what the route was doing ("Failed to build
 *        MRP"): said in place of an unexpected failure's own text, with
 *        the reference. An error the route or a service raised on
 *        purpose (an ErrorHandler, anything with a status) keeps its own
 *        words, and a bad id or a failed validation is still a 400.
 */
function sendError(req, res, err, fallback) {
  const failure = err instanceof Error ? err : new Error(String(err ?? "Unknown error"));
  if (fallback && !(failure instanceof ErrorHandler) && !failure.statusCode) failure.publicMessage = fallback;
  return errorHandler(failure, req, res, () => {});
}

/**
 * For a handler's own `catch`: what to hand to next().
 *
 * A number of handlers ended `catch (err) { next(new ErrorHandler(
 * err.message, 400)) }`. That is right for a rule a service states as a
 * plain Error ("Nylon 70D has no price") — the caller can fix it, and
 * its own words say how. It is wrong for everything else that lands in
 * the same catch: a crash ("Cannot read properties of undefined") or the
 * database driver's complaint was read out to the screen as though the
 * person at it had typed something wrong, with no reference and nothing
 * reported — exactly what middleware/error.js exists to stop.
 *
 *   • said on purpose (an ErrorHandler, anything with a status): as it is
 *   • a fault of ours, or something the central handler already has
 *     words for (a bad id, a failed validation, a duplicate key, a stale
 *     version): passed on untouched, so it answers it
 *   • anything else: the caller's to fix, in the error's own words
 */
function asCallerError(err, status = 400) {
  if (err instanceof ErrorHandler || err?.statusCode) return err;
  if (errorHandler.isInternalFault(err)) return err;
  if (["ValidationError", "CastError", "VersionError", "DocumentNotFoundError"].includes(err?.name) || err?.code === 11000) return err;
  return new ErrorHandler(err?.message || "That could not be done", status);
}

module.exports = { sendError, asCallerError };

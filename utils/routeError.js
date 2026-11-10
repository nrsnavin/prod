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

module.exports = { sendError };

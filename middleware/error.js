const ErrorHandler = require("../utils/ErrorHandler");
const { CONFLICT_MESSAGE } = require("../utils/versioning");
const { reportError } = require("../utils/errorReporter");

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || "Internal server Error";

  // Report genuine server faults (5xx) to the error sink BEFORE the
  // status-remapping below rewrites some of them down to 4xx. A stale
  // read that a route surfaced as a 500 is a real fault worth seeing;
  // a VersionError that becomes a 409 is expected traffic and is not
  // reported. Reporting is fail-open and never touches the response.
  if (err.statusCode >= 500) reportError(err, req);

  // Mongoose optimistic-lock failure (doc.increment() + save raced a
  // concurrent write). Same meaning as an expectedVersion mismatch:
  // the caller edited a stale copy → 409, reload and retry.
  if (err.name === "VersionError") {
    err = new ErrorHandler(CONFLICT_MESSAGE, 409);
  }

  // Preserve route-supplied diagnostic fields so the frontend can
  // branch on them (e.g. INSUFFICIENT_STOCK → show force-approve
  // dialog) before any of the recreating branches below swap `err`.
  const routeCode     = err.code;
  const routeShortfall = err.shortfall;
  // Generic escape hatch for anything else a route wants the client to
  // branch on (e.g. WEAVING_NOT_READY → which stage is still open).
  // `shortfall` predates it and stays where callers already look.
  const routeDetails  = err.details;

  // wrong mongodb id error
  if (err.name === "CastError") {
    const message = `Resources not found with this id.. Invalid ${err.path}`;
    err = new ErrorHandler(message, 400);
  }

  // Duplicate key error
  if (err.code === 11000) {
    const message = `Duplicate key ${Object.keys(err.keyValue)} Entered`;
    err = new ErrorHandler(message, 400);
  }

  // wrong jwt error
  if (err.name === "JsonWebTokenError") {
    const message = `Your url is invalid please try again letter`;
    err = new ErrorHandler(message, 400);
  }

  // jwt expired
  if (err.name === "TokenExpiredError") {
    const message = `Your Url is expired please try again letter!`;
    err = new ErrorHandler(message, 400);
  }

  // Surface diagnostic fields only when the route attached them via
  // a string `code` (Mongo's 11000 is numeric and is already mapped
  // above). Keeps the response shape clean for typical errors.
  const payload = {
    success: false,
    message: err.message,
  };
  if (typeof routeCode === "string") payload.code = routeCode;
  if (routeShortfall) payload.shortfall = routeShortfall;
  if (typeof routeCode === "string" && routeDetails) payload.details = routeDetails;

  res.status(err.statusCode).json(payload);
};
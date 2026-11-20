const crypto = require("crypto");
const ErrorHandler = require("../utils/ErrorHandler");
const { CONFLICT_MESSAGE } = require("../utils/versioning");
const { reportError } = require("../utils/errorReporter");

// ── A fault of ours is not something to read out ───────────────────
// Whatever went wrong was sent to the screen in its own words. For a
// rule a route states on purpose that is right. For a crash it is not:
// "Cannot read properties of undefined (reading 'gstin')" helps nobody
// at a loom, and "connect ECONNREFUSED 10.0.1.5:27017" or a driver's
// complaint about an index tells a stranger how the server is built.
//
// An internal fault — a programming error, the database driver, the
// operating system or the network — is answered with one plain sentence
// and a reference. The reference is on the log line that holds the real
// error (utils/errorReporter.js), so "it said ref 4F2A91C0" is enough to
// find it.
const PROGRAMMING = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
const SYSTEM_CODE = /^(E(CONN\w+|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH|ACCES|NOENT|MFILE|NOSPC|PERM|EXIST|ISDIR|BUSY)|ERR_\w+)$/;

function isInternalFault(err) {
  if (!err || err instanceof ErrorHandler) return false; // said on purpose
  if (PROGRAMMING.some((T) => err instanceof T)) return true;
  const name = String(err.name || "");
  if (/^Mongo/.test(name)) return true; // the driver, and the ODM's own errors
  if (typeof err.syscall === "string") return true;
  return typeof err.code === "string" && SYSTEM_CODE.test(err.code);
}

/** What an upload refused by its own limits means, in words. */
function uploadProblem(err) {
  if (err.code === "LIMIT_FILE_SIZE") return ["That file is too large to upload.", 413];
  if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return ["Too many files, or a file where none was expected.", 400];
  if (err.code === "LIMIT_FIELD_VALUE" || err.code === "LIMIT_FIELD_KEY" || err.code === "LIMIT_FIELD_COUNT" || err.code === "LIMIT_PART_COUNT") {
    return ["That form is larger than this accepts.", 400];
  }
  return ["The upload could not be read. Try again.", 400];
}

const GENERIC = "Something went wrong on the server, and it has been logged.";
const newRef = () => crypto.randomBytes(4).toString("hex").toUpperCase();
const withRef = (said, ref) => `${said} Try again — if it keeps happening, give the administrator this reference: ${ref}.`;

function respond(err, req, res, next) {
  // Something thrown that is not an error at all (a bare string).
  if (!err || typeof err !== "object") err = new Error(String(err));

  // The answer has already started (a download that failed part-way):
  // there is nothing left to say on it. Logged, and handed to Express,
  // which closes the connection.
  if (res.headersSent) {
    reportError(err, req);
    return next(err);
  }

  err.statusCode = err.statusCode || 500;
  err.message = err.message || "Internal server Error";

  // An upload refused by its own limits (a file over the route's size, one
  // file too many) is the caller's to fix, not a crash to report. Routes
  // that say it in their own words do so before it gets here.
  if (err.name === "MulterError") {
    const [message, status] = uploadProblem(err);
    const code = err.code;
    err = new ErrorHandler(message, status);
    err.code = code;
  }

  // A document that failed its schema (a required field left out, a value
  // out of range) is the caller's mistake, not a crash: said plainly, 400.
  if (err.name === "ValidationError" && err.errors && err.statusCode === 500) {
    const first = Object.values(err.errors)[0];
    const field = first?.path ? String(first.path).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " ").toLowerCase() : "a field";
    const message = first?.kind === "required" ? `${field[0].toUpperCase()}${field.slice(1)} is required`
      : first?.kind === "enum" ? `${first.value} is not an allowed ${field}`
        : first?.message || "Some details are not valid";
    err = new ErrorHandler(message, 400);
  }

  // Kept before any of the branches below swap `err` for a plainer one:
  // it is what gets logged, and what says whether the fault is ours.
  const fault = err;

  // Mongoose optimistic-lock failure (doc.increment() + save raced a
  // concurrent write). Same meaning as an expectedVersion mismatch:
  // the caller edited a stale copy → 409, reload and retry.
  if (err.name === "VersionError") {
    err = new ErrorHandler(CONFLICT_MESSAGE, 409);
  }
  // A save made conditional (utils/conditionalSave.js, or a document
  // whose $where no longer matched) found the record changed: the same
  // meaning, so the same answer, rather than a 500.
  if (err.name === "DocumentNotFoundError") {
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

  // A read that hit its time limit (models/plugins/queryTimeLimit.js).
  // Not the caller's fault and not a crash: the database gave up on it.
  if (err.code === 50 || err.codeName === "MaxTimeMSExpired") {
    err = new ErrorHandler(
      "This took too long to work out. Try a shorter date range, or try again in a minute.",
      503
    );
  }

  // Duplicate key error. One save names the field on the error itself;
  // a save of several rows at once names it on the first row refused, or
  // nowhere — and reading the keys of nothing threw from in here.
  if (err.code === 11000) {
    const first = err.writeErrors?.[0];
    const dup = err.keyValue || first?.err?.keyValue || first?.keyValue;
    const fields = dup && typeof dup === "object" ? Object.keys(dup) : [];
    const message = fields.length
      ? `Duplicate key ${fields} Entered`
      : "That is already on record, so it was not saved again.";
    err = new ErrorHandler(message, 400);
  }

  // A token that does not verify, wherever it surfaced. Sessions answer
  // for themselves in utils/session.js; this is the backstop, and it is
  // a 401 for the same reason: every client sends a 401 back to sign in,
  // where a 400 about "your url" left people staring at an error.
  if (err.name === "JsonWebTokenError") {
    err = new ErrorHandler("Session is invalid — please login again", 401);
  }
  if (err.name === "TokenExpiredError") {
    err = new ErrorHandler("Your session has expired. Please login again.", 401);
  }

  // Only now is it known what this is, so only now is it reported. This
  // used to run first, when everything without a status was still a 500:
  // every stale form (409), id that is not one (400), entry that already
  // exists (400) and ended session (401) was written to the error log
  // with a stack, and the real faults were somewhere among them.
  // Reporting is fail-open and never touches the response.
  const ref = err.statusCode >= 500 ? newRef() : null;
  if (ref) reportError(fault, req, ref);

  // Still a 500 after all of that, and not something a route said on
  // purpose: our fault. The reference, not the text.
  // (`publicMessage`: a route that catches its own errors names what it
  // was doing — utils/routeError.js — and that is said instead.)
  if (err.statusCode >= 500 && err === fault && (isInternalFault(fault) || fault.publicMessage)) {
    const said = fault.publicMessage
      ? `${String(fault.publicMessage).replace(/[.!\s]+$/, "")}.`
      : GENERIC;
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      ref,
      message: withRef(said, ref),
    });
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
  if (ref) payload.ref = ref;

  return res.status(err.statusCode).json(payload);
}

// ── The handler must not be the thing that fails ───────────────────
// Whatever is thrown in here goes to Express's own last-resort page,
// which prints the stack and the server's file paths unless NODE_ENV is
// exactly "production" — and this server runs as "PRODUCTION". So a
// failure of the handler is answered here too: the one sentence, a
// reference, and both errors on the log under it.
module.exports = (err, req, res, next) => {
  try {
    return respond(err, req, res, next);
  } catch (inner) {
    const ref = newRef();
    reportError(inner, req, ref);
    reportError(err, req, ref);
    if (res.headersSent) return next(inner);
    try {
      return res.status(500).json({ success: false, code: "SERVER_ERROR", ref, message: withRef(GENERIC, ref) });
    } catch (_) {
      return next(inner);
    }
  }
};

module.exports.isInternalFault = isInternalFault;
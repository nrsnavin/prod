'use strict';
// Optimistic locking for user-edited documents.
//
// Two admins open the same PO; both edit; both save. Without a version
// check the second save silently overwrites the first (last write wins,
// no trace). With it, the client sends the __v it loaded as
// `expectedVersion`; if the document has moved on, the edit is rejected
// with a 409 and the user reloads instead of clobbering.
//
// Opt-in and backward compatible: requests without expectedVersion
// behave exactly as before, so old app builds keep working while the
// clients roll out.
//
// Usage inside an edit route (ideally within its transaction):
//   const order = await Order.findById(id).session(session);
//   assertVersion(order, req);       // throws 409 on stale version
//   ...mutate...
//   order.increment();               // bump __v so the next editor sees it
//   await order.save({ session });

const ErrorHandler = require("./ErrorHandler");

const CONFLICT_MESSAGE =
  "This record was changed by someone else while you were editing. " +
  "Reload to see the latest version, then apply your change again.";

/**
 * The one shape of a version conflict: 409, the explanatory message, and
 * a machine-readable code so a client can tell it from other 409s this
 * API sends (a machine's HOOKS_EXCEED_MACHINE confirmation, say).
 */
function conflictError(expectedVersion, currentVersion) {
  const err = new ErrorHandler(CONFLICT_MESSAGE, 409);
  err.code = "VERSION_CONFLICT";
  err.meta = { expectedVersion, currentVersion };
  return err;
}

/**
 * Throws a 409 ErrorHandler when the request carries an expectedVersion
 * that no longer matches the document's __v. No-op when the client
 * didn't send one (legacy callers).
 */
function assertVersion(doc, req) {
  const raw = req?.body?.expectedVersion ?? req?.query?.expectedVersion;
  if (raw === undefined || raw === null || raw === "") return;
  const expected = Number(raw);
  if (!Number.isInteger(expected)) {
    throw new ErrorHandler("expectedVersion must be an integer", 400);
  }
  const actual = Number(doc?.__v ?? 0);
  if (expected !== actual) throw conflictError(expected, actual);
}

/**
 * The version the client says it edited, or null when it sent none.
 * Throws 400 on a value that is not a whole number.
 */
function expectedVersionOf(req) {
  const raw = req?.body?.expectedVersion ?? req?.query?.expectedVersion;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ErrorHandler("expectedVersion must be an integer", 400);
  }
  return n;
}

// ══════════════════════════════════════════════════════════════════
//  COMPARE-AND-SET FOR UPDATE-STYLE ROUTES
//
//  assertVersion above suits load → check → save. Routes that write
//  with findOneAndUpdate / findByIdAndUpdate never load first, so the
//  check has to live IN the write: the version goes into the filter and
//  the write bumps it, all in one atomic operation — there is no window
//  between checking and writing for a second editor to land in.
//
//    const doc = await Model.findOneAndUpdate(
//      { _id: id, ...versionFilter(req) },
//      { $set: changes, ...bumpVersion() },
//      { new: true }
//    );
//    if (!doc) await explainMiss(Model, id, req, "Customer not found");
//
//  The bump happens on EVERY write, versioned or not: an old client that
//  sends no version must still move the version on, or a new client that
//  loaded before it would overwrite its edit unchallenged.
// ══════════════════════════════════════════════════════════════════

/** `{ __v: n }` when the client sent a version, `{}` otherwise. */
function versionFilter(req) {
  const v = expectedVersionOf(req);
  return v === null ? {} : { __v: v };
}

/** Spread into an update so every write moves the version on. */
const bumpVersion = () => ({ $inc: { __v: 1 } });

/**
 * A conditional write matched nothing: say why. 404 when the document
 * is gone; 409 with both versions when it exists but moved on.
 */
async function explainMiss(Model, id, req, notFoundMessage = "Not found") {
  const current = await Model.findById(id).select("__v").lean();
  if (!current) throw new ErrorHandler(notFoundMessage, 404);
  throw conflictError(expectedVersionOf(req), Number(current.__v ?? 0));
}

module.exports = {
  assertVersion, CONFLICT_MESSAGE, conflictError,
  expectedVersionOf, versionFilter, bumpVersion, explainMiss,
};

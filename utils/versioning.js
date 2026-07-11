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
  if (expected !== actual) {
    const err = new ErrorHandler(CONFLICT_MESSAGE, 409);
    err.meta = { expectedVersion: expected, currentVersion: actual };
    throw err;
  }
}

module.exports = { assertVersion, CONFLICT_MESSAGE };

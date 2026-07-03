'use strict';
//
// Minimal NoSQL-injection guard. Strips any object key that starts
// with `$` (a Mongo query/update operator) or contains a `.` (dotted
// path into a subdocument) from req.body, req.query, and req.params.
//
// This neutralises the whole class of operator-injection payloads —
// e.g. { "email": { "$gt": "" } } on login, or
// { "$rename": {...} } / { "$unset": {...} } smuggled into a
// findByIdAndUpdate — without a third-party dependency. It runs once,
// app-wide, before any route handler.
//
// Chosen over `express-mongo-sanitize` (unmaintained, and its in-place
// req.query reassignment breaks on newer Express) because it's ~20
// auditable lines and mutates keys in place, which is safe on the
// Express 4 request objects used here.
//
// It deletes offending keys rather than replacing the character, so a
// legitimate value that merely *contains* a dot (e.g. a filename in a
// string VALUE) is untouched — only KEYS are inspected.

function _clean(obj, depth = 0) {
  if (depth > 20 || obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) _clean(item, depth + 1);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete obj[key];
      continue;
    }
    _clean(obj[key], depth + 1);
  }
}

module.exports = function sanitizeMongo(req, _res, next) {
  // req.body and req.params are plain writable objects. req.query is
  // writable on Express 4 (it becomes a getter only on Express 5).
  if (req.body)   _clean(req.body);
  if (req.query)  _clean(req.query);
  if (req.params) _clean(req.params);
  next();
};

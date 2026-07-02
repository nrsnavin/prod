'use strict';
//
// Escape a user-supplied string so it can be used as a LITERAL inside
// a Mongo `$regex` without the caller being able to inject regex
// metacharacters. Unescaped user input in `$regex` is both a
// correctness bug (a `.` matches any char) and a ReDoS vector —
// a pattern like `(a+)+$` causes catastrophic backtracking and pins
// the server. We also cap length to bound the work per query.

function escapeRegex(input, maxLen = 100) {
  const s = String(input == null ? "" : input).slice(0, maxLen);
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };

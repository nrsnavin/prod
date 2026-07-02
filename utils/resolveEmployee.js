'use strict';
//
// Resolve the employee an authenticated request is allowed to act as.
//
// Worker-facing write routes (file a complaint, request leave/advance,
// record wastage) historically took `employeeId` straight from the
// body, so any logged-in worker could act as a coworker by swapping
// the id. This centralises the rule:
//
//   - admin  → may act on behalf of anyone; uses body.employeeId,
//              falling back to their own linked employee.
//   - worker → always pinned to their OWN linked employee
//              (req.user.employee); the body value is ignored.
//
// Returns a string employee id, or null when it can't be determined
// (worker with no linked employee) — the caller should 403 on null.

function resolveEmployeeId(req) {
  const bodyId = req.body?.employeeId;
  if (req.user?.role === "admin") {
    const id = bodyId || req.user?.employee;
    return id ? String(id) : null;
  }
  return req.user?.employee ? String(req.user.employee) : null;
}

module.exports = { resolveEmployeeId };

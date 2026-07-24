"use strict";
//
// Department ⇄ backend-role mapping.
//
// The web app groups users into four shop-floor departments plus an
// owner/admin. The backend RBAC gates (middleware/auth.js isAdmin +
// app.js gate(...)) work off the coarser `role` strings. The ONLY live
// roles are admin / production / accounts — those are all that
// roleForDepartment can produce. The historical `sales` and `stores`
// roles are RETIRED: no department maps to them, so app.js no longer
// gates on them (they'd only ever match a pre-migration legacy account
// that still carries the raw role). A user's `department` drives what
// they SEE (web nav + route guards); their derived `role` drives what
// the API lets them DO.
//
// preparatory / weaving / packing all map to `production` — the backend
// can't tell them apart (accepted trade-off of "map onto existing
// roles"); the web separates them by department. finance maps to
// `accounts`, and the finance-area gates (DC, materials, supplier/PO,
// payroll) accept `accounts`.

const DEPARTMENTS = ["admin", "preparatory", "weaving", "packing", "finance"];

const DEPARTMENT_ROLE = {
  admin:       "admin",
  preparatory: "production",
  weaving:     "production",
  packing:     "production",
  finance:     "accounts",
};

// Derive the backend role for a department. Unknown/empty department
// falls back to the department string itself so pre-existing users who
// already carry a raw role (e.g. "admin", "stores") keep working.
function roleForDepartment(department) {
  return DEPARTMENT_ROLE[department] || department || "";
}

function isDepartment(d) {
  return DEPARTMENTS.includes(d);
}

module.exports = { DEPARTMENTS, DEPARTMENT_ROLE, roleForDepartment, isDepartment };

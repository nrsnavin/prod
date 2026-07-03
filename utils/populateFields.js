'use strict';
//
// Shared Mongoose `populate` projection strings. These existed as
// hand-retyped literals scattered across routes and had already
// drifted out of sync — e.g. the employee card was populated as
//   'name department role hourlyRate'          (bonus.js)
//   'name department phoneNumber role hourlyRate' (user.js)
//   'name department role phoneNumber hourlyRate' (payroll.js)
// — same intent, three orderings, easy to miss a field. Centralising
// them gives one source of truth so a projection change lands
// everywhere at once.
//
// Field ORDER is irrelevant to Mongoose; these are chosen for
// readability. Add fields here, not at call sites.

// The standard "employee card" shown alongside payroll / bonus /
// attendance rows.
const EMPLOYEE_CARD_FIELDS = 'name department phoneNumber role hourlyRate';

// A lighter employee reference where only identity is needed.
const EMPLOYEE_MINI_FIELDS = 'name department';

// Customer reference on orders / jobs / DCs.
const CUSTOMER_CARD_FIELDS = 'name phoneNumber gstin contactName';

module.exports = {
  EMPLOYEE_CARD_FIELDS,
  EMPLOYEE_MINI_FIELDS,
  CUSTOMER_CARD_FIELDS,
};

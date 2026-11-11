'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYSLIP LINES THAT EXPLAIN, AND ARE NOT MONEY
//
//  Two kinds of line on a payslip carry an amount that is not taken
//  from anybody:
//
//    "Absent — pay lost (DAY 2026-06-03)"   −1,200
//        the shift was never credited in the first place;
//    "Late deduction 20m (DAY 2026-06-04)"     −33
//        the shift line beside it is already that much less.
//
//  They say why the month came to what it did. Read as deductions they
//  are counted twice: the employee ledger posted every line, so a month
//  with one absence, paid in full, left the worker owing a shift's pay,
//  and the payslip's own Total row did not come to its net pay.
//
//  Slips worked out from now on mark these lines (`memo: true`); the
//  ones already stored are known by how they start.
// ══════════════════════════════════════════════════════════════════

const MEMO_LABEL = /^(Absent —|Late deduction )/;

//  A third kind is money, but not money that moves between the factory
//  and the worker:
//
//    "Advance Salary Recovery ₹600"                     −600
//    "Advance recovered at payment Rs.600"              −600
//    "Advance recovery capped — ₹200 carried to next month"  +200
//
//  An advance is on the ledger from the day the cash was handed over
//  (−600: the worker owes it). Recovering it is not a second event — it
//  is why the salary then paid in cash is 600 less. The ledger posted
//  the recovery as well, and in opposite directions on its two paths:
//  recovered through the payslip, a settled month left the worker owing
//  the advance a second time; recovered at payment, it left the factory
//  owing it back. These lines stay on the slip (they are why net pay is
//  what it is) and out of the ledger.
const SET_OFF_LABEL = /^(Advance Salary Recovery|Advance recovered at payment|Advance recovery capped)/;

//  And one line is money the factory gives up. When a month's
//  deductions come to more than its pay, net pay stops at ₹0 and the
//  rest is written off (the owner's decision): nothing is carried into
//  next month, and the worker is not left owing it. The slip says so in
//  a line of its own, so its lines still come to its net pay, and the
//  employee ledger, which posts them, does not carry the excess.
const WRITE_OFF_LABEL = 'Deductions beyond this month\'s pay, written off';
const WRITE_OFF = /^Deductions beyond this month's pay, written off/;

/** True for the line that writes off deductions beyond the month's pay. */
const isWriteOffLine = (line) => !!line && WRITE_OFF.test(String(line.label || ''));

/** True for a line that explains the figures without being one. */
function isMemoLine(line) {
  if (!line) return false;
  return line.memo === true || MEMO_LABEL.test(String(line.label || ''));
}

/** The lines that are money: what was earned, added and taken off. */
const moneyLines = (lines) => (lines || []).filter((l) => !isMemoLine(l));

/** True for an advance set off against pay: money, but none changing hands. */
const isSetOffLine = (line) => !!line && SET_OFF_LABEL.test(String(line.label || ''));

/**
 * The lines that change what the factory owes the worker — what the
 * employee ledger posts. Not the explanations, and not an advance being
 * set off, which the ledger already carries from the day it was paid out.
 */
const ledgerLines = (lines) => moneyLines(lines).filter((l) => !isSetOffLine(l));

module.exports = {
  isMemoLine, isSetOffLine, isWriteOffLine, moneyLines, ledgerLines,
  MEMO_LABEL, SET_OFF_LABEL, WRITE_OFF, WRITE_OFF_LABEL,
};

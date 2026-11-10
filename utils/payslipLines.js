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

/** True for a line that explains the figures without being one. */
function isMemoLine(line) {
  if (!line) return false;
  return line.memo === true || MEMO_LABEL.test(String(line.label || ''));
}

/** The lines that are money: what was earned, added and taken off. */
const moneyLines = (lines) => (lines || []).filter((l) => !isMemoLine(l));

module.exports = { isMemoLine, moneyLines, MEMO_LABEL };

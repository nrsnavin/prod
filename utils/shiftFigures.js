'use strict';
//
// Reading the numbers off a ShiftDetail.
//
// Shared by the machine detail page and the shift-plan summary, which both
// need "what did this shift actually make" and were previously computing it
// separately — one of them wrongly. Keeping it here means the two can't
// drift apart again.

/** Both DAY and NIGHT run 12h, so efficiency is measured against 720 min. */
const SHIFT_MINUTES = 720;

/**
 * Convert an "HH:MM[:SS]" timer string to minutes.
 * Returns 0 for null/undefined/garbage rather than NaN.
 */
function clockToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts   = timeStr.split(':').map(Number);
  const hours   = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minutes = Number.isFinite(parts[1]) ? parts[1] : 0;
  return hours * 60 + minutes;
}

/**
 * A shift's timer and metres.
 *
 * Two traps here, both of which have bitten:
 *
 *  1. The field is `productionMeters`. Reading `shift.production` — which
 *     does not exist on the schema — silently yields 0, so a busy shift
 *     reports no output at all.
 *  2. Until an admin verifies a shift, the operator's numbers live in the
 *     `submitted*` fields and only cascade into the canonical ones on
 *     verification. Reporting the canonical 0 for a shift that has already
 *     been submitted makes a running machine look idle, so fall back to
 *     what was submitted and let the caller surface `status`.
 */
function shiftFigures(shift) {
  const verified = shift?.status === 'closed';
  const timer =
    !verified && shift?.submittedTimer ? shift.submittedTimer : shift?.timer;
  const meters =
    !verified && Number.isFinite(shift?.submittedProductionMeters)
      ? shift.submittedProductionMeters
      : shift?.productionMeters;
  return { timer, meters: Number.isFinite(meters) ? meters : 0 };
}

/** Metres produced across a list of shift details. */
function totalMeters(shifts) {
  return (shifts || []).reduce((sum, s) => sum + shiftFigures(s).meters, 0);
}

module.exports = { shiftFigures, clockToMinutes, totalMeters, SHIFT_MINUTES };

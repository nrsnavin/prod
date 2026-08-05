'use strict';
//
// OUTSOURCED JOB-WORK RECORD
//
// An outsourced job runs no shifts here, so it produces none of the usual
// production trail. This record is that trail: what went to the vendor,
// what came back, the yield agreed with them, and when it returned.
//
// The job may not move to `finishing` until the reconciliation fields are
// filled, because `finishing` is the point of no return — production and
// the outsource toggle both close there (utils/productionLock.js), so a
// blank record at that moment stays blank for good.
//
// One definition, shared by the finishing gate and the UI, so the form
// and the server can't disagree about what "complete" means.

// The fields that must be present to close out a vendor job. Efficiency
// alone would be an unverifiable hand-typed number; sent and received let
// it be cross-checked and give the shortfall, and the return date gives
// vendor lead time.
const REQUIRED_FIELDS = Object.freeze([
  { key: 'qtySentMeters',     label: 'Quantity sent (m)' },
  { key: 'qtyReceivedMeters', label: 'Quantity received (m)' },
  { key: 'efficiencyPct',     label: 'Efficiency (%)' },
  { key: 'actualReturnDate',  label: 'Actual return date' },
  { key: 'notes',             label: 'Notes' },
]);

const isBlank = (v) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// Returns the human-readable reasons this record is not yet closeable.
// Empty array = complete. Mirrors the frontend's outsourcing.ts.
function outsourcingBlockers(rec) {
  const r = rec || {};
  const blockers = [];

  for (const { key, label } of REQUIRED_FIELDS) {
    if (isBlank(r[key])) blockers.push(`${label} is required`);
  }

  // Present-but-nonsense is as unusable as missing, and far more likely
  // to be believed later, so the same gate rejects it.
  const sent = Number(r.qtySentMeters);
  const recv = Number(r.qtyReceivedMeters);
  const eff  = Number(r.efficiencyPct);

  if (!isBlank(r.qtySentMeters) && !(sent > 0)) {
    blockers.push('Quantity sent must be greater than 0');
  }
  if (!isBlank(r.qtyReceivedMeters) && !(recv >= 0)) {
    blockers.push('Quantity received cannot be negative');
  }
  if (!isBlank(r.efficiencyPct) && !(eff > 0 && eff <= 100)) {
    blockers.push('Efficiency must be between 0 and 100');
  }
  if (!isBlank(r.notes) && String(r.notes).trim().length < 3) {
    blockers.push('Notes must be at least 3 characters');
  }

  return blockers;
}

function isOutsourcingComplete(rec) {
  return outsourcingBlockers(rec).length === 0;
}

// Figures the planner reads rather than types. Kept out of the schema so
// they can never drift from the numbers they are derived from.
function outsourcingDerived(rec) {
  const r = rec || {};
  const sent = Number(r.qtySentMeters);
  const recv = Number(r.qtyReceivedMeters);
  const rate = Number(r.ratePerMeter);

  const hasBoth = Number.isFinite(sent) && Number.isFinite(recv) && sent > 0;

  // The yield the numbers imply, next to the yield that was entered — a
  // gap between them is the thing worth arguing with the vendor about.
  const derivedEfficiencyPct = hasBoth
    ? Math.round((recv / sent) * 1000) / 10
    : null;

  const entered = Number(r.efficiencyPct);
  const efficiencyVariancePct =
    derivedEfficiencyPct !== null && Number.isFinite(entered)
      ? Math.round((entered - derivedEfficiencyPct) * 10) / 10
      : null;

  return {
    shortfallMeters: hasBoth ? Math.round((sent - recv) * 100) / 100 : null,
    derivedEfficiencyPct,
    efficiencyVariancePct,
    jobWorkCost:
      Number.isFinite(rate) && Number.isFinite(recv) ? Math.round(rate * recv * 100) / 100 : null,
    leadTimeDays:
      r.dispatchDate && r.actualReturnDate
        ? Math.max(0, Math.round((new Date(r.actualReturnDate) - new Date(r.dispatchDate)) / 86400000))
        : null,
  };
}

module.exports = {
  REQUIRED_FIELDS,
  outsourcingBlockers,
  isOutsourcingComplete,
  outsourcingDerived,
};

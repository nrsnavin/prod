'use strict';
//
// PRODUCTION LOCK
//
// Moving a job to `finishing` RELEASES its machine (api/job.js sets
// machineReleased when the next status is 'finishing') — the cloth is off
// the loom. From that point nothing can legitimately be produced against
// the job, so recording, correcting or verifying production would write
// output that never happened, and flipping it to outsourced would rewrite
// how work that is already done was made.
//
// One definition, used by every write path, so the rule can't drift
// between the worker's submit, the admin's correction and the outsource
// toggle.

const ErrorHandler = require('./ErrorHandler');

// Everything from `finishing` onward. `cancelled` is included for the
// obvious reason: a cancelled job is not producing either.
const PRODUCTION_LOCKED_STATUSES = Object.freeze([
  'finishing', 'checking', 'packing', 'completed', 'cancelled',
]);

function isProductionLocked(status) {
  return PRODUCTION_LOCKED_STATUSES.includes(String(status || ''));
}

// Resolves the job a shift belongs to. ShiftDetail.job defaults to null,
// so fall back to the order the machine was running — the same fallback
// the Shifts screens use to label the row, which keeps the guard and the
// displayed job number talking about the same job.
async function jobForShift(shift, models) {
  const { JobOrder, Machine } = models;
  if (shift?.job) {
    return JobOrder.findById(shift.job).select('jobOrderNo status');
  }
  if (shift?.machine) {
    const machine = await Machine.findById(shift.machine).select('orderRunning');
    if (machine?.orderRunning) {
      return JobOrder.findById(machine.orderRunning).select('jobOrderNo status');
    }
  }
  return null;
}

// Throws when the job is past production. `action` completes the sentence
// "Cannot <action> …" so the message names what was refused.
//
// A shift with no resolvable job is NOT blocked: that is pre-existing data
// (ShiftDetail.job is nullable and older rows predate the ref), and
// refusing it would break entry for shifts that never had a job at all.
function assertProductionOpen(job, action = 'record production') {
  if (!job) return;
  if (!isProductionLocked(job.status)) return;
  const label = job.jobOrderNo ? `J-${job.jobOrderNo}` : 'this job';
  throw new ErrorHandler(
    `Cannot ${action} — ${label} has moved to ${job.status}. ` +
    `Production closes once a job leaves the loom.`,
    409
  );
}

// Convenience for the shift routes: resolve then assert in one step.
async function assertShiftProductionOpen(shift, models, action) {
  const job = await jobForShift(shift, models);
  assertProductionOpen(job, action);
  return job;
}

module.exports = {
  PRODUCTION_LOCKED_STATUSES,
  isProductionLocked,
  jobForShift,
  assertProductionOpen,
  assertShiftProductionOpen,
};

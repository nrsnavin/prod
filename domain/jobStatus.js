'use strict';
//
// Single source of truth for JobOrder status: the ordered stage list,
// the linear transition table, the per-stage (by/at) timestamp fields,
// and the small pure helpers that operate on them.
//
// Before this module the same stage knowledge was re-encoded in three
// places in api/job.js — the STATUS_TRANSITIONS map, the
// STAGE_FINGERPRINT (by/at) map, and a separate status→timestamp
// `switch` in GET /stale. Adding or reordering a stage meant editing
// every copy (an OCP violation). Now a stage change lands here once.
//
// Everything is pure (no DB, no Express) so it's unit-testable in
// isolation and reusable by any route.

const JOB_STATUSES = [
  'preparatory', 'weaving', 'finishing', 'checking', 'packing', 'completed', 'cancelled',
];

// Linear production flow. Keys are the "from" status; the value is the
// only status /update-status may advance them to. Terminal statuses
// (completed, cancelled) are intentionally absent — they cannot advance.
const STATUS_TRANSITIONS = Object.freeze({
  preparatory: 'weaving',
  weaving:   'finishing',
  finishing: 'checking',
  checking:  'packing',
  packing:   'completed',
});

// Transitions the pure state machine cannot decide on its own because
// they depend on other documents. `validateTransition` says the move is
// SHAPED right; the route named here must still prove the precondition
// holds before writing the status.
//
// preparatory → weaving is gated on the job's warping AND covering both
// being completed (services/weavingReadiness.js). Listing it here keeps
// the gate visible from the state machine instead of hiding as an `if`
// buried in a route — a later stage needing a precondition adds a line.
const GATED_TRANSITIONS = Object.freeze({
  preparatory: 'weaving-readiness',
});

// Per-stage audit fields on the JobOrder document.
const STAGE_TIMESTAMPS = Object.freeze({
  weaving:   { by: 'weavingBy',   at: 'weavingAt'   },
  finishing: { by: 'finishingBy', at: 'finishingAt' },
  checking:  { by: 'checkingBy',  at: 'checkingAt'  },
  packing:   { by: 'packingBy',   at: 'packingAt'   },
  completed: { by: 'completedBy', at: 'completedAt' },
  cancelled: { by: 'cancelledBy', at: 'cancelledAt' },
});

// The status a job in `current` may advance to, or null if none.
function nextStatus(current) {
  return STATUS_TRANSITIONS[current] || null;
}

// Validate a requested transition. Returns { ok: true } or
// { ok: false, message } with the SAME messages the route used
// inline, so behaviour (and the characterization tests) is preserved.
function validateTransition(current, target) {
  const expected = STATUS_TRANSITIONS[current];
  if (!expected) {
    return { ok: false, message: `Job in status "${current}" cannot advance further` };
  }
  if (expected !== target) {
    return { ok: false, message: `Invalid transition: "${current}" → "${target}". Expected: "${expected}"` };
  }
  return { ok: true, expected, gate: GATED_TRANSITIONS[current] || null };
}

// Stamp the per-stage (by/at) audit fields on a job document for the
// given stage. No-op for a stage with no timestamp mapping.
function stampStage(job, stage, userId) {
  const f = STAGE_TIMESTAMPS[stage];
  if (f) {
    job[f.by] = userId || null;
    job[f.at] = new Date();
  }
}

// The timestamp field name a job "entered" its current status — used
// by staleness checks. Falls back to null when the status has no
// stage timestamp (preparatory), so callers use createdAt.
function enteredAtField(status) {
  return STAGE_TIMESTAMPS[status]?.at || null;
}

module.exports = {
  JOB_STATUSES,
  STATUS_TRANSITIONS,
  GATED_TRANSITIONS,
  STAGE_TIMESTAMPS,
  nextStatus,
  validateTransition,
  stampStage,
  enteredAtField,
};

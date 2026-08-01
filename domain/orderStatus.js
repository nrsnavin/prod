'use strict';
//
// Single source of truth for Order status.
//
// JobOrder has had one of these since the stage refactor
// (domain/jobStatus.js). Order never did — its status was written from
// nine places across three files with no shared rule, and three of those
// writes live in the JOB router, changing the order as a side effect of
// something happening to a job.
//
// That is how an order came back from the dead. Cancelling the last job
// on a CANCELLED order set it to Approved; completing the last job on a
// DELETED one set it to Completed. Neither write asked where the order
// actually was, because there was nowhere to ask.
//
// Everything here is pure — no DB, no Express — so the rule can be
// tested on its own and reused by any writer.

const ORDER_STATUSES = [
  'Open', 'Approved', 'InProgress', 'Completed', 'Cancelled', 'Deleted',
];

// Where an order may go from where it is. Read as: from → the set of
// statuses that are legitimate next steps.
//
// Completed, Cancelled and Deleted are terminal on purpose. An order
// that has been delivered, called off or removed is a matter of record;
// something happening to one of its jobs afterwards is not a reason to
// reopen it, and silently doing so loses the fact that it ever ended.
const ORDER_TRANSITIONS = Object.freeze({
  Open:       Object.freeze(['Approved', 'Cancelled', 'Deleted']),
  // Approved → Completed covers an order whose jobs all finish without
  // production ever being started explicitly.
  Approved:   Object.freeze(['InProgress', 'Completed', 'Cancelled', 'Deleted']),
  // InProgress → Approved is the rollback when the last live job is
  // cancelled: nothing is planned any more, so the order goes back to
  // waiting rather than pretending work is under way.
  InProgress: Object.freeze(['Approved', 'Completed', 'Cancelled']),
  Completed:  Object.freeze([]),
  Cancelled:  Object.freeze([]),
  Deleted:    Object.freeze([]),
});

/** Is `to` a legitimate next status for an order currently at `from`? */
function canTransition(from, to) {
  if (from === to) return false;               // not a move
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

/** True when nothing may follow — useful for "is this order finished". */
function isTerminal(status) {
  return (ORDER_TRANSITIONS[status] || []).length === 0;
}

/**
 * Apply a status to an order document IF the move is legitimate.
 *
 * Written for the cascade callers — a job finishing, a job being
 * cancelled — which are reacting to something else and must not force a
 * status onto an order that has moved on. Returns whether it applied,
 * so the caller can decide whether to stamp a fingerprint for it.
 *
 * The stamps travel with the status. Setting `Completed` without
 * `completedAt` leaves a record nobody can date.
 */
const STAMPS = Object.freeze({
  Approved:   { by: 'approvedBy',  at: 'approvedAt'  },
  InProgress: { by: 'startedBy',   at: 'startedAt'   },
  Completed:  { by: 'completedBy', at: 'completedAt' },
  Cancelled:  { by: 'cancelledBy', at: 'cancelledAt' },
  Deleted:    { by: 'deletedBy',   at: 'deletedAt'   },
});

function applyOrderStatus(order, to, userId = null) {
  if (!order || !canTransition(order.status, to)) return false;
  order.status = to;
  const stamp = STAMPS[to];
  if (stamp) {
    order[stamp.by] = userId || null;
    order[stamp.at] = new Date();
  }
  return true;
}

module.exports = {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  STAMPS,
  canTransition,
  isTerminal,
  applyOrderStatus,
};

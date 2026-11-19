'use strict';
// ══════════════════════════════════════════════════════════════════
//  A HIGH OR CRITICAL MACHINE ISSUE, TOLD TO THE OWNER
//
//  A machine put into maintenance from the office has always gone out
//  as a breakdown alert (api/machine.js). An operator reporting that
//  their loom has stopped told nobody: the issue waited in the list for
//  someone to open it, the next digest, or the shift handover.
//
//  A high or critical issue is sent the same way, under the same event
//  ("machineBreakdown") — one switch for the owner to mute, no new
//  setting. Once an hour a machine at most: a second operator reporting
//  the same stoppage is not news, and the issue itself is still filed.
//
//  Never in the way of the report: the caller sends its answer first.
// ══════════════════════════════════════════════════════════════════

const MachineIssue = require('../models/MachineIssue');
const Machine = require('../models/Machine');
const { notify } = require('../utils/notify');

const URGENT = Object.freeze(['high', 'critical']);
const QUIET_MS = 60 * 60_000;

/**
 * @param {object} issue  the issue just filed (a document or a plain object)
 * @param {{ by?: string, via?: string, actor?: {id?: any, name?: string}|null }} [who]
 * @returns {Promise<object>} what notify() answered, or `{ skipped }`
 */
async function alertIfUrgent(issue, { by = '', via = 'Machine issues', actor = null } = {}) {
  if (!issue || !URGENT.includes(issue.severity)) return { skipped: 'not urgent' };

  // The one before this, on the same machine, inside the hour. Two filed
  // in the same instant are put in order by their ids, so one of them —
  // and only one — goes out.
  const filedAt = issue.createdAt ? new Date(issue.createdAt) : new Date();
  const earlier = await MachineIssue.exists({
    machine: issue.machine,
    severity: { $in: URGENT },
    $or: [
      { createdAt: { $gte: new Date(filedAt.getTime() - QUIET_MS), $lt: filedAt } },
      { createdAt: filedAt, _id: { $lt: issue._id } },
    ],
  });
  if (earlier) return { skipped: 'already told' };

  const machine = await Machine.findById(issue.machine).select('ID').lean();
  return notify('machineBreakdown', {
    machineId: machine?.ID,
    issue: issue.title,
    severity: issue.severity,
    by,
    via,
    _entity: { type: 'Machine', id: issue.machine },
    _actor: actor,
  });
}

module.exports = { alertIfUrgent, URGENT, QUIET_MS };

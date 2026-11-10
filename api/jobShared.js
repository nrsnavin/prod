'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — HELPERS MORE THAN ONE JOB FILE USES
// ══════════════════════════════════════════════════════════════════

/** Whether the machine is loading once this assignment is saved. */
function loadingAfter(req, machine, previousMachineId) {
  if (typeof req.body?.loading === 'boolean') return req.body.loading;
  const sameMachine = previousMachineId != null && String(previousMachineId) === String(machine._id);
  return sameMachine ? !!machine.loading : false;
}

module.exports = {
  loadingAfter,
};

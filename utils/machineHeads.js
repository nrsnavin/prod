'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW MANY HEADS A LOOM IS ACTUALLY RUNNING
//
//  Machine.NoOfHead is how many heads the loom HAS. A job's head plan
//  (Machine.elastics, one { head, elastic } per head) says how many it
//  RUNS: a wide elastic on an 8-head loom may only fit on 6. Production
//  is entered per head, so every total — the shift's metres, the plan's
//  total, the ETA's machine-day rate — multiplies by the heads running,
//  not the heads the machine has. Multiplying by NoOfHead counted two
//  heads' worth of elastic that was never woven.
//
//  A head with no elastic in the plan is FREE: it is not running, and
//  nothing is counted for it — not its metres, not its share of a rate.
// ══════════════════════════════════════════════════════════════════

const carrying = (heads) => (Array.isArray(heads) ? heads : []).filter((h) => h && h.elastic).length;

/**
 * Heads with an elastic in the machine's head plan — free heads not
 * counted, so a plan with every head free runs none. A machine with no
 * plan at all (older data) counts as all its heads.
 */
function headsInUse(machine) {
  const plan = Array.isArray(machine?.elastics) ? machine.elastics : [];
  if (plan.length) return carrying(plan);
  return Math.max(1, Number(machine?.NoOfHead) || 1);
}

/**
 * The heads a VERIFIED shift's productionMeters was multiplied by: the
 * heads it ran (ShiftDetail.headsRun, recorded on verification), or for
 * a shift verified before that was recorded, the machine's head count —
 * which is what it was multiplied by then.
 */
function headsOfShift(shift, machine) {
  return Number(shift?.headsRun) > 0 ? Number(shift.headsRun) : Math.max(1, Number(machine?.NoOfHead) || 1);
}

/**
 * A job's head plan changed on its loom: its shifts not yet verified take
 * the new plan, so what they show — and are later corrected against —
 * is the heads that actually run. Verified shifts keep what they ran.
 */
async function refreshOpenShiftHeads(machine, jobId, session = null) {
  if (!machine?._id || !jobId) return;
  const ShiftDetail = require('../models/ShiftDetail');
  const running = (machine.elastics || []).filter((h) => h && h.elastic)
    .map((h) => ({ head: h.head, elastic: h.elastic._id ?? h.elastic }));
  if (!running.length) return;
  await ShiftDetail.updateMany(
    { machine: machine._id, job: jobId, status: { $in: ['open', 'pending_verification'] } },
    { $set: { elastics: running } },
    { session }
  );
}

module.exports = { headsInUse, headsOfShift, refreshOpenShiftHeads };

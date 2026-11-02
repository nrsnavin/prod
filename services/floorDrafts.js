'use strict';
// ══════════════════════════════════════════════════════════════════
//  PRODUCTION ENTERED ON THE FLOOR BUT NOT VERIFIED YET
//
//  A supervisor's entry sits in ShiftDetail.submitted* with status
//  pending_verification; nothing reaches the job or the order until an
//  admin verifies it (api/shift.js /verify-production), and that is
//  right — a claim and a checked number are not the same fact. But
//  the job and order pages showed only the checked number, so a day's
//  weaving looked like nothing had happened until the office caught up.
//
//  This works out what those pages WOULD show once verified, per
//  elastic, the way the cascade will do it (services/
//  shiftCascadeService.js): the per-head figure, once for every head
//  of the machine's plan that carries the elastic. A machine with no
//  head plan falls back to the shift's own head snapshot; with neither
//  there is nothing to attribute — the cascade would refuse it too.
//
//  Drafts are attributed to the job the shift names, or failing that
//  to the job the machine is running.
// ══════════════════════════════════════════════════════════════════

const ShiftDetail = require('../models/ShiftDetail');
const Machine = require('../models/Machine');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param jobIds  the jobs to look at
 * @returns Map<jobId, { shifts: number, byElastic: Map<elasticId, metres> }>
 */
async function draftedForJobs(jobIds) {
  const ids = [...new Set((jobIds || []).map(String).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, { shifts: 0, byElastic: new Map() }]));
  if (!ids.length) return out;

  const machines = await Machine.find({ orderRunning: { $in: ids } }).select('_id orderRunning elastics').lean();
  const machineById = new Map(machines.map((m) => [String(m._id), m]));
  const or = [{ job: { $in: ids } }];
  if (machines.length) or.push({ machine: { $in: machines.map((m) => m._id) } });

  const pending = await ShiftDetail.find({ status: 'pending_verification', $or: or })
    .select('job machine submittedProductionMeters elastics')
    .lean();

  // A shift's machine may have moved on to another job; the one the
  // shift names wins, the machine's job is only the fallback.
  const needMachines = pending.map((s) => String(s.machine)).filter((id) => !machineById.has(id));
  if (needMachines.length) {
    for (const m of await Machine.find({ _id: { $in: needMachines } }).select('_id orderRunning elastics').lean()) {
      machineById.set(String(m._id), m);
    }
  }

  for (const shift of pending) {
    const machine = machineById.get(String(shift.machine));
    const jobId = shift.job ? String(shift.job) : (machine?.orderRunning ? String(machine.orderRunning) : '');
    const bucket = out.get(jobId);
    if (!bucket) continue;
    bucket.shifts += 1;
    const perHead = Number(shift.submittedProductionMeters) || 0;
    if (!(perHead > 0)) continue;
    const planHeads = (machine?.elastics || []).filter((h) => h && h.elastic);
    const heads = planHeads.length ? planHeads : (shift.elastics || []).filter((h) => h && h.elastic);
    for (const head of heads) {
      const eid = String(head.elastic?._id ?? head.elastic);
      bucket.byElastic.set(eid, round2((bucket.byElastic.get(eid) || 0) + perHead));
    }
  }
  return out;
}

module.exports = { draftedForJobs };

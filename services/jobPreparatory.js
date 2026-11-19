'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WORK THAT WAS PREPARING A JOB, WHEN THE JOB IS CANCELLED
//
//  Raising a job opens a warping programme and a covering programme for
//  it. Cancelling the job used to leave both exactly as they were: still
//  on the warping and covering lists as open work, with nothing on
//  either list to say the job behind them was gone. The floor could go
//  on building beams, issuing yarn and logging covering weights for a
//  job nobody would ever weave.
//
//  A cancelled job is final — nothing brings it back — so its programmes
//  stop with it, by the rules their own cancel routes follow
//  (api/warping.js, api/covering.js):
//
//    • a covering that is not completed is cancelled;
//    • a warping that is not completed is cancelled, UNLESS yarn has been
//      issued on one of its batches. That yarn is physically off the rack
//      and cancelling the batch is the only thing that puts it back, so
//      the warping is left as it is and the caller is told which batches;
//    • what is completed stays completed: the beams exist.
//
//  Changes `job` in memory (its trail) and does not save it — the caller
//  is cancelling the job in the same transaction and saves it once.
// ══════════════════════════════════════════════════════════════════

const Warping      = require('../models/Warping');
const Covering     = require('../models/Covering');
const WarpingBatch = require('../models/WarpingBatch');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');

const STILL_TO_DO = ['open', 'in_progress'];

/**
 * @returns {Promise<{
 *   programmes: { warping: string|null, covering: string|null },
 *   warpingBatches: string[],
 * }>}
 *   For each programme: null when the job has none, 'cancelled' when it
 *   is cancelled (now or already), 'left_open' for a warping with yarn
 *   out, otherwise the status it was left in. `warpingBatches` names the
 *   batches holding a warping open.
 */
async function stopPreparatory(job, { session = null, actor } = {}) {
  const out = { programmes: { warping: null, covering: null }, warpingBatches: [] };
  if (!job?._id) return out;

  // ── Warping ─────────────────────────────────────────────────────
  const warpings = await Warping.find({ job: job._id }).session(session);
  for (const warping of warpings) {
    if (!STILL_TO_DO.includes(warping.status)) {
      out.programmes.warping = out.programmes.warping || warping.status;
      continue;
    }
    const yarnOut = await WarpingBatch.find({
      warping: warping._id,
      status: { $in: ['issued', 'completed'] },
    }).select('batchNo').session(session).lean();

    if (yarnOut.length > 0) {
      out.programmes.warping = 'left_open';
      out.warpingBatches.push(...yarnOut.map((b) => b.batchNo));
      continue;
    }

    const previousStatus = warping.status;
    warping.status = 'cancelled';
    await warping.save({ session });
    job.fingerprints.push(buildFingerprint(ACTION_CODES.WARPING_CANCELLED, {
      entityId: job._id,
      actor,
      meta: {
        warpingId: warping._id.toString(),
        previousStatus,
        becauseJobCancelled: true,
        remarks: 'Job cancelled',
      },
    }));
    if (out.programmes.warping !== 'left_open') out.programmes.warping = 'cancelled';
  }

  // ── Covering ────────────────────────────────────────────────────
  const coverings = await Covering.find({ job: job._id }).session(session);
  for (const covering of coverings) {
    if (!STILL_TO_DO.includes(covering.status)) {
      out.programmes.covering = out.programmes.covering || covering.status;
      continue;
    }
    const previousStatus = covering.status;
    covering.status = 'cancelled';
    await covering.save({ session });
    job.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_CANCELLED, {
      entityId: job._id,
      actor,
      meta: {
        coveringId: covering._id.toString(),
        previousStatus,
        becauseJobCancelled: true,
        remarks: 'Job cancelled',
      },
    }));
    out.programmes.covering = 'cancelled';
  }

  return out;
}

module.exports = { stopPreparatory };

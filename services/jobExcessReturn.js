'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE YARN A JOB DREW FOR ITSELF, WHEN THE JOB IS CANCELLED
//
//  Approving an order draws yarn for what was ordered. A job planned
//  past that draws the yarn for the extra metres when it is raised
//  (services/jobRaise.js) — a JOB_CONSUMPTION row against the job,
//  "Excess planning on J-12 (order #7)".
//
//  Cancelling the job gave none of it back. The yarn stayed "issued" to
//  a job that would never weave, and the app's own advice for a quantity
//  that cannot be edited — "Cancel this job and raise it again at the
//  quantity you want, so the material is drawn once and correctly" —
//  drew it a second time.
//
//  WHAT COMES BACK
//
//  Exactly what was drawn for this job when it was raised, and only
//  when the job has woven nothing. A job that has made metres may have
//  that yarn in the cloth: its draw is left where it is and the caller
//  is told, so somebody decides with the rack in front of them.
//
//  WHAT DOES NOT
//
//  Yarn the stores issued to the job by hand ("Issued to J-12: …",
//  api/rawMaterialStock.js). That is a physical issue somebody made; it
//  carries the order as well as the job, which the raise's own draw
//  never does, and it is told apart by both.
//
//  Changes `job` in memory (its trail) and does not save it — the
//  caller is cancelling the job in the same transaction.
// ══════════════════════════════════════════════════════════════════

const MaterialOutward = require('../models/MaterialOut.cjs');
const ShiftDetail = require('../models/ShiftDetail');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { returnOutwardToStock } = require('./materialReturn');
const { EXCESS_DRAW_REMARK } = require('./orderIssuance');

const sum = (rows) => (rows || []).reduce((t, r) => t + (Number(r?.quantity) || 0), 0);

/** Has the job made anything — verified, packed, or entered and waiting to be verified? */
async function hasWoven(job, session) {
  if (sum(job.producedElastic) > 0 || sum(job.packedElastic) > 0) return true;
  const entered = await ShiftDetail.exists({
    job: job._id,
    $or: [{ productionMeters: { $gt: 0 } }, { submittedProductionMeters: { $gt: 0 } }],
  }).session(session);
  return !!entered;
}

/**
 * @returns {Promise<{
 *   returned: Array<{rawMaterial: string, name: string, quantity: number}>,
 *   kept:     Array<{rawMaterial: string, name: string, quantity: number}>,
 * }>}
 */
async function returnExcessDraw(job, { session = null, actor, userId = null } = {}) {
  const out = { returned: [], kept: [] };
  if (!job?._id) return out;

  const draws = await MaterialOutward.find({
    job:      job._id,
    type:     'JOB_CONSUMPTION',
    reversed: { $ne: true },
    // The raise's own draw: against the job alone, and named as such.
    order:    null,
    remarks:  EXCESS_DRAW_REMARK,
  }).populate('rawMaterial', 'name').session(session);
  if (draws.length === 0) return out;

  const line = (d, quantity) => ({
    rawMaterial: String(d.rawMaterial?._id ?? d.rawMaterial),
    name: d.rawMaterial?.name || '',
    quantity,
  });

  if (await hasWoven(job, session)) {
    out.kept = draws.filter((d) => Number(d.quantity) > 0).map((d) => line(d, Number(d.quantity)));
    return out;
  }

  for (const draw of draws) {
    const shown = line(draw, Number(draw.quantity) || 0);
    // The helper wants the id, not the populated material.
    draw.depopulate('rawMaterial');
    const back = await returnOutwardToStock(session, draw, {
      type:  'JOB_CANCEL_REFUND',
      refNo: job.jobOrderNo != null ? String(job.jobOrderNo) : '',
      userObjectId: userId,
    });
    if (!back) continue;

    job.fingerprints.push(buildFingerprint(ACTION_CODES.RAW_MATERIAL_RESTORED, {
      entityId: job._id,
      actor,
      meta: {
        rawMaterialId:   shown.rawMaterial,
        rawMaterialName: back.material.name,
        quantity:        back.quantity,
        unit:            'kg',
        balanceAfter:    back.balanceAfter,
        reversedFrom:    draw._id.toString(),
        becauseJobCancelled: true,
      },
    }));
    out.returned.push({ ...shown, name: back.material.name, quantity: back.quantity });
  }
  return out;
}

module.exports = { returnExcessDraw, hasWoven };

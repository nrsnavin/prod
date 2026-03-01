'use strict';

/**
 * jobStatusHelper.js
 *
 * Shared utility called by both warping and covering completion routes.
 *
 * LOGIC:
 *   When a job is in "preparatory" status, it cannot start weaving until
 *   BOTH its warping programme AND its covering programme are marked
 *   "completed". This function is called every time either programme
 *   completes. It re-checks the other programme and, if both are done,
 *   advances the job to "weaving" automatically.
 *
 *   The machine assignment happens separately on the frontend after this
 *   auto-transition — the "Assign Machine" button is shown whenever the
 *   job is in "weaving" status but has no machine yet.
 */

const JobOrder = require('../models/JobOrder');
const Warping  = require('../models/Warping');
const Covering = require('../models/Covering');

/**
 * @param {string|ObjectId} jobId
 * @returns {{ advanced: boolean, jobStatus: string }}
 */
async function checkAndAdvanceToWeaving(jobId) {
  const job = await JobOrder.findById(jobId)
    .populate('warping',  'status')
    .populate('covering', 'status');

  if (!job) {
    console.warn(`[jobStatusHelper] Job ${jobId} not found`);
    return { advanced: false, jobStatus: null };
  }

  // Only act if the job is still in preparatory
  if (job.status !== 'preparatory') {
    return { advanced: false, jobStatus: job.status };
  }

  const warpingDone  = job.warping?.status  === 'completed';
  const coveringDone = job.covering?.status === 'completed';

  if (warpingDone && coveringDone) {
    job.status = 'weaving';
    await job.save();

    console.log(
      `[jobStatusHelper] Job #${job.jobOrderNo} auto-advanced ` +
      `"preparatory" → "weaving" (warping ✓  covering ✓)`
    );
    return { advanced: true, jobStatus: 'weaving' };
  }

  // Log which one is still pending
  const pending = [];
  if (!warpingDone)  pending.push('warping');
  if (!coveringDone) pending.push('covering');
  console.log(
    `[jobStatusHelper] Job #${job.jobOrderNo} still preparatory — ` +
    `waiting for: ${pending.join(', ')}`
  );

  return { advanced: false, jobStatus: 'preparatory' };
}

module.exports = { checkAndAdvanceToWeaving };
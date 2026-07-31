'use strict';
//
// Is a job ready to leave preparatory and go to weaving?
//
// The rule the floor works to: a job is prepared when BOTH its warping
// and its covering are finished. utils/jobStatusHelper.js already
// advances the job automatically the moment the second of the two is
// marked completed — but that only fires if the helper is reached with
// both links in place. A job whose covering was created after its
// warping completed, or whose auto-advance ran before the link existed,
// sits in preparatory with nothing to nudge it.
//
// So the same rule is exposed as a check a human can drive: ask to move
// the job to weaving, and either it moves or it says exactly what is
// still open — the status is never quietly changed on an unprepared job.
//
// Pure-ish: takes ids, reads two documents, returns a verdict. No
// Express, no writes.

const JobOrder = require('../models/JobOrder');
const Warping = require('../models/Warping');
const Covering = require('../models/Covering');

/** Human name for a stage document's status, for the blocker message. */
const label = (status) => {
  if (!status) return 'missing';
  return String(status).replace(/_/g, ' ');
};

/**
 * @param {ObjectId|string} jobId
 * @param {mongoose.ClientSession|null} [session] pass when called inside
 *        a transaction so the in-flight warping/covering write is visible.
 * @returns {Promise<{
 *   ready: boolean,
 *   jobStatus: string,
 *   stages: Array<{ stage: string, linked: boolean, status: string|null, done: boolean }>,
 *   blockers: string[],
 * }>}
 */
async function checkWeavingReadiness(jobId, session = null) {
  const withSession = (q) => (session ? q.session(session) : q);

  const job = await withSession(
    JobOrder.findById(jobId).select('status warping covering')
  ).lean();

  if (!job) {
    return {
      ready: false,
      jobStatus: 'unknown',
      stages: [],
      blockers: ['Job not found'],
    };
  }

  const [warping, covering] = await Promise.all([
    job.warping
      ? withSession(Warping.findById(job.warping).select('status')).lean()
      : null,
    job.covering
      ? withSession(Covering.findById(job.covering).select('status')).lean()
      : null,
  ]);

  const stages = [
    { stage: 'warping', doc: warping, linked: Boolean(job.warping) },
    { stage: 'covering', doc: covering, linked: Boolean(job.covering) },
  ].map(({ stage, doc, linked }) => ({
    stage,
    linked,
    // A dangling reference (linked but the document is gone) is not the
    // same as no reference, and the message below says so — silently
    // treating it as "not linked" would hide a broken record.
    status: doc?.status ?? null,
    done: doc?.status === 'completed',
  }));

  const blockers = stages
    .filter((s) => !s.done)
    .map((s) => {
      if (!s.linked) return `No ${s.stage} has been created for this job`;
      if (!s.status) return `The linked ${s.stage} record no longer exists`;
      return `The ${s.stage} is ${label(s.status)}, not completed`;
    });

  return {
    ready: blockers.length === 0,
    jobStatus: job.status,
    stages: stages.map(({ stage, linked, status, done }) => ({
      stage,
      linked,
      status,
      done,
    })),
    blockers,
  };
}

module.exports = { checkWeavingReadiness };

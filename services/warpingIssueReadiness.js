'use strict';
// ══════════════════════════════════════════════════════════════════
//  IS THIS WARPING'S YARN ACTUALLY OFF THE RACK?
//
//  Completing a warping says the beams are built. Beams are built from
//  yarn, and yarn leaves the rack by being issued against a warping
//  batch — that issue is what moves the lot balances and what ties the
//  finished beam to the dye lot inside it.
//
//  Completing without it leaves the lot ledger claiming yarn that is
//  physically gone, and the beam with no lot behind it. The shade trail
//  then has a hole in exactly the place it exists to cover.
//
//  ── Why this is not a blanket refusal ────────────────────────────
//  A programme is allowed to name no lots at all: undyed or untracked
//  yarn has none, and the system has said so since lots were added. If
//  such a warping could never be completed, the rule would strand every
//  job running plain yarn. So the gate only applies where the programme
//  actually committed to lots — where there is something to issue.
// ══════════════════════════════════════════════════════════════════

const WarpingBatch = require('../models/WarpingBatch');
const WarpingPlan = require('../models/WarpingPlan');

/** A batch has drawn its yarn once it is issued; cancelled put it back. */
const ISSUED_STATES = ['issued', 'completed'];

/**
 * Whether a warping may be completed, and why not if not.
 *
 * @param {ObjectId|string} warpingId
 * @param {ClientSession} [session]
 * @returns {Promise<{ready: boolean, reason: string|null,
 *   lotsPlanned: number, batches: {total: number, issued: number,
 *   planned: number, cancelled: number}}>}
 */
async function checkWarpingIssued(warpingId, session) {
  const planQ = WarpingPlan.findOne({ warping: warpingId })
    .select('beams.sections.yarnLot beams.sections.lotNo')
    .lean();
  if (session) planQ.session(session);

  const batchQ = WarpingBatch.find({ warping: warpingId })
    .select('status issuedDate')
    .lean();
  if (session) batchQ.session(session);

  const [plan, batches] = await Promise.all([planQ, batchQ]);

  // How many sections the programme committed to a lot. Snapshot or
  // reference — either means a decision was made and yarn identified.
  let lotsPlanned = 0;
  for (const beam of plan?.beams || []) {
    for (const s of beam.sections || []) {
      if (s.yarnLot || (s.lotNo || '').trim()) lotsPlanned += 1;
    }
  }

  const counts = {
    total: batches.length,
    issued: batches.filter((b) => ISSUED_STATES.includes(b.status)).length,
    planned: batches.filter((b) => b.status === 'planned').length,
    cancelled: batches.filter((b) => b.status === 'cancelled').length,
  };

  // Nothing was ever committed to a lot, so there is nothing to issue.
  // Blocking here would strand every job running untracked yarn.
  if (lotsPlanned === 0) {
    return { ready: true, reason: null, lotsPlanned, batches: counts };
  }

  if (counts.issued > 0) {
    return { ready: true, reason: null, lotsPlanned, batches: counts };
  }

  // Say which of the two it is. "No batch exists" and "a batch exists
  // but nobody issued it" need different things from the operator, and
  // one message covering both would send them looking in the wrong place.
  const reason =
    counts.planned > 0
      ? `${counts.planned} warping batch${counts.planned === 1 ? '' : 'es'} created but not issued — issue the yarn before completing`
      : counts.cancelled > 0
        ? 'every warping batch on this warping was cancelled — the yarn went back on the rack, so nothing has been drawn for these beams'
        : 'no warping batch has been issued — the yarn for these beams has not left the rack';

  return { ready: false, reason, lotsPlanned, batches: counts };
}

module.exports = { checkWarpingIssued, ISSUED_STATES };

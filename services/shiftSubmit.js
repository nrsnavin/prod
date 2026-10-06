'use strict';
// ══════════════════════════════════════════════════════════════════
//  SUBMITTING PRODUCTION FOR VERIFICATION
//
//  The one path that writes submitted metres / run time onto shift
//  entries in a batch: POST /shift/bulk-enter-production, and a
//  production slip read from a photo (services/slipIngest.js). A
//  submitted entry is 'pending_verification' — nothing reaches the job
//  until a supervisor verifies it, so a misread slip is caught there.
//
//  Moved here unchanged from the route so both doors keep the same
//  rules: verified shifts and finalised plans are skipped, and the write
//  is conditional on the entry still not being verified.
// ══════════════════════════════════════════════════════════════════

const ShiftDetail = require('../models/ShiftDetail');
const ShiftPlan = require('../models/ShiftPlan');
const ledger = require('./aiLedger');

/**
 * @param {Array<{id, production, timer?, feedback?}>} entries  validated by the caller
 * @param {{ userId?, aiSuggestionId?, surface? }} opts
 * @returns {Promise<{ saved: Array, skipped: Array }>}
 */
async function submitProduction(entries, { userId, aiSuggestionId, surface = 'shift-sheet-ocr' } = {}) {
  const saved   = [];
  const skipped = [];
  const settledRows = {};

  for (const entry of entries) {
    const { id, production, timer = '00:00:00', feedback = '' } = entry;
    const prodNum = Number(production);

    const sd = await ShiftDetail.findById(id).select('_id status shiftPlan').lean();

    if (!sd) { skipped.push({ id, reason: 'ShiftDetail not found' }); continue; }
    if (sd.status === 'closed') { skipped.push({ id, reason: 'Already closed' }); continue; }

    // A finalised plan is frozen for payroll and reporting. Skipped
    // rather than thrown so one locked shift in a batch does not reject
    // the rest.
    if (sd.shiftPlan) {
      const plan = await ShiftPlan.findById(sd.shiftPlan).select('finalized').lean();
      if (plan?.finalized) {
        skipped.push({ id, reason: 'Shift is finalised — an admin must reopen it first' });
        continue;
      }
    }

    // Conditional on the status, in the same write: a shift verified
    // between the read above and this line must stay closed. An
    // unconditional write flipped it back to pending, and verifying it
    // again cascaded its metres into the job a second time.
    const written = await ShiftDetail.findOneAndUpdate(
      { _id: id, status: { $ne: 'closed' } },
      {
        $set: {
          submittedProductionMeters: prodNum,
          submittedTimer:            timer,
          submittedFeedback:         feedback,
          submittedAt:               new Date(),
          submittedBy:               userId,
          status:                    'pending_verification',
        },
      },
      { projection: { _id: 1 } }
    );
    if (!written) { skipped.push({ id, reason: 'Already closed' }); continue; }

    saved.push({ id, production: prodNum, status: 'pending_verification' });

    // What the OPERATOR supplied, not what gets stored: `timer` above
    // defaults to '00:00:00', and recording that default as the human's
    // answer would count every blank timer cell as a correction.
    settledRows[id] = {
      production: prodNum,
      timer: entry.timer ?? null,
      remarks: feedback,
    };
  }

  // If these figures came from a read photo or sheet, close that
  // suggestion out against what was actually saved. `ignoreMissing`: a
  // row read but never submitted is undecided, not disagreed with.
  if (aiSuggestionId) {
    await ledger.settle(aiSuggestionId, {
      expectSurface: surface,
      accepted: { rows: settledRows },
      decidedBy: userId,
      ignoreMissing: true,
    });
  }

  return { saved, skipped };
}

module.exports = { submitProduction };

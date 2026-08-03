'use strict';
//
// Reading a yarn lot's own ledger.
//
// `receivedQty` and `consumedQty` are running totals, and a running
// total cannot be audited: it says a lot has 40 kg left without saying
// when the rest went or who took it. models/YarnLot.js keeps a row per
// move; this puts those rows into a shape a person can read.
//
// Deliberately mirrors utils/stockLedger.js — same sign convention
// (quantity is the delta, so a draw is negative), same "say it in
// words" idea, same balance back-fill. Two ledgers in one system that
// read with different rules is how a number gets misread.

/** What each lot movement type is, in words. */
const TYPE_LABEL = {
  INWARD:       'Received',
  BATCH_ISSUE:  'Issued to warping',
  BATCH_RETURN: 'Returned from warping',
  ADJUST:       'Manual adjustment',
};

/**
 * Say why one lot movement happened, and which document caused it.
 *
 * @returns {{typeLabel: string, reference: string|null,
 *            referenceId: string|null, reason: string, by: string|null}}
 */
function describeLotMovement(row = {}) {
  const batch = row.warpingBatch;
  const batchNo = batch && typeof batch === 'object' ? batch.batchNo : null;
  const snapshot = (row.refNo || '').trim();

  let reference = null;
  let referenceId = null;
  if (batch) {
    referenceId = (batch._id ?? batch) ? String(batch._id ?? batch) : null;
    // Prefer the live batch number, fall back to the snapshot so a
    // deleted batch does not silently blank its own row.
    reference = batchNo || snapshot || 'Warping batch';
  } else if (snapshot) {
    reference = snapshot;
  }

  const by = row.by && typeof row.by === 'object' ? row.by.name || null : null;

  return {
    typeLabel: TYPE_LABEL[row.type] || row.type || 'Movement',
    reference,
    referenceId,
    reason: (row.reason || '').trim(),
    by,
  };
}

/**
 * Newest-first rows, each described, with any missing balance filled in
 * by walking back from the lot's balance now.
 *
 * A balance actually recorded at the time is the better fact, so it is
 * left alone — only gaps are filled. Rows written before this ledger
 * existed have none, and they are the ones that need it.
 *
 * @param {Array} movements as stored (oldest first)
 * @param {number} currentBalance the lot's balance right now
 */
function describeLotMovements(movements = [], currentBalance = 0) {
  const rows = (movements || [])
    .map((m) => (typeof m.toObject === 'function' ? m.toObject() : { ...m }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  let running = Number(currentBalance) || 0;
  for (const row of rows) {
    if (row.balance === undefined || row.balance === null) row.balance = running;
    running = (Number(row.balance) || 0) - (Number(row.quantity) || 0);
  }

  return rows.map((row) => ({ ...row, ...describeLotMovement(row) }));
}

module.exports = { describeLotMovement, describeLotMovements, TYPE_LABEL };

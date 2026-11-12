'use strict';
//
// Write down the steps of every Rule 37 reversal made so far.
//
// Input credit on a bill unpaid for 180 days is reversed, and re-claimed
// as the bill is paid. A bill held one reversal and one re-claim, each
// with its amount and its GSTR-3B month. A bill is paid in parts, so the
// credit now comes back in parts: the amounts on the bill are running
// totals, and every step is kept in `itcReversal.history` with the month
// it belongs to (services/itcReversal.js). The GST summary reads a
// month's steps from that history.
//
// This gives every bill reversed before the change its history: the one
// reversal, and the one re-claim if there was one, exactly as recorded.
// No amount or month changes. (The service reads an older bill the same
// way without this, and writes its history on the bill's next step; the
// migration makes every bill alike, so a report can ask the history
// alone.)
//
// Safe to run twice: a bill that has a history is left alone. `down`
// takes the history off the bills listed in `migration_notes` whose
// history is still the one written here.

const ME = '20261112000004-itc-reversal-history';
const NOTES = 'migration_notes';

function stepsOf(r) {
  const out = [];
  if (r.amount > 0) out.push({ kind: 'reverse', amount: r.amount, period: r.period || '', at: r.at || null, byName: '' });
  if (r.reclaimAmount > 0) out.push({ kind: 'reclaim', amount: r.reclaimAmount, period: r.reclaimPeriod || '', at: r.reclaimAt || null, byName: '' });
  return out;
}

module.exports = {
  async up(db) {
    const bills = await db.collection('supplierbills').find({
      'itcReversal.amount': { $gt: 0 },
      $or: [{ 'itcReversal.history': { $exists: false } }, { 'itcReversal.history': null }, { 'itcReversal.history': { $size: 0 } }],
    }).project({ billNo: 1, itcReversal: 1 }).toArray();
    const changed = [];
    for (const b of bills) {
      const steps = stepsOf(b.itcReversal || {});
      if (!steps.length) continue;
      // Only while it still has none: a step taken through the app meanwhile wrote its own.
      const r = await db.collection('supplierbills').updateOne(
        { _id: b._id, $or: [{ 'itcReversal.history': { $exists: false } }, { 'itcReversal.history': null }, { 'itcReversal.history': { $size: 0 } }] },
        { $set: { 'itcReversal.history': steps } }
      );
      if (r.modifiedCount) changed.push({ bill: b._id, billNo: b.billNo || '', steps: steps.length });
    }
    if (changed.length) {
      await db.collection(NOTES).updateOne(
        { _id: ME },
        { $setOnInsert: { at: new Date(), what: 'Rule 37 reversals given their history of steps' }, $push: { changed: { $each: changed } } },
        { upsert: true }
      );
    }
  },

  async down(db) {
    const note = await db.collection(NOTES).findOne({ _id: ME });
    if (!note) return;
    for (const c of note.changed || []) {
      // Only where no step was added since.
      await db.collection('supplierbills').updateOne({ _id: c.bill, 'itcReversal.history': { $size: c.steps } }, { $unset: { 'itcReversal.history': '' } });
    }
    await db.collection(NOTES).deleteOne({ _id: ME });
  },
};

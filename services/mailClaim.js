'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MAIL IS READ ONCE — AND NOT LOST WHEN ITS READING IS CUT SHORT
//
//  The mailbox readers (services/customerInbox.js, services/billMailbox.js)
//  claim a mail before reading it: a row with the mail's Message-ID,
//  unique, so two server processes never read it twice. But a claim
//  nobody finished — the server was restarted while the mail was with
//  the reader — used to hide the mail for good: known, so never fetched
//  again; unfinished, so never shown. A customer's purchase order could
//  vanish that way without a word.
//
//  A claim still "reading" a quarter of an hour on is taken over, once
//  (`readings` goes to 2). Cut short a second time it is not tried a
//  third: giveUp() lets the reader show it to a person instead.
//
//    known(Model, key, reading)        claimed, and not waiting to be read again
//    claim(Model, key, doc, reading)   → 'first' | 'again' | null (someone else's)
//    giveUp(Model, reading, set)       claims cut short twice, made visible
//
//  `key` finds the claim ({ messageId }), `reading` is what an
//  unfinished claim looks like ({ status: 'reading' }), `doc` the rest
//  of the row.
// ══════════════════════════════════════════════════════════════════

const STALE_MS = 15 * 60_000;
const MAX_READINGS = 2;

/** An unfinished claim old enough that whoever made it is gone. */
const cutShort = (reading, now = new Date()) => ({ ...reading, updatedAt: { $lt: new Date(now.getTime() - STALE_MS) } });
// `readings` is missing on rows from before it was kept: those count as one.
const once = { readings: { $not: { $gte: MAX_READINGS } } };

async function known(Model, key, reading, now = new Date()) {
  return !!(await Model.exists({ ...key, $nor: [{ ...cutShort(reading, now), ...once }] }));
}

async function claim(Model, key, doc, reading, now = new Date()) {
  try { await Model.create({ ...key, ...doc, ...reading }); return 'first'; } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  // Taken over in place, by one process: the update moves updatedAt, so a second finds nothing to take.
  const took = await Model.findOneAndUpdate({ ...key, ...cutShort(reading, now), ...once }, { $set: { ...doc, readings: MAX_READINGS } }).lean();
  return took ? 'again' : null;
}

async function giveUp(Model, reading, set, now = new Date()) {
  const r = await Model.updateMany({ ...cutShort(reading, now), readings: { $gte: MAX_READINGS } }, { $set: set });
  return r.modifiedCount || 0;
}

module.exports = { known, claim, giveUp, cutShort, STALE_MS, MAX_READINGS };

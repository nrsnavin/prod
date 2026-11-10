'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE AT A TIME
//
//  Some things are worked out and then created: what is short on an
//  order and so must be bought, which challans are not yet on an invoice.
//  Two requests arriving together — a double tap, two people at two
//  desks — both work it out before either has created anything, and both
//  create it: the purchase orders raised twice, one challan on two
//  invoices. A transaction does not stop that. Each creates its own new
//  document, so there is no write for them to collide on.
//
//  onceAtATime(key, work) lets one of them through at a time. The lease
//  is a row in the database, so it holds across server processes; the
//  second waits a few seconds for the first to finish and then runs —
//  against what the first one made, which is the point: it is told
//  "already on order", or handed the invoice that was just raised.
//
//    return onceAtATime(`raise-po:order:${order._id}`, async () => {
//      …work out the shortfall, create the purchase orders…
//    }, { what: 'Purchase orders for this order' });
//
//  A holder that dies keeps nobody out for long: the lease lapses by
//  itself (`ttlMs`), and nothing here is held across a wait on a person.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const Lease = require('../models/Lease');
const ErrorHandler = require('./ErrorHandler');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take the lease on `key`; null when somebody else holds it. */
async function take(key, ttlMs) {
  const now = new Date();
  const holder = crypto.randomBytes(8).toString('hex');
  try {
    // Matches a lease that has lapsed, or none at all (and makes one). A
    // live lease does not match, so the upsert tries to insert the same
    // _id and the unique _id refuses it.
    await Lease.updateOne(
      { _id: key, until: { $lte: now } },
      { $set: { until: new Date(now.getTime() + ttlMs), holder } },
      { upsert: true }
    );
    return holder;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/** Let go — only of a lease still ours (one that lapsed may be somebody else's now). */
const release = (key, holder) => Lease.deleteOne({ _id: key, holder });

/**
 * Run `work` while holding the lease on `key`.
 *
 * @param {string} key
 * @param {() => Promise<T>} work
 * @param {object} [opts]
 * @param {number} [opts.waitMs=8000]   how long to wait for somebody else to finish
 * @param {number} [opts.ttlMs=60000]   how long a holder that died keeps others out
 * @param {string} [opts.what]          what is being done, for the 409 ("Purchase orders for this order")
 * @returns {Promise<T>}
 */
async function onceAtATime(key, work, { waitMs = 8000, ttlMs = 60_000, what = 'This' } = {}) {
  const giveUpAt = Date.now() + waitMs;
  let holder = await take(key, ttlMs);
  while (!holder && Date.now() < giveUpAt) {
    await pause(120);
    holder = await take(key, ttlMs);
  }
  if (!holder) {
    const err = new ErrorHandler(`${what} is being done by someone else just now. Give it a moment, then look before trying again.`, 409);
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  try {
    return await work();
  } finally {
    await release(key, holder).catch((e) => console.warn(`[onceAtATime] ${key} not released: ${e.message}`));
  }
}

module.exports = { onceAtATime, take, release };

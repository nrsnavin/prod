'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BOOKS LOCK
//
//  Once a period has gone to Tally it must not change underneath the
//  accountant. assertOpen(date, req) refuses (409 BOOKS_LOCKED) any
//  posting or cancelling dated on or before the lock date, unless an
//  admin sends a reason in `lockOverride` (8+ characters).
//
//  Nothing about the lock happens without a record of it:
//
//    • an override is written to the lock history as it is let through
//      (who, when, why, and which entry), and the reason is left on the
//      request, so the fingerprint of whatever is then posted or
//      cancelled carries it too (accountsHelpers.fp, overrideMeta);
//    • closing the books, moving the date and opening them again go
//      through setLock(), which writes the history row with the reason.
//
//  The history (models/BooksLockEvent.js) is what the books health
//  check reads to find entries made inside a period after it closed.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const AccountsSettings = require('../models/AccountsSettings');
const BooksLockEvent = require('../models/BooksLockEvent');
const { settingsDoc } = require('../utils/settingsDoc');
const ErrorHandler = require('../utils/ErrorHandler');

const MIN_REASON = 8;

async function getSettings() {
  // Every part filled in, also on a record saved before that part existed.
  return settingsDoc(AccountsSettings, 'accounts');
}

const dayEnd = (d) => factoryDay.calendarDayEnd(d) || new Date(NaN);

async function lockDate() {
  const s = await AccountsSettings.findOne({ key: 'accounts' }).select('lockDate').lean();
  return s?.lockDate || null;
}

const who = (req) => ({ by: req?.user?._id || undefined, byName: req?.user?.name || req?.user?.username || '' });

/**
 * @returns the override reason when an admin overrode the lock, else null.
 * An override is recorded in the lock history before this returns, and
 * left on `req.lockOverrideUsed` for the fingerprint of what follows.
 */
async function assertOpen(date, req, { cancelling = false } = {}) {
  const lock = await lockDate();
  if (!lock || !date || new Date(date) > dayEnd(lock)) return null;
  const reason = String(req?.body?.lockOverride || '').trim();
  if (req?.user?.role === 'admin' && reason.length >= MIN_REASON) {
    // One history row for one entry, however many times a route and the
    // service under it both ask.
    const key = `${new Date(date).getTime()}:${cancelling ? 'c' : 'p'}`;
    const seen = req._lockOverrides || (req._lockOverrides = new Set());
    if (!seen.has(key)) {
      seen.add(key);
      await BooksLockEvent.create({
        kind: 'override', lockDate: lock, previousLockDate: lock, reason: reason.slice(0, 300), ...who(req),
        entry: { date: new Date(date), cancelling: !!cancelling, method: String(req.method || ''), path: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200) },
      });
    }
    req.lockOverrideUsed = reason.slice(0, 300);
    return reason;
  }
  const when = new Date(lock).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const err = new ErrorHandler(
    `The books are closed up to ${when} — this ${cancelling ? 'cancellation' : 'entry'} is dated inside the closed period. An admin can override with a reason.`,
    409
  );
  err.code = 'BOOKS_LOCKED';
  err.details = { lockDate: lock };
  throw err;
}

/** For a fingerprint's meta: the override this request was let through on, if any. */
const overrideMeta = (req) => (req?.lockOverrideUsed ? { lockOverride: req.lockOverrideUsed } : {});

/**
 * Close the books up to `to` (a day), move the date, or open them again
 * (`to` null). Opening them again, or moving the date earlier, needs a
 * reason. Every change is written to the lock history.
 * @returns { settings, event } — event null when nothing changed
 */
async function setLock(to, req, { reason = '', via = 'settings' } = {}) {
  const current = (await getSettings()).lockDate || null;
  const next = to ? new Date(to) : null;
  const same = (current ? new Date(current).getTime() : null) === (next ? next.getTime() : null);
  if (same) return { settings: await getSettings(), event: null };
  const opening = !!current && (!next || next < new Date(current));
  const why = String(reason || '').trim();
  if (opening && why.length < MIN_REASON) throw new ErrorHandler(`Opening closed books again needs a reason (at least ${MIN_REASON} characters)`, 400);
  const at = new Date();
  await AccountsSettings.updateOne({ key: 'accounts' }, { $set: { lockDate: next, lockedBy: who(req).byName, lockedAt: at } });
  const event = await BooksLockEvent.create({
    kind: opening ? 'reopened' : current ? 'moved' : 'closed',
    lockDate: next, previousLockDate: current, reason: why.slice(0, 300), via, at, ...who(req),
  });
  return { settings: await getSettings(), event: event.toObject() };
}

/** The lock's history, newest first. */
async function history({ limit = 100 } = {}) {
  return BooksLockEvent.find({}).sort({ at: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).lean();
}

/**
 * The lock as it stood over time: [{ from, to, lockDate }] oldest first,
 * `to` null for the stretch still running. Before there was a history
 * the settings row is all there is: one stretch from when it was last
 * locked (a migration writes that stretch into the history once, so it
 * is not lost when the lock next moves).
 */
async function timeline() {
  const events = await BooksLockEvent.find({ kind: { $ne: 'override' } }).sort({ at: 1 }).select('lockDate previousLockDate at').lean();
  const s = await AccountsSettings.findOne({ key: 'accounts' }).select('lockDate lockedAt').lean();
  if (!events.length) return s?.lockDate && s?.lockedAt ? [{ from: s.lockedAt, to: null, lockDate: s.lockDate }] : [];
  const out = [];
  events.forEach((e, i) => {
    if (e.lockDate) out.push({ from: e.at, to: events[i + 1]?.at || null, lockDate: e.lockDate });
  });
  return out;
}

module.exports = { getSettings, lockDate, assertOpen, overrideMeta, setLock, history, timeline, MIN_REASON };

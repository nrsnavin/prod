'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BOOKS LOCK
//
//  Once a period has gone to Tally it must not change underneath the
//  accountant. assertOpen(date, req) refuses (409 BOOKS_LOCKED) any
//  posting or cancelling dated on or before the lock date, unless an
//  admin sends a reason in `lockOverride` (8+ characters) — which the
//  caller records on the document's fingerprint.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const AccountsSettings = require('../models/AccountsSettings');
const { settingsDoc } = require('../utils/settingsDoc');
const ErrorHandler = require('../utils/ErrorHandler');

async function getSettings() {
  // Every part filled in, also on a record saved before that part existed.
  return settingsDoc(AccountsSettings, 'accounts');
}

const dayEnd = (d) => factoryDay.calendarDayEnd(d) || new Date(NaN);

async function lockDate() {
  const s = await AccountsSettings.findOne({ key: 'accounts' }).select('lockDate').lean();
  return s?.lockDate || null;
}

/**
 * @returns the override reason when an admin overrode the lock, else null.
 */
async function assertOpen(date, req, { cancelling = false } = {}) {
  const lock = await lockDate();
  if (!lock || !date || new Date(date) > dayEnd(lock)) return null;
  const reason = String(req?.body?.lockOverride || '').trim();
  if (req?.user?.role === 'admin' && reason.length >= 8) return reason;
  const when = new Date(lock).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const err = new ErrorHandler(
    `The books are closed up to ${when} — this ${cancelling ? 'cancellation' : 'entry'} is dated inside the closed period. An admin can override with a reason.`,
    409
  );
  err.code = 'BOOKS_LOCKED';
  err.details = { lockDate: lock };
  throw err;
}

module.exports = { getSettings, lockDate, assertOpen };

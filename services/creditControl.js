'use strict';
// ══════════════════════════════════════════════════════════════════
//  CREDIT CONTROL — where the risk is taken
//
//  A customer may carry a credit limit (rupees outstanding) and a most
//  days overdue. Both 0 = no limit, which is every customer until
//  someone sets one, so nothing changes until the office decides it.
//
//  check()    the customer's position and whether it is on hold
//  enforce()  refuses a new order, challan or invoice (409 CREDIT_HOLD)
//             for a customer on hold, unless an admin gives a reason in
//             `creditOverride` — returned for the caller to record
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const ErrorHandler = require('../utils/ErrorHandler');
const outstanding = require('./outstanding');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

async function check(customerId) {
  const c = await Customer.findById(customerId).select('name creditLimit maxOverdueDays').lean();
  if (!c) return null;
  const rows = await outstanding.receivables({ customer: c._id });
  const t = outstanding.totals(rows);
  const oldestDays = rows.reduce((m, r) => Math.max(m, r.overdueDays), 0);
  const limit = Number(c.creditLimit) || 0;
  const maxOverdueDays = Number(c.maxOverdueDays) || 0;
  const reasons = [];
  if (limit > 0 && t.total > limit) reasons.push(`₹${fmt(t.total)} outstanding is over the ₹${fmt(limit)} credit limit`);
  if (maxOverdueDays > 0 && oldestDays > maxOverdueDays) reasons.push(`an invoice is ${oldestDays} days overdue (limit ${maxOverdueDays})`);
  const nearLimit = limit > 0 && !reasons.length && t.total > limit * 0.8;
  return {
    customer: { _id: c._id, name: c.name },
    outstanding: r2(t.total), overdue: r2(t.overdue), oldestDays, count: t.count,
    limit, maxOverdueDays, available: limit > 0 ? r2(Math.max(0, limit - t.total)) : null,
    onHold: reasons.length > 0, warning: nearLimit ? `₹${fmt(t.total)} of the ₹${fmt(limit)} limit used` : null, reasons,
  };
}

/**
 * Throws CREDIT_HOLD for a customer on hold; returns the admin's
 * override ({ reason, by, byName, at }) when one was given, else null.
 */
async function enforce(customerId, req, what = 'this') {
  if (!customerId) return null;
  const pos = await check(customerId);
  if (!pos || !pos.onHold) return null;
  const reason = String(req.body?.creditOverride || '').trim();
  if (req.user?.role === 'admin' && reason.length >= 8) {
    return { reason, by: req.user._id, byName: req.user.name || '', at: new Date(), outstanding: pos.outstanding, oldestDays: pos.oldestDays };
  }
  const err = new ErrorHandler(`${pos.customer.name} is on credit hold: ${pos.reasons.join('; ')}. Collect payment first, or an admin can release ${what} with a reason.`, 409);
  err.code = 'CREDIT_HOLD';
  err.details = pos;
  throw err;
}

module.exports = { check, enforce };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  BEFORE MONEY GOES OUT — CHECKS ON A PAYMENT
//
//  Run as a payment is typed (POST /accounts/payments/check) and again
//  when it is posted. Two are DANGER, and stop the payment until someone
//  says how they confirmed it (the note is kept on the voucher):
//
//    BANK_CHANGED     the supplier's bank account changed in the last 30
//                     days — the "our bank has changed" mail is the most
//                     common payment fraud; call them on the number on
//                     file, not the one in the mail
//    SHARED_ACCOUNT   the same bank account is on file for another
//                     supplier
//
//  The rest are warnings:
//    DUPLICATE        the same amount to them in the last 7 days
//    UNUSUAL_AMOUNT   over three times the most paid to them in a year
//    NOTHING_DUE      more than is due to them: an advance?
//    NEW_SUPPLIER     ₹1 lakh or more to a supplier on file under 30 days
//    LOOKALIKE_PAYEE  "paid to" a name that is nearly a supplier's
//    SAME_HANDS       the person paying entered every bill being paid,
//                     past ₹2 lakh: another person should release it
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const Payment = require('../models/Payment');
const SupplierBill = require('../models/SupplierBill');
const outstanding = require('./outstanding');

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dmy = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const squash = (s) => String(s || '').toUpperCase().replace(/\b(M\/S|MS|THE|PVT|PRIVATE|LTD|LIMITED|LLP|AND|CO|COMPANY)\b/g, '').replace(/[^A-Z0-9]/g, '');
const BANK_CHANGE_DAYS = 30;
const NEW_SUPPLIER_DAYS = 30;
const NEW_SUPPLIER_AMOUNT = 100_000;
const SAME_HANDS_AMOUNT = 200_000;

/** Edit distance, capped: how many letters apart two names are. */
function distance(a, b, cap = 4) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

const last4 = (no) => (no ? `…${String(no).slice(-4)}` : '');

/**
 * @param b    the payment as typed: { kind, partyType, supplier, partyName, amount, date, allocations }
 * @param user who is paying
 * @returns flags [{ code, severity: 'danger'|'warning'|'info', message }]
 */
async function paymentFlags(b, user = null) {
  const flags = [];
  if (b?.kind !== 'payment') return flags;
  const amount = r2(b.amount);
  const now = new Date();
  const allocations = Array.isArray(b.allocations) ? b.allocations : [];

  if (b.partyType === 'supplier' && mongoose.isValidObjectId(String(b.supplier || ''))) {
    const s = await Supplier.findById(b.supplier).select('name bank createdAt').lean();
    if (!s) return flags;
    // Danger: the bank account changed lately, or is someone else's too.
    if (s.bank?.changedAt && now - new Date(s.bank.changedAt) < BANK_CHANGE_DAYS * DAY) {
      flags.push({ code: 'BANK_CHANGED', severity: 'danger', message: `${s.name}'s bank account was changed on ${dmy(s.bank.changedAt)}${s.bank.changedByName ? ` by ${s.bank.changedByName}` : ''} (was ${last4(s.bank.previousAccountNo)}, now ${last4(s.bank.accountNo)})${s.bank.source === 'cheque' ? (s.bank.holderMatches === false ? ' — read from a cheque whose holder is NOT their name' : ' — read from their cancelled cheque') : ''} — call them on the number on file, not one from a mail, before paying` });
    }
    if (s.bank?.accountNo) {
      const twin = await Supplier.findOne({ _id: { $ne: s._id }, 'bank.accountNo': s.bank.accountNo, isActive: { $ne: false } }).select('name').lean();
      if (twin) flags.push({ code: 'SHARED_ACCOUNT', severity: 'danger', message: `The bank account on file for ${s.name} (${last4(s.bank.accountNo)}) is also on file for ${twin.name}` });
    }
    // The same amount lately.
    if (amount > 0) {
      const dup = await Payment.findOne({ kind: 'payment', status: 'posted', supplier: s._id, amount: { $gte: amount - 1, $lte: amount + 1 }, date: { $gte: new Date(now.getTime() - 7 * DAY) } }).select('voucherNo date').lean();
      if (dup) flags.push({ code: 'DUPLICATE', severity: 'warning', message: `₹${fmt(amount)} was paid to ${s.name} on ${dmy(dup.date)} (${dup.voucherNo}) — the same payment twice?` });
      const past = await Payment.find({ kind: 'payment', status: 'posted', supplier: s._id, date: { $gte: new Date(now.getTime() - 365 * DAY) } }).select('amount').lean();
      const most = past.reduce((m, p) => Math.max(m, p.amount || 0), 0);
      if (past.length >= 3 && amount > 3 * most) flags.push({ code: 'UNUSUAL_AMOUNT', severity: 'warning', message: `₹${fmt(amount)} is over three times the most paid to ${s.name} in a year (₹${fmt(most)})` });
    }
    // More than is due.
    const due = r2((await outstanding.payables({ supplier: s._id })).reduce((t, r) => t + r.outstanding, 0));
    const allocated = r2(allocations.reduce((t, a) => t + (Number(a.amount) || 0), 0));
    if (amount > 0 && allocated + 1 < amount && amount > due + 1) {
      flags.push({ code: 'NOTHING_DUE', severity: 'warning', message: `₹${fmt(r2(amount - Math.max(allocated, 0)))} would sit with ${s.name} on account, and ₹${fmt(due)} is all that is due to them — an advance? Say so in the narration` });
    }
    if (s.createdAt && now - new Date(s.createdAt) < NEW_SUPPLIER_DAYS * DAY && amount >= NEW_SUPPLIER_AMOUNT) {
      flags.push({ code: 'NEW_SUPPLIER', severity: 'warning', message: `${s.name} was added on ${dmy(s.createdAt)} and this is ₹${fmt(amount)} — confirm who they are before a first large payment` });
    }
    // Segregation: the one who entered the bills releasing the money for them.
    const billIds = allocations.filter((a) => a.docType === 'SupplierBill' && mongoose.isValidObjectId(String(a.doc))).map((a) => a.doc);
    if (user?._id && user.role !== 'admin' && billIds.length && amount >= SAME_HANDS_AMOUNT) {
      const bills = await SupplierBill.find({ _id: { $in: billIds } }).select('createdBy').lean();
      if (bills.length && bills.every((x) => String(x.createdBy || '') === String(user._id))) {
        flags.push({ code: 'SAME_HANDS', severity: 'warning', message: `You entered ${bills.length === 1 ? 'the bill' : 'every bill'} this pays — past ₹${fmt(SAME_HANDS_AMOUNT)}, another person should release the payment` });
      }
    }
  } else if (b.partyType === 'other' && String(b.partyName || '').trim().length >= 4) {
    // Paid to a name that is nearly a supplier's: pay the supplier on file.
    const want = squash(b.partyName);
    const suppliers = await Supplier.find({ isActive: { $ne: false } }).select('name').lean();
    const near = suppliers.find((s) => {
      const have = squash(s.name);
      return have && want && (have === want || (Math.min(have.length, want.length) >= 6 && distance(have, want, 2) <= 2));
    });
    if (near) flags.push({ code: 'LOOKALIKE_PAYEE', severity: 'warning', message: `"${String(b.partyName).trim()}" is nearly ${near.name}, a supplier on file — pay them as the supplier, so it is on their account` });
  }
  return flags;
}

module.exports = { paymentFlags, distance };

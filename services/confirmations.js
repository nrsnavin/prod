'use strict';
// ══════════════════════════════════════════════════════════════════
//  BALANCE CONFIRMATIONS
//
//  list()    every party with a balance on the day, and where its
//            confirmation stands
//  create()  rows for the parties asked (or all with a balance), each
//            with the balance snapshotted from the ledger
//  letter()  the letter's text and the statement behind it
//  send()    by email or WhatsApp when configured, or marked as printed
//  reply()   what the party said: agreed, or their figure and the gap
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const BalanceConfirmation = require('../models/BalanceConfirmation');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const partyLedger = require('./partyLedger');
const outstanding = require('./outstanding');
const { getDocumentSettings } = require('./documentSettings');
const { allocate } = require('./docNumbers');
const { isId, r2, fp, DAY } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

const dmy = (d) => { const t = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`; };
const money = (n) => Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const endOf = (d) => new Date(new Date(d).getTime() + DAY - 1);

/** Parties of a kind with a non-zero ledger balance as at the day. */
async function balancesOn(partyType, asOf) {
  const PartyLedgerEntry = require('../models/PartyLedgerEntry');
  const rows = await PartyLedgerEntry.aggregate([
    { $match: { partyType, date: { $lte: endOf(asOf) } } },
    { $group: { _id: '$party', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  const out = new Map();
  for (const x of rows) {
    const b = partyLedger.balanceOf(partyType, x);
    if (Math.abs(b) > 0.005) out.set(String(x._id), b);
  }
  return out;
}

async function list(asOf) {
  const [cb, sb, existing] = await Promise.all([balancesOn('customer', asOf), balancesOn('supplier', asOf), BalanceConfirmation.find({ asOf: { $gte: new Date(new Date(asOf).toISOString().slice(0, 10)), $lte: endOf(asOf) } }).lean()]);
  const [customers, suppliers] = await Promise.all([
    Customer.find({ _id: { $in: [...cb.keys()] } }).select('name gstin email phoneNumber accountant').lean(),
    Supplier.find({ _id: { $in: [...sb.keys()] } }).select('name gstin email phoneNumber').lean(),
  ]);
  const byParty = new Map(existing.map((c) => [`${c.partyType}:${c[c.partyType]}`, c]));
  const rows = [];
  for (const c of customers) rows.push({ partyType: 'customer', party: c._id, partyName: c.name, gstin: c.gstin || '', email: c.accountant?.email || c.email || '', phone: c.accountant?.mobile || c.phoneNumber || '', balance: cb.get(String(c._id)), confirmation: byParty.get(`customer:${c._id}`) || null });
  for (const s of suppliers) rows.push({ partyType: 'supplier', party: s._id, partyName: s.name, gstin: s.gstin || '', email: s.email || '', phone: s.phoneNumber || '', balance: sb.get(String(s._id)), confirmation: byParty.get(`supplier:${s._id}`) || null });
  rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  const count = (st) => rows.filter((r) => (r.confirmation?.status || 'none') === st).length;
  return {
    asOf: new Date(asOf), rows,
    totals: { parties: rows.length, none: count('none'), draft: count('draft'), sent: count('sent'), confirmed: count('confirmed'), disputed: count('disputed'), customers: r2(rows.filter((r) => r.partyType === 'customer').reduce((s, r) => s + r.balance, 0)), suppliers: r2(rows.filter((r) => r.partyType === 'supplier').reduce((s, r) => s + r.balance, 0)) },
  };
}

/** Make rows for the parties asked, skipping any that already have one for the day. */
async function create({ asOf, partyType, parties, all }, req) {
  if (!['customer', 'supplier', 'both'].includes(partyType || 'both')) throw new ErrorHandler('partyType must be customer, supplier or both', 400);
  const kinds = !partyType || partyType === 'both' ? ['customer', 'supplier'] : [partyType];
  const made = []; let skipped = 0;
  for (const kind of kinds) {
    const bal = await balancesOn(kind, asOf);
    const wanted = all ? [...bal.keys()] : (Array.isArray(parties) ? parties : []).filter(isId).map(String);
    for (const id of wanted) {
      const balance = bal.get(id);
      if (balance === undefined) { skipped += 1; continue; }
      const dup = await BalanceConfirmation.findOne({ partyType: kind, [kind]: id, asOf: { $gte: new Date(new Date(asOf).toISOString().slice(0, 10)), $lte: endOf(asOf) } }).lean();
      if (dup) { skipped += 1; continue; }
      const p = await (kind === 'customer' ? Customer : Supplier).findById(id).select('name gstin').lean();
      if (!p) { skipped += 1; continue; }
      const open = kind === 'customer' ? await outstanding.receivables({ customer: id, asOf: endOf(asOf) }) : await outstanding.payables({ supplier: id, asOf: endOf(asOf) });
      const { financialYear, sequence, number } = await allocate(BalanceConfirmation, 'BC', { at: asOf });
      const _id = new mongoose.Types.ObjectId();
      const row = await BalanceConfirmation.create({
        _id, confirmationNo: number, financialYear, sequence, asOf, partyType: kind, [kind]: p._id, partyName: p.name, partyGstin: p.gstin || '',
        balance, openCount: open.length, createdBy: req?.user?._id,
      });
      made.push(row.toObject());
    }
  }
  return { made, skipped };
}

/** The letter and the statement it refers to. */
async function letter(id) {
  if (!isId(id)) throw new ErrorHandler('Confirmation not found', 404);
  const c = await BalanceConfirmation.findById(id).lean();
  if (!c) throw new ErrorHandler('Confirmation not found', 404);
  const settings = await getDocumentSettings();
  const company = settings.companyName || 'Balu Elastics';
  const fyStart = new Date(Date.UTC(new Date(c.asOf).getUTCMonth() >= 3 ? new Date(c.asOf).getUTCFullYear() : new Date(c.asOf).getUTCFullYear() - 1, 3, 1));
  const st = await partyLedger.statement(c.partyType, c[c.partyType], { from: fyStart, to: endOf(c.asOf) });
  const owes = c.partyType === 'customer' ? c.balance > 0 : c.balance < 0;   // the party owes us
  const side = owes ? 'Dr' : 'Cr';
  const text = [
    `${company}`,
    settings.addressLines?.filter(Boolean).join(', ') || '',
    settings.gstin ? `GSTIN ${settings.gstin}` : '',
    '',
    `Date: ${dmy(new Date())}`,
    `Ref: ${c.confirmationNo}`,
    '',
    `To,`,
    `${c.partyName}${c.partyGstin ? ` (GSTIN ${c.partyGstin})` : ''}`,
    '',
    `Subject: Confirmation of balance as on ${dmy(c.asOf)}`,
    '',
    `Dear Sir / Madam,`,
    '',
    `As per our books of account, the balance in your account as on ${dmy(c.asOf)} stands at ₹${money(c.balance)} ${side} — that is, ${owes ? `receivable from you` : `payable to you`} by us${c.openCount ? `, made up of ${c.openCount} open document${c.openCount === 1 ? '' : 's'}` : ''}. A statement of the account for the year to that date is enclosed.`,
    '',
    `Kindly confirm that this agrees with your books by signing below and returning a copy to us. If your records show a different balance, please let us have the figure and the details of the difference so that it can be reconciled.`,
    '',
    `This confirmation is sought for audit purposes and does not represent a demand.`,
    '',
    `Yours faithfully,`,
    `For ${company}`,
    '',
    '',
    `Authorised Signatory`,
    '',
    '— — — — — — — — — — — — — — — — — — — —',
    `We confirm that the balance of ₹${money(c.balance)} ${side} as on ${dmy(c.asOf)} agrees with our books.`,
    `Balance as per our books (if different): ₹ ______________`,
    '',
    `Signature & seal: ______________   Date: __________`,
  ].filter((l) => l !== null).join('\n');
  return { confirmation: c, company, text, statement: { from: fyStart, to: c.asOf, ...st } };
}

async function send(id, { channel, to }, req) {
  if (!isId(id)) throw new ErrorHandler('Confirmation not found', 404);
  const c = await BalanceConfirmation.findById(id).lean();
  if (!c) throw new ErrorHandler('Confirmation not found', 404);
  if (!['email', 'whatsapp', 'print'].includes(channel)) throw new ErrorHandler('channel must be email, whatsapp or print', 400);
  const { text, company } = await letter(id);
  let result = 'marked as printed and handed over';
  if (channel === 'email') {
    const mailer = require('../utils/mailer');
    const address = String(to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ErrorHandler('Give the email address to send to', 400);
    if (!mailer.isConfigured()) throw new ErrorHandler('Email is not set up on this server (SMTP). Print the letter, or send it by WhatsApp.', 409);
    const r = await mailer.sendMail({ to: address, subject: `Balance confirmation as on ${dmy(c.asOf)} — ${company}`, text });
    result = r.skipped ? `not sent: ${r.reason}` : `emailed to ${address}`;
    to = address;
  } else if (channel === 'whatsapp') {
    const { sendWhatsApp, isConfigured } = require('../utils/whatsapp');
    const { e164 } = require('./collections');
    const phone = e164(to);
    if (!phone) throw new ErrorHandler('Give the phone number to send to', 400);
    if (!isConfigured()) throw new ErrorHandler('WhatsApp is not set up on this server. Print the letter, or send it by email.', 409);
    const r = await sendWhatsApp(phone, text);
    if (!r.sent) throw new ErrorHandler(`WhatsApp did not send: ${r.error || 'not configured'}`, 502);
    result = `sent on WhatsApp to ${phone}`;
    to = phone;
  }
  await BalanceConfirmation.updateOne({ _id: c._id }, {
    $set: { status: c.status === 'draft' || c.status === 'sent' ? 'sent' : c.status, sent: { at: new Date(), by: req?.user?._id, channel, to: String(to || '').slice(0, 120), result } },
    $push: { fingerprints: fp(ACTION_CODES.CONFIRMATION_SENT, c, req, { confirmationNo: c.confirmationNo, channel, to, party: c.partyName }) },
  });
  return BalanceConfirmation.findById(c._id).lean();
}

async function reply(id, { status, theirBalance, note }, req) {
  if (!isId(id)) throw new ErrorHandler('Confirmation not found', 404);
  const c = await BalanceConfirmation.findById(id).lean();
  if (!c) throw new ErrorHandler('Confirmation not found', 404);
  if (!['confirmed', 'disputed'].includes(status)) throw new ErrorHandler('status must be confirmed or disputed', 400);
  const theirs = status === 'confirmed' && (theirBalance === undefined || theirBalance === '' || theirBalance === null) ? c.balance : Number(theirBalance);
  if (!Number.isFinite(theirs)) throw new ErrorHandler('theirBalance must be a number', 400);
  const difference = r2(theirs - c.balance);
  if (status === 'confirmed' && Math.abs(difference) > 0.005) throw new ErrorHandler(`Their balance differs by ₹${money(difference)} — record it as disputed`, 400);
  await BalanceConfirmation.updateOne({ _id: c._id }, {
    $set: { status, reply: { at: new Date(), by: req?.user?._id, theirBalance: r2(theirs), difference, note: String(note || '').trim().slice(0, 500) } },
    $push: { fingerprints: fp(ACTION_CODES.CONFIRMATION_REPLIED, c, req, { confirmationNo: c.confirmationNo, status, theirBalance: r2(theirs), difference, party: c.partyName }) },
  });
  return BalanceConfirmation.findById(c._id).lean();
}

module.exports = { list, create, letter, send, reply, balancesOn };

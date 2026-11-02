'use strict';
// ══════════════════════════════════════════════════════════════════
//  PARTY LEDGER POSTINGS
//
//  post()    one row for a document, idempotent per (docType, doc)
//  reverse() the row gone when the document is cancelled
//  statement() a party's rows between two dates with the opening and
//            running balance
//  rebuild() every row from the documents — the repair after an import
//
//  All writes take an optional session so they land in the caller's
//  transaction with the document they describe.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const PartyLedgerEntry = require('../models/PartyLedgerEntry');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function post({ partyType, party, date, docType, doc, docNo, debit = 0, credit = 0, narration = '' }, session) {
  await PartyLedgerEntry.updateOne(
    { docType, doc },
    { $set: { partyType, party, date, docNo, debit: r2(debit), credit: r2(credit), narration } },
    { upsert: true, session }
  );
}

async function reverse(docType, doc, session) {
  await PartyLedgerEntry.deleteOne({ docType, doc }, { session });
}

/** Σdebit − Σcredit for a customer; Σcredit − Σdebit for a supplier. */
function balanceOf(partyType, sums) {
  const d = r2(sums.debit);
  const c = r2(sums.credit);
  return partyType === 'customer' ? r2(d - c) : r2(c - d);
}

async function sums(partyType, party, filter = {}) {
  const [row] = await PartyLedgerEntry.aggregate([
    { $match: { partyType, party: new mongoose.Types.ObjectId(String(party)), ...filter } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return row || { debit: 0, credit: 0 };
}

/** The statement: opening balance before `from`, rows to `to`, running balance. */
async function statement(partyType, party, { from, to } = {}) {
  const opening = from ? balanceOf(partyType, await sums(partyType, party, { date: { $lt: from } })) : 0;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const rows = await PartyLedgerEntry.find({ partyType, party, ...(from || to ? { date: range } : {}) })
    .sort({ date: 1, _id: 1 })
    .lean();
  let running = opening;
  const out = rows.map((e) => {
    running = partyType === 'customer' ? r2(running + e.debit - e.credit) : r2(running + e.credit - e.debit);
    return { ...e, balance: running };
  });
  return { opening, rows: out, closing: running };
}

/** Balances for many parties at once: Map<partyId, balance>. */
async function balances(partyType, partyIds) {
  const ids = (partyIds || []).map((id) => new mongoose.Types.ObjectId(String(id)));
  const rows = await PartyLedgerEntry.aggregate([
    { $match: { partyType, ...(ids.length ? { party: { $in: ids } } : {}) } },
    { $group: { _id: '$party', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return new Map(rows.map((x) => [String(x._id), balanceOf(partyType, x)]));
}

/** What a voucher settles on the party: the money, the TDS and any adjustment. */
function settledBy(p) {
  return r2((p.amount || 0) + (p.tds?.amount || 0) + (p.adjustments || []).reduce((s, a) => s + (a.amount || 0), 0));
}

/**
 * The row for an opening balance: a due raises what the party owes
 * (customer debit, supplier credit); an advance is the other side.
 */
function openingEntry(o) {
  const party = o.partyType === 'customer' ? o.customer : o.supplier;
  const raises = o.kind === 'due';
  const debitSide = (o.partyType === 'customer') === raises;
  return {
    partyType: o.partyType, party, date: o.date, docType: 'OpeningBalance', doc: o._id, docNo: o.docNo,
    ...(debitSide ? { debit: o.amount } : { credit: o.amount }),
    narration: `Opening balance${o.refNo ? ` · ${o.refNo}` : ''}${o.kind === 'advance' ? ' (advance)' : ''}`,
  };
}

/**
 * Every row from the documents. Issued invoices and bills, approved
 * and paid expenses with a supplier, issued notes, posted vouchers.
 */
async function rebuild() {
  const Invoice = require('../models/Invoice');
  const SupplierBill = require('../models/SupplierBill');
  const Expense = require('../models/Expense');
  const AccountNote = require('../models/AccountNote');
  const Payment = require('../models/Payment');
  const OpeningBalance = require('../models/OpeningBalance');

  await PartyLedgerEntry.deleteMany({});
  let n = 0;
  for (const o of await OpeningBalance.find({ status: 'posted' }).lean()) {
    await post(openingEntry(o));
    n++;
  }
  for (const inv of await Invoice.find({ status: 'issued' }).select('customer invoiceDate invoiceNumber totals').lean()) {
    await post({ partyType: 'customer', party: inv.customer, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: inv.totals?.grand || 0, narration: 'Sales' });
    n++;
  }
  for (const b of await SupplierBill.find({ status: { $ne: 'cancelled' } }).select('supplier billDate billNo supplierBillNo totals').lean()) {
    await post({ partyType: 'supplier', party: b.supplier, date: b.billDate, docType: 'SupplierBill', doc: b._id, docNo: b.billNo, credit: b.totals?.grand || 0, narration: `Bill ${b.supplierBillNo}` });
    n++;
  }
  for (const e of await Expense.find({ status: { $in: ['approved', 'paid'] }, supplier: { $ne: null } }).select('supplier date expenseNo totals description').lean()) {
    await post({ partyType: 'supplier', party: e.supplier, date: e.date, docType: 'Expense', doc: e._id, docNo: e.expenseNo, credit: e.totals?.grand || 0, narration: e.description });
    n++;
  }
  for (const note of await AccountNote.find({ status: 'issued' }).select('kind partyType customer supplier date noteNo totals reason').lean()) {
    const party = note.partyType === 'customer' ? note.customer : note.supplier;
    const amt = note.totals?.grand || 0;
    await post({
      partyType: note.partyType, party, date: note.date, docType: 'AccountNote', doc: note._id, docNo: note.noteNo,
      ...(note.kind === 'credit' ? { credit: amt } : { debit: amt }), narration: note.reason,
    });
    n++;
  }
  for (const p of await Payment.find({ status: 'posted', partyType: { $in: ['customer', 'supplier'] } }).select('kind partyType customer supplier date voucherNo amount tds adjustments narration').lean()) {
    const party = p.partyType === 'customer' ? p.customer : p.supplier;
    const settled = settledBy(p);
    await post({
      partyType: p.partyType, party, date: p.date, docType: 'Payment', doc: p._id, docNo: p.voucherNo,
      ...(p.kind === 'receipt' ? { credit: settled } : { debit: settled }), narration: p.narration || (p.kind === 'receipt' ? 'Receipt' : 'Payment'),
    });
    n++;
  }
  return n;
}

module.exports = { post, reverse, statement, balances, balanceOf, rebuild, settledBy, openingEntry };

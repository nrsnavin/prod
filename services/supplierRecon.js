'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SUPPLIER'S STATEMENT AGAINST OUR BOOKS
//
//  What they booked (utils/partyStatementOcr.js) set beside our ledger
//  of them (PartyLedgerEntry), entry by entry:
//
//    • their invoice ↔ our bill: by their number (our bill keeps it as
//      supplierBillNo) — exactly, or by its last number when that is
//      one bill — else by amount within a fortnight;
//    • their credit ↔ our payment or debit note: by amount within a
//      fortnight, the nearest date first; or two of theirs a few days
//      apart that make one of ours (the money and the TDS on it, booked
//      separately on their side, as one voucher on ours);
//    • what is left on either side is what the balances differ by, each
//      with the likely reason, and how much of the difference is left
//      unexplained.
//
//  Entries of ours a month either side of their period are looked at for
//  a match (one side books later), but only ours inside it are listed.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const PartyLedgerEntry = require('../models/PartyLedgerEntry');
const SupplierBill = require('../models/SupplierBill');
const Supplier = require('../models/Supplier');

const DAY = 86_400_000;
const NEAR_DAYS = 15;
const { r2 } = require('../utils/money');
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const lastNumber = (s) => { const m = String(s || '').match(/(\d+)\D*$/); return m ? Number(m[1]) : null; };
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() : null);
const near = (a, b, days = NEAR_DAYS) => a != null && b != null && Math.abs(a - b) <= days * DAY;

async function reconcile(supplierId, read) {
  if (!mongoose.isValidObjectId(String(supplierId))) { const e = new Error('Choose the supplier'); e.status = 400; throw e; }
  const supplier = await Supplier.findById(supplierId).select('name gstin').lean();
  if (!supplier) { const e = new Error('Supplier not found'); e.status = 404; throw e; }

  const theirs = read.entries.filter((e) => e.kind !== 'opening').map((e, i) => ({ ...e, i, t: day(e.date) }));
  const dates = theirs.map((e) => e.t).filter((t) => t != null);
  const from = day(read.from) ?? (dates.length ? Math.min(...dates) : Date.now() - 180 * DAY);
  const to = day(read.to) ?? (dates.length ? Math.max(...dates) : Date.now());

  const ours = (await PartyLedgerEntry.find({ partyType: 'supplier', party: supplier._id, date: { $gte: new Date(from - 31 * DAY), $lte: new Date(to + 31 * DAY + DAY - 1) } })
    .sort({ date: 1 }).lean()).filter((e) => e.docType !== 'OpeningBalance');
  // Our bills keep the supplier's own number.
  const billNo = new Map((await SupplierBill.find({ _id: { $in: ours.filter((e) => e.docType === 'SupplierBill').map((e) => e.doc) } }).select('supplierBillNo').lean())
    .map((b) => [String(b._id), b.supplierBillNo]));
  const our = ours.map((e) => ({
    id: String(e._id), docType: e.docType, doc: String(e.doc), docNo: e.docNo, theirNo: billNo.get(String(e.doc)) || '',
    date: e.date, t: day(new Date(e.date).toISOString()), debit: r2(e.debit), credit: r2(e.credit), narration: e.narration || '',
  }));
  const used = new Set();
  const matched = [];
  const pick = (o, e, by) => { used.add(o.id); e.done = true; matched.push({ theirs: strip(e), ours: [shape(o)], by, difference: r2((e.debit || e.credit) - (o.credit || o.debit)) }); };

  // 1. Their invoices (and debit notes) against our bills, by number.
  const debits = theirs.filter((e) => e.debit > 0);
  const ourCredits = our.filter((o) => o.credit > 0);
  for (const e of debits) {
    if (!e.docNo) continue;
    const exact = ourCredits.filter((o) => !used.has(o.id) && o.theirNo && squash(o.theirNo) === squash(e.docNo));
    if (exact.length === 1) { pick(exact[0], e, 'number'); continue; }
    const n = lastNumber(e.docNo);
    const byNo = n == null ? [] : ourCredits.filter((o) => !used.has(o.id) && o.theirNo && lastNumber(o.theirNo) === n);
    if (byNo.length === 1) pick(byNo[0], e, 'number');
  }
  // …then by amount, near in date.
  for (const e of debits.filter((x) => !x.done)) {
    const cands = ourCredits.filter((o) => !used.has(o.id) && Math.abs(o.credit - e.debit) < 1 && near(o.t, e.t)).sort((a, b) => Math.abs(a.t - e.t) - Math.abs(b.t - e.t));
    if (cands.length) pick(cands[0], e, 'amount');
  }

  // 2. Their credits against our payments and debit notes: one to one by amount, nearest first.
  const credits = theirs.filter((e) => e.credit > 0);
  const ourDebits = our.filter((o) => o.debit > 0);
  for (const e of credits) {
    const cands = ourDebits.filter((o) => !used.has(o.id) && Math.abs(o.debit - e.credit) < 1 && near(o.t, e.t)).sort((a, b) => Math.abs(a.t - e.t) - Math.abs(b.t - e.t));
    if (cands.length) pick(cands[0], e, 'amount');
  }
  // …then two of theirs that together make one of ours (money + TDS booked apart).
  const open = credits.filter((e) => !e.done);
  for (const o of ourDebits.filter((x) => !used.has(x.id))) {
    let found = null;
    for (let a = 0; a < open.length && !found; a++) {
      for (let b = a + 1; b < open.length && !found; b++) {
        const x = open[a]; const y = open[b];
        if (x.done || y.done) continue;
        if (Math.abs(x.credit + y.credit - o.debit) < 1 && near(x.t, y.t, 5) && near(o.t, x.t)) found = [x, y];
      }
    }
    if (found) {
      used.add(o.id);
      found.forEach((x) => { x.done = true; });
      matched.push({ theirs: strip(found[0]), alsoTheirs: strip(found[1]), ours: [shape(o)], by: 'two of theirs make one of ours', difference: 0 });
    }
  }

  const inPeriod = (o) => o.t != null && o.t >= from && o.t <= to;
  const onlyTheirs = theirs.filter((e) => !e.done).map((e) => ({
    ...strip(e),
    likely: e.debit > 0
      ? (e.kind === 'debit_note' ? 'A debit note of theirs we have no note for' : 'A bill of theirs not entered in our books')
      : e.kind === 'credit_note' ? 'A credit note of theirs not entered in our books'
        : e.kind === 'tds' ? 'TDS they show that no payment of ours carries'
          : 'A payment they show that is not in our books',
  }));
  const onlyOurs = our.filter((o) => !used.has(o.id) && inPeriod(o)).map((o) => ({
    ...shape(o),
    likely: o.credit > 0 ? 'A bill in our books they do not show — not billed by them, or under another number'
      : o.docType === 'Payment' ? 'A payment of ours they have not booked yet (in transit)'
        : 'A debit note of ours they have not accepted',
  }));

  // The balances at the end of their period: ours from every entry to then, theirs as printed.
  const upTo = await PartyLedgerEntry.aggregate([
    { $match: { partyType: 'supplier', party: supplier._id, date: { $lte: new Date(to + DAY - 1) } } },
    { $group: { _id: null, credit: { $sum: '$credit' }, debit: { $sum: '$debit' } } },
  ]);
  const ourBalance = r2((upTo[0]?.credit || 0) - (upTo[0]?.debit || 0));
  const theirBalance = read.closing != null ? r2(read.closing)
    : read.opening != null ? r2(read.opening + read.entries.filter((e) => e.kind !== 'opening').reduce((s, e) => s + e.debit - e.credit, 0)) : null;
  // A match whose entry of ours falls after their period is in their
  // balance and not yet in ours: its whole amount is a timing difference.
  const after = (m) => m.ours.some((o) => new Date(o.date).getTime() > to + DAY - 1);
  const effect = (e) => (e ? e.debit - e.credit : 0);
  for (const m of matched) m.timing = after(m);
  const explained = r2(
    onlyTheirs.reduce((s, e) => s + e.debit - e.credit, 0)
    - onlyOurs.reduce((s, o) => s + o.credit - o.debit, 0)
    + matched.reduce((s, m) => s + (m.timing ? effect(m.theirs) + effect(m.alsoTheirs) : (m.theirs.debit > 0 ? m.difference : -m.difference)), 0)
  );
  const difference = theirBalance == null ? null : r2(theirBalance - ourBalance);
  return {
    supplier: { _id: supplier._id, name: supplier.name, gstin: supplier.gstin || '' },
    period: { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) },
    matched, onlyTheirs, onlyOurs,
    balances: { ours: ourBalance, theirs: theirBalance, difference, explained, unexplained: difference == null ? null : r2(difference - explained) },
    gstinDiffers: !!(read.partyGstin && supplier.gstin && read.partyGstin !== String(supplier.gstin).toUpperCase()),
  };
}

function strip(e) { const { i, t, done, ...rest } = e; return rest; }
function shape(o) { return { docType: o.docType, doc: o.doc, docNo: o.docNo, theirNo: o.theirNo, date: o.date, debit: o.debit, credit: o.credit, narration: o.narration }; }

module.exports = { reconcile };

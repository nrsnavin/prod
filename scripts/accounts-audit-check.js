'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE ACCOUNTS FAULTS HAVE ALREADY LEFT IN THE BOOKS
//
//  Usage (from the repo root on the server):
//
//    node scripts/accounts-audit-check.js
//    node scripts/accounts-audit-check.js --db baluElastics
//    node scripts/accounts-audit-check.js --limit 50      rows shown per check (default 15)
//    node scripts/accounts-audit-check.js --json          the same, as JSON
//
//  READ-ONLY. It runs finds and aggregations and nothing else; it
//  changes nothing, and can be run on the live books at any time.
//
//  The accounts audit of 12 November 2026 found faults that could have
//  put wrong figures in the books before they were fixed: an invoice
//  due on its own date, a bank line posted twice, a year's depreciation
//  in twice, credit notes for more than their invoice. The code is
//  fixed; what it did before is still in the data. This lists each
//  case, by the finding's number in the audit, so a person can put it
//  right ON SCREEN (cancel and re-post, with a reason) and the trail
//  stays whole. Only the due dates are corrected by a migration.
//
//  It also lists the duplicates that would stop a new unique index from
//  being built (an IRN on two invoices, the same challan twice): the
//  server logs a failed index build and carries on without the index,
//  so these want clearing for the guard to be real.
//
//  Run it before `npx migrate-mongo up`, and again after.
// ══════════════════════════════════════════════════════════════════

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const money = (n) => r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const creditDays = (terms) => { const n = parseInt(terms, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0; };

/**
 * Every check, against a database handle (the driver's `Db`).
 * @returns [{ key, finding, title, count, rows: [string], note }]
 */
async function checks(db, { limit = 15 } = {}) {
  const c = (name) => db.collection(name);
  const out = [];
  const add = (key, finding, title, rows, note) => out.push({ key, finding, title, count: rows.length, rows: rows.slice(0, limit), note });

  // ── B-1  invoices due on their own date ─────────────────────────
  {
    const customers = new Map((await c('customers').find({}, { projection: { name: 1, paymentTerms: 1 } }).toArray()).map((x) => [String(x._id), x]));
    const invoices = await c('invoices').find({ status: { $ne: 'cancelled' }, invoiceDate: { $type: 'date' }, $or: [{ dueDate: null }, { dueDate: { $exists: false } }, { $expr: { $eq: ['$dueDate', '$invoiceDate'] } }] })
      .project({ invoiceNumber: 1, invoiceDate: 1, customer: 1, 'buyer.name': 1, 'totals.grand': 1 }).sort({ invoiceDate: 1 }).toArray();
    const rows = invoices.filter((i) => creditDays(customers.get(String(i.customer))?.paymentTerms) > 0)
      .map((i) => `${i.invoiceNumber}  ${day(i.invoiceDate)}  ${i.buyer?.name || ''}  ₹${money(i.totals?.grand)}  due on its own date; the customer has ${creditDays(customers.get(String(i.customer)).paymentTerms)} days`);
    add('due-dates', 'B-1', 'Invoices due on their own date, for customers with credit days', rows, 'The migration 20261112000001-invoice-due-dates corrects these and keeps a list of what it changed.');
  }

  // ── C-2  two posted journals for one source and period ───────────
  {
    const groups = await c('journals').aggregate([
      { $match: { status: 'posted', source: { $nin: ['manual', '', null] }, sourceRef: { $gt: '' } } },
      { $group: { _id: { source: '$source', ref: '$sourceRef' }, n: { $sum: 1 }, nos: { $push: '$journalNo' }, total: { $sum: '$total' } } },
      { $match: { n: { $gt: 1 } } }, { $sort: { '_id.source': 1, '_id.ref': 1 } },
    ]).toArray();
    add('journals-twice', 'C-2', 'Two posted journals for one source and period', groups.map((g) => `${g._id.source} ${g._id.ref}: ${g.nos.join(', ')}  (₹${money(g.total)} in the books, ${g.n} times)`),
      'Cancel all but one on screen. Until then the unique index on posted journals cannot be built.');
  }

  // ── C-1  the same bank line posted more than once ────────────────
  {
    const groups = await c('payments').aggregate([
      { $match: { status: 'posted', source: 'statement', statementLine: { $gt: '' } } },
      { $group: { _id: { account: '$account', line: '$statementLine', date: '$date', amount: '$amount', kind: '$kind' }, n: { $sum: 1 }, nos: { $push: '$voucherNo' }, name: { $first: '$accountName' } } },
      { $match: { n: { $gt: 1 } } }, { $sort: { '_id.date': 1 } },
    ]).toArray();
    add('bank-line-twice', 'C-1', 'Vouchers posted from the same bank line (same account, day, amount and narration)', groups.map((g) => `${g.name || g._id.account}  ${day(g._id.date)}  ₹${money(g._id.amount)}  ${g._id.kind}: ${g.nos.join(', ')}  — "${String(g._id.line).slice(0, 60)}"`),
      'Two real payments of the same amount with the same narration on one day look like this too: check each against the bank\'s statement before cancelling one.');
  }

  // ── B-2 / B-4  one voucher answering two different bank lines ────
  {
    const groups = await c('bankstatements').aggregate([
      { $unwind: '$lines' },
      { $match: { 'lines.voucher': { $ne: null }, 'lines.status': { $in: ['recorded', 'posted'] } } },
      { $group: { _id: '$lines.voucher', keys: { $addToSet: { key: '$lines.key', n: { $ifNull: ['$lines.occurrence', 1] }, account: '$account' } }, no: { $first: '$lines.voucherNo' }, amount: { $first: '$lines.amount' } } },
      { $match: { 'keys.1': { $exists: true } } },
    ]).toArray();
    add('voucher-two-lines', 'B-2, B-4', 'One voucher that two different bank lines point at', groups.map((g) => `${g.no || g._id}  ₹${money(g.amount)}: ${g.keys.length} lines`),
      'One of the lines never reached the books. Unlink the wrong one on the statement screen and place it. (Lines stored before occurrences were numbered may show here once and clear after the bank-line migration.)');
  }

  // ── C-4  credit notes for more than their invoice ────────────────
  {
    const groups = await c('accountnotes').aggregate([
      { $match: { status: 'issued', kind: 'credit', partyType: 'customer', 'against.docType': 'Invoice' } },
      { $group: { _id: '$against.doc', notes: { $sum: '$totals.grand' }, nos: { $push: '$noteNo' } } },
      { $lookup: { from: 'invoices', localField: '_id', foreignField: '_id', as: 'inv' } }, { $unwind: '$inv' },
      { $addFields: { room: { $add: [{ $ifNull: ['$inv.totals.grand', 0] }, { $ifNull: ['$inv.debitedAmount', 0] }] } } },
      { $match: { $expr: { $gt: ['$notes', { $add: ['$room', 0.005] }] } } },
    ]).toArray();
    add('notes-over-invoice', 'C-4', 'Credit notes adding up to more than their invoice', groups.map((g) => `${g.inv.invoiceNumber}  ₹${money(g.room)}: notes ₹${money(g.notes)}  (${g.nos.join(', ')})`), 'Cancel the note issued twice.');
  }

  // ── B-5  credit reversed under Rule 37, re-claimed only in part ──
  {
    const bills = await c('supplierbills').find({ status: 'paid', 'itcReversal.amount': { $gt: 0 }, $expr: { $gt: [{ $subtract: [{ $ifNull: ['$itcReversal.amount', 0] }, { $ifNull: ['$itcReversal.reclaimAmount', 0] }] }, 0.005] } })
      .project({ billNo: 1, supplierName: 1, itcReversal: 1 }).sort({ billDate: 1 }).toArray();
    add('itc-part-reclaimed', 'B-5', 'Bills paid in full whose reversed input credit has not all been re-claimed', bills.map((b) => `${b.billNo}  ${b.supplierName || ''}: reversed ₹${money(b.itcReversal.amount)}, re-claimed ₹${money(b.itcReversal.reclaimAmount)} — ₹${money(b.itcReversal.amount - (b.itcReversal.reclaimAmount || 0))} to re-claim`),
      'They are on the Rule 37 screen again, under "to re-claim": re-claim the rest there, for the month it is being claimed in.');
  }

  // ── B-6  a cancelled bill whose source is still marked entered ───
  {
    const service = await c('machineservicebills').aggregate([
      { $match: { supplierBill: { $ne: null } } },
      { $lookup: { from: 'supplierbills', localField: 'supplierBill', foreignField: '_id', as: 'bill' } }, { $unwind: '$bill' },
      { $match: { 'bill.status': 'cancelled' } }, { $project: { billNo: 1, vendor: 1, amount: 1, 'bill.billNo': 1 } },
    ]).toArray();
    const mailed = await c('inboxbills').aggregate([
      { $match: { status: 'entered', bill: { $ne: null } } },
      { $lookup: { from: 'supplierbills', localField: 'bill', foreignField: '_id', as: 'b' } }, { $unwind: '$b' },
      { $match: { 'b.status': 'cancelled' } }, { $project: { filename: 1, supplierName: 1, 'b.billNo': 1 } },
    ]).toArray();
    add('cancelled-bill-source', 'B-6', 'Cancelled bills whose service bill or mailed bill is still marked as entered', [
      ...service.map((s) => `service bill ${s.billNo || s._id} (${s.vendor || ''}, ₹${money(s.amount)}) was entered as ${s.bill.billNo}, which is cancelled`),
      ...mailed.map((m) => `mailed bill ${m.filename || m._id} (${m.supplierName || ''}) was entered as ${m.b.billNo}, which is cancelled`),
    ], 'These cannot be entered again as they stand. Cancelling a bill now frees its source; for these older ones, ask for them to be freed (one update each) or enter the bill by hand.');
  }

  // ── B-7  a deposit slip whose cash contra was cancelled alone ────
  {
    const slips = await c('depositslips').aggregate([
      { $match: { status: { $ne: 'cancelled' }, contra: { $ne: null } } },
      { $lookup: { from: 'contras', localField: 'contra', foreignField: '_id', as: 'c' } }, { $unwind: '$c' },
      { $match: { 'c.status': 'cancelled' } }, { $project: { slipNo: 1, date: 1, cash: 1, contraNo: 1 } },
    ]).toArray();
    add('slip-contra-cancelled', 'B-7', 'Deposit slips that still show cash whose contra is cancelled', slips.map((s) => `${s.slipNo}  ${day(s.date)}  cash ₹${money(s.cash)}  (${s.contraNo} cancelled)`), 'Cancel the slip on screen: its cheques go back in hand, and it stops showing cash that never went in.');
  }

  // ── I-1  entered inside a period after it was closed ─────────────
  {
    const settings = await c('accountssettings').findOne({ key: 'accounts' }, { projection: { lockDate: 1, lockedAt: 1 } });
    const rows = [];
    if (settings?.lockDate && settings?.lockedAt) {
      const upTo = new Date(new Date(settings.lockDate).getTime() + DAY - 1);
      const kinds = [['payments', 'date', 'voucherNo'], ['journals', 'date', 'journalNo'], ['supplierbills', 'billDate', 'billNo'], ['invoices', 'invoiceDate', 'invoiceNumber'], ['accountnotes', 'date', 'noteNo'], ['expenses', 'date', 'expenseNo'], ['contras', 'date', 'contraNo']];
      for (const [coll, field, no] of kinds) {
        const docs = await c(coll).find({ [field]: { $lte: upTo }, createdAt: { $gt: new Date(settings.lockedAt) }, 'fingerprints.meta.lockOverride': { $exists: false } }).project({ [no]: 1, [field]: 1, createdAt: 1, status: 1 }).sort({ createdAt: 1 }).limit(500).toArray();
        for (const d of docs) rows.push(`${d[no]}  dated ${day(d[field])}, entered ${day(d.createdAt)}${d.status === 'cancelled' ? '  (cancelled since)' : ''}`);
      }
    }
    add('into-closed-period', 'I-1', 'Entries dated inside the closed period and made after it was closed, with no override on record', rows,
      settings?.lockDate ? `The books are closed up to ${day(settings.lockDate)} (closed on ${day(settings.lockedAt)}). Payroll, depreciation and closing-stock journals could be posted into a closed year before; an admin override before 12 Nov 2026 left no record either, so some of these may have been meant.` : 'The books have never been closed: nothing to check.');
  }

  // ── S4  an opening balance posted twice ──────────────────────────
  {
    const groups = await c('openingbalances').aggregate([
      { $match: { status: 'posted' } },
      { $group: { _id: { partyType: '$partyType', party: { $ifNull: ['$customer', '$supplier'] }, kind: '$kind', date: '$date', ref: '$refNo', amount: '$amount' }, n: { $sum: 1 }, nos: { $push: '$docNo' }, name: { $first: '$partyName' } } },
      { $match: { n: { $gt: 1 } } }, { $sort: { name: 1 } },
    ]).toArray();
    add('opening-twice', 'I-4', 'Opening balances that are in twice (same party, side, date, reference and amount)', groups.map((g) => `${g.name}  ${g._id.kind}  ${day(g._id.date)}  ${g._id.ref || '—'}  ₹${money(g._id.amount)}: ${g.nos.join(', ')}`), 'A file imported twice did this. Cancel the extra one of each.');
  }

  // ── C-8  invoice numbers drawn and never used ────────────────────
  {
    const burnt = new Set((await c('burntnumbers').find({ series: 'invoice' }).project({ number: 1 }).toArray()).map((b) => b.number));
    const byYear = await c('invoices').aggregate([{ $group: { _id: '$financialYear', seqs: { $push: '$sequence' }, max: { $max: '$sequence' } } }, { $sort: { _id: 1 } }]).toArray();
    const rows = [];
    for (const y of byYear) {
      const have = new Set(y.seqs);
      for (let s = 1; s <= (y.max || 0); s += 1) {
        const no = `INV/${y._id}/${String(s).padStart(4, '0')}`;
        if (!have.has(s) && !burnt.has(no)) rows.push(`${no} was never issued`);
      }
    }
    add('invoice-gaps', 'C-8', 'Gaps in the invoice series with nothing on record to explain them', rows, 'GSTR-1 lists the series from first to last number with those cancelled. A number lost before 12 Nov 2026 was not noted anywhere; note these for the return.');
  }

  // ── Q-8  duplicates that stop a unique index being built ─────────
  {
    const dup = async (coll, match, group, label) => (await c(coll).aggregate([{ $match: match }, { $group: { _id: group, n: { $sum: 1 }, ids: { $push: '$_id' } } }, { $match: { n: { $gt: 1 } } }]).toArray()).map((g) => `${label(g._id)}  ×${g.n}`);
    const rows = [
      ...(await dup('invoices', { 'einvoice.irn': { $gt: '' } }, '$einvoice.irn', (k) => `IRN ${String(k).slice(0, 16)}… on more than one invoice`)),
      ...(await dup('accountnotes', { 'einvoice.irn': { $gt: '' } }, '$einvoice.irn', (k) => `IRN ${String(k).slice(0, 16)}… on more than one note`)),
      ...(await dup('tdschallans', { challanNo: { $gt: '' } }, { month: '$month', section: '$section', bsr: '$bsrCode', no: '$challanNo', on: '$depositedOn', amount: '$amount' }, (k) => `TDS challan ${k.no} of ${day(k.on)} for ${k.month} ${k.section}, ₹${money(k.amount)}`)),
      ...(await dup('statutorydeposits', { challanNo: { $gt: '' } }, { kind: '$kind', month: '$month', no: '$challanNo', on: '$depositedOn', amount: '$amount' }, (k) => `${String(k.kind).toUpperCase()} deposit ${k.no} of ${day(k.on)} for ${k.month}, ₹${money(k.amount)}`)),
      ...(await dup('tdscertificates', { certNo: { $gt: '' } }, { kind: '$kind', party: '$party', fy: '$fy', q: '$quarter', section: '$section', no: '$certNo' }, (k) => `TDS certificate ${k.no} (${k.kind}) ${k.fy} ${k.q} ${k.section || ''}`)),
      ...(await dup('payments', { bankLine: { $gt: '' } }, '$bankLine', (k) => `bank line ${String(k).slice(-40)} on more than one voucher`)),
    ];
    add('index-blockers', 'Q-8', 'Records entered twice that stop a new unique index being built', rows, 'A challan or certificate entered twice also doubles what its register shows. Remove the extra one of each (they have no cancel screen: ask for it to be deleted), then restart the server so the index builds.');
  }

  return out;
}

function print(results, dbName) {
  const total = results.reduce((t, r) => t + r.count, 0);
  console.log(`Accounts audit check of "${dbName}" — read-only, nothing was changed.\n`);
  for (const r of results) {
    console.log(`${r.count === 0 ? 'OK  ' : '!!  '}[${r.finding}] ${r.title}: ${r.count === 0 ? 'none' : r.count}`);
    for (const row of r.rows) console.log(`      ${row}`);
    if (r.count > r.rows.length) console.log(`      … and ${r.count - r.rows.length} more (use --limit)`);
    if (r.count > 0 && r.note) console.log(`      → ${r.note}`);
  }
  console.log(`\n${total === 0 ? 'Nothing found.' : `${total} thing${total === 1 ? '' : 's'} to look at, in ${results.filter((r) => r.count).length} of ${results.length} checks.`}`);
  console.log('Also open Accounts → Health: it compares every running figure with its vouchers (an invoice left settled by a cancelled receipt shows there).');
}

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
  const mongoose = require('mongoose');
  const argv = process.argv.slice(2);
  const flagValue = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  if (!process.env.MONGO_URL) { console.error('MONGO_URL is not set — check config/.env'); process.exit(1); }
  const dbName = flagValue('--db');
  await mongoose.connect(process.env.MONGO_URL, dbName ? { dbName } : {});
  try {
    const db = mongoose.connection.db;
    const results = await checks(db, { limit: Number(flagValue('--limit')) || 15 });
    if (argv.includes('--json')) console.log(JSON.stringify({ database: db.databaseName, results }, null, 2));
    else print(results, db.databaseName);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { checks, print };

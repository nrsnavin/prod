'use strict';
// ══════════════════════════════════════════════════════════════════
//  VOUCHERS FOR TALLY
//
//  Every document in a period turned into the Tally voucher an
//  accountant would key, as Tally's XML import ("Import Data" →
//  Vouchers). Debits and credits per ledger, with the party lines
//  carrying bill-wise references so Tally's own outstanding agrees:
//
//    Invoice            Sales        Dr party · Cr sales, output GST
//    Supplier bill      Purchase     Cr party · Dr purchase / head, input GST
//    Expense (supplier) Journal      Cr supplier · Dr head, input GST
//    Credit note        Credit Note  Cr customer · Dr sales, output GST
//    Debit note         Debit Note   to a supplier: Dr supplier · Cr purchase, input GST
//                                    to a customer: Dr customer · Cr sales, output GST
//    Receipt            Receipt      Dr bank, adjustments · Cr party
//    Payment            Payment      Dr party (or expense heads) · Cr bank, TDS, adjustments
//    Contra             Contra       Dr the account it went to · Cr the one it left
//    Credit applied     Journal      the party both sides: its advance (or
//                                    note, or opening advance) "On Account"
//                                    against the bill it now settles
//    Cancelled here     Cancel       a voucher already sent, cancelled
//                                    in Tally by its type, number and date
//
//  ── Where the books and Tally used to drift, and why they do not ────
//  • Party ledgers are named from the customer / supplier on file — its
//    "Name in Tally" when set — never from the name typed on a document,
//    so a rename or a typo cannot open a second ledger in Tally.
//  • Bill-wise references are the ones Tally holds: the supplier's own
//    bill number, the expense's reference, an opening balance's old
//    Tally reference — on the document and on every voucher settling it.
//  • A note that could not all be set against its document goes with the
//    rest "On Account", as it stands here; applying it later is its own
//    journal, as is an advance applied to a later invoice.
//  • Dates are the day in India, whatever the server's clock.
//  • A document cancelled after it went is cancelled in Tally by the next
//    export, rather than staying live there.
//
//  Opening balances are not exported: they came from Tally. An expense
//  with no supplier is not a voucher of its own — the payment that
//  settles it debits its head.
//
//  build() returns the vouchers with their lines (each balanced to the
//  paisa, round-off absorbing any difference), the cancellations, and
//  what each party ledger needs (GSTIN, state, address) for its master.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const AccountNote = require('../models/AccountNote');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const OpeningBalance = require('../models/OpeningBalance');
const BankAccount = require('../models/BankAccount');
const ExpenseCategory = require('../models/ExpenseCategory');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const { stateName } = require('./gst');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const IST = 330 * 60_000;
/** The day in India, as Tally wants it: YYYYMMDD. */
const tallyDate = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10).replace(/-/g, '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The day in India as d-Mon-yyyy, the form Tally's voucher attributes take. */
const tallyAttrDate = (d) => { const x = new Date(new Date(d).getTime() + IST); return `${x.getUTCDate()}-${MON[x.getUTCMonth()]}-${x.getUTCFullYear()}`; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const TYPES = ['Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'Contra'];

/**
 * A voucher being built: dr()/cr() add to a ledger (same ledger lines
 * merge), party lines carry bill references.
 */
function voucher(type, { docType, doc, number, date, narration, reference, party, partyType, gstin = '', placeOfSupply = '', kind = 'voucher', key, extra = {} }) {
  const lines = [];
  const add = (ledger, amount, bills) => {
    const a = r2(amount);
    if (!ledger || !a) return;
    const hit = !bills && lines.find((l) => l.ledger === ledger && !l.bills);
    if (hit) hit.amount = r2(hit.amount + a);
    else lines.push({ ledger, amount: a, bills: bills || null });
  };
  return {
    type, docType, doc, number, date, narration: narration || '', reference: reference || '', party: party || '', partyType: partyType || null,
    gstin, placeOfSupply, kind, key: key || `${kind}:${docType}:${doc}`, ...extra, lines,
    dr(ledger, amount, bills) { add(ledger, amount, bills); },        // debit: positive
    cr(ledger, amount, bills) { add(ledger, -amount, bills); },       // credit: negative
  };
}

/** Make Σ = 0 exactly, putting a sub-rupee difference on round-off. */
function balance(v, roundOffLedger) {
  const sum = r2(v.lines.reduce((s, l) => s + l.amount, 0));
  if (sum !== 0 && Math.abs(sum) < 1) {
    v.dr(roundOffLedger, -sum);
    return true;
  }
  return sum === 0;
}

/**
 * GST lines: input on the debit side, output on the credit side.
 * `rcm`: tax owed under reverse charge, to its own ledgers when set.
 */
function taxLines(v, t, side, L, input, rcm = false) {
  const put = side === 'dr' ? v.dr : v.cr;
  const out = (k) => (rcm && L[`rcm${k}`]) || L[`output${k}`];
  put(input ? L.inputCgst : out('Cgst'), t.cgst || 0);
  put(input ? L.inputSgst : out('Sgst'), t.sgst || 0);
  put(input ? L.inputIgst : out('Igst'), t.igst || 0);
}

const VOUCHER_TYPE = {
  Invoice: () => 'Sales', SupplierBill: () => 'Purchase', Expense: () => 'Journal', Contra: () => 'Contra',
  AccountNote: (d) => (d.kind === 'credit' ? 'Credit Note' : 'Debit Note'),
  Payment: (d) => (d.kind === 'receipt' ? 'Receipt' : 'Payment'),
};
const NUMBER = { Invoice: 'invoiceNumber', SupplierBill: 'billNo', Expense: 'expenseNo', AccountNote: 'noteNo', Payment: 'voucherNo', Contra: 'contraNo' };
const DATE = { Invoice: 'invoiceDate', SupplierBill: 'billDate', Expense: 'date', AccountNote: 'date', Payment: 'date', Contra: 'date' };
const MODEL = { Invoice, SupplierBill, Expense, AccountNote, Payment, Contra };

const noBatch = (path) => ({ $or: [{ [path]: { $exists: false } }, { [path]: null }] });

/**
 * Collect the documents in a period and turn them into vouchers.
 * @param from,to   the period (inclusive)
 * @param fresh     only what has not gone to Tally yet
 * @param L         the ledger names (AccountsSettings.tally)
 */
async function build({ from, to, fresh = true, L }) {
  const range = { $gte: from, $lte: to };
  const notSent = fresh ? noBatch('tally.batch') : {};
  const [invoices, bills, expenses, notes, payments, contras, accounts, categories] = await Promise.all([
    Invoice.find({ status: 'issued', invoiceDate: range, ...notSent }).select('invoiceNumber invoiceDate customer buyer customerPo orderNo totals placeOfSupply tally').lean(),
    SupplierBill.find({ status: { $ne: 'cancelled' }, billDate: range, ...notSent }).select('billNo supplierBillNo billDate supplier supplierName supplierGstin kind category totals itc poNo tally reverseCharge rcm').lean(),
    Expense.find({ status: { $in: ['approved', 'paid'] }, date: range, ...notSent }).select('expenseNo date supplier payeeName refNo category categoryName description totals itc tally').lean(),
    AccountNote.find({ status: 'issued', date: range, ...notSent }).select('kind noteNo date partyType customer supplier partyName partyGstin against reason totals partyNoteNo applied unapplied applications tally').lean(),
    Payment.find({ status: 'posted', date: range, ...notSent }).lean(),
    Contra.find({ status: 'posted', date: range, ...notSent }).lean(),
    BankAccount.find({}).select('name tallyLedger').lean(),
    ExpenseCategory.find({}).select('name ledger').lean(),
  ]);

  // Cancelled here after they went: cancelled there, dated as sent.
  const cancelled = [];
  for (const t of TYPES) {
    const q = { status: 'cancelled', 'tally.batch': { $ne: null }, [DATE[t]]: range, ...(fresh ? noBatch('tally.cancelBatch') : {}) };
    for (const d of await MODEL[t].find(q).select(`${NUMBER[t]} ${DATE[t]} kind cancel`).lean()) {
      cancelled.push({ kind: 'cancel', key: `cancel:${t}:${d._id}`, docType: t, doc: d._id, type: VOUCHER_TYPE[t](d), number: d[NUMBER[t]], date: d[DATE[t]], narration: `Cancelled in the ERP${d.cancel?.reason ? `: ${d.cancel.reason}` : ''}` });
    }
  }

  // Credits applied later, in the period of their application.
  const applied = { $elemMatch: fresh ? { at: range, ...noBatch('tallyBatch') } : { at: range } };
  const appliedPay = { $elemMatch: fresh ? { appliedAt: range, ...noBatch('tallyBatch') } : { appliedAt: range } };
  const [paySources, noteSources, obSources] = await Promise.all([
    Payment.find({ status: 'posted', allocations: appliedPay }).select('kind voucherNo partyType customer supplier partyName allocations').lean(),
    AccountNote.find({ status: 'issued', applications: applied }).select('kind noteNo partyType customer supplier partyName applications').lean(),
    OpeningBalance.find({ status: 'posted', kind: 'advance', applications: applied }).select('docNo refNo partyType customer supplier partyName applications').lean(),
  ]);

  const acct = new Map(accounts.map((a) => [String(a._id), a.tallyLedger || a.name]));
  const head = new Map(categories.map((c) => [String(c._id), c.ledger || '']));
  const headOf = (category, fallbackName) => head.get(String(category)) || fallbackName || L.sundryExpenses;

  // ── The parties, as Tally knows them ──────────────────────────────
  const ids = { customer: new Set(), supplier: new Set() };
  const note = (type, id) => { if (id) ids[type].add(String(id)); };
  invoices.forEach((i) => note('customer', i.customer));
  bills.forEach((b) => note('supplier', b.supplier));
  expenses.forEach((e) => note('supplier', e.supplier));
  notes.forEach((n) => note(n.partyType, n.partyType === 'customer' ? n.customer : n.supplier));
  payments.forEach((p) => { if (p.partyType === 'customer') note('customer', p.customer); if (p.partyType === 'supplier') note('supplier', p.supplier); });
  [...paySources, ...noteSources, ...obSources].forEach((s) => note(s.partyType, s.partyType === 'customer' ? s.customer : s.supplier));
  const [custs, supps] = await Promise.all([
    Customer.find({ _id: { $in: [...ids.customer] } }).select('name tallyName gstin stateCode address city pincode').lean(),
    Supplier.find({ _id: { $in: [...ids.supplier] } }).select('name tallyName gstin gstRegistration address').lean(),
  ]);
  const partyInfo = new Map();
  const ledgerOf = { customer: new Map(), supplier: new Map() };
  for (const c of custs) {
    const name = (c.tallyName || c.name || '').trim();
    ledgerOf.customer.set(String(c._id), name);
    partyInfo.set(name, { gstin: c.gstin || '', state: stateName(c.stateCode || String(c.gstin || '').slice(0, 2)), address: [c.address, c.city, c.pincode].filter(Boolean).join(', '), registration: c.gstin ? 'Regular' : 'Unregistered' });
  }
  for (const s of supps) {
    const name = (s.tallyName || s.name || '').trim();
    ledgerOf.supplier.set(String(s._id), name);
    partyInfo.set(name, { gstin: s.gstin || '', state: stateName(String(s.gstin || '').slice(0, 2)), address: s.address || '', registration: s.gstRegistration === 'composition' ? 'Composition' : s.gstRegistration === 'unregistered' || !s.gstin ? 'Unregistered' : 'Regular' });
  }
  /** The party ledger: the master's name in Tally, else what the document says. */
  const party = (type, id, fallback) => ledgerOf[type].get(String(id)) || fallback || (type === 'customer' ? 'Customer' : 'Supplier');

  // ── The bill-wise names Tally holds ───────────────────────────────
  const want = { SupplierBill: new Set(), Expense: new Set(), OpeningBalance: new Set() };
  const wantRef = (docType, id) => { if (want[docType] && id) want[docType].add(String(id)); };
  for (const p of [...payments, ...paySources]) for (const a of p.allocations || []) wantRef(a.docType, a.doc);
  for (const n of [...notes, ...noteSources]) { if (n.against) wantRef(n.against.docType, n.against.doc); for (const a of n.applications || []) wantRef(a.docType, a.doc); }
  for (const o of obSources) for (const a of o.applications || []) wantRef(a.docType, a.doc);
  const [refBills, refExpenses, refObs] = await Promise.all([
    SupplierBill.find({ _id: { $in: [...want.SupplierBill] } }).select('billNo supplierBillNo').lean(),
    Expense.find({ _id: { $in: [...want.Expense] } }).select('expenseNo refNo supplier category categoryName totals itc').lean(),
    OpeningBalance.find({ _id: { $in: [...want.OpeningBalance] } }).select('docNo refNo').lean(),
  ]);
  const billRef = new Map(refBills.map((b) => [String(b._id), b.supplierBillNo || b.billNo]));
  const expRef = new Map(refExpenses.map((e) => [String(e._id), e.refNo || e.expenseNo]));
  const obRef = new Map(refObs.map((o) => [String(o._id), o.refNo || o.docNo]));
  const expById = new Map(refExpenses.map((e) => [String(e._id), e]));
  /** The name Tally knows a document by, for bill-wise allocation. */
  const refOf = (docType, id, fallback) => (docType === 'SupplierBill' ? billRef.get(String(id)) : docType === 'Expense' ? expRef.get(String(id)) : docType === 'OpeningBalance' ? obRef.get(String(id)) : null) || fallback;

  const out = [];
  const problems = [];
  const warnings = [];
  const finish = (v) => { if (!balance(v, L.roundOff)) problems.push(`${v.number} does not balance`); out.push(v); };

  for (const inv of invoices) {
    const t = inv.totals || {};
    const p = party('customer', inv.customer, inv.buyer?.name);
    const pos = /^\d{2}$/.test(String(inv.placeOfSupply || '')) ? stateName(inv.placeOfSupply) : (inv.placeOfSupply || stateName(String(inv.buyer?.gstin || '').slice(0, 2)));
    const v = voucher('Sales', { docType: 'Invoice', doc: inv._id, number: inv.invoiceNumber, date: inv.invoiceDate, party: p, partyType: 'customer', gstin: inv.buyer?.gstin || '', placeOfSupply: pos, reference: inv.customerPo || '', narration: `Order #${inv.orderNo ?? ''}`.trim() });
    v.dr(p, t.grand, [{ name: inv.invoiceNumber, type: 'New Ref', amount: t.grand }]);
    v.cr(L.sales, t.taxable);
    taxLines(v, t, 'cr', L, false);
    v.cr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const b of bills) {
    const t = b.totals || {};
    const p = party('supplier', b.supplier, b.supplierName);
    const ledger = b.kind === 'service' && b.category ? headOf(b.category, L.purchase) : L.purchase;
    const v = voucher('Purchase', { docType: 'SupplierBill', doc: b._id, number: b.billNo, date: b.billDate, party: p, partyType: 'supplier', gstin: b.supplierGstin || partyInfo.get(p)?.gstin || '', reference: b.supplierBillNo, narration: `Bill ${b.supplierBillNo}${b.poNo ? ` · PO #${b.poNo}` : ''}` });
    v.cr(p, t.grand, [{ name: b.supplierBillNo || b.billNo, type: 'New Ref', amount: t.grand }]);
    const itc = b.itc?.eligible !== false;
    v.dr(ledger, itc ? t.taxable : r2((t.taxable || 0) + (t.tax || 0)));
    if (itc) taxLines(v, t, 'dr', L, true);
    // Reverse charge: we owe the tax (output) and claim it (input).
    if (b.reverseCharge && b.rcm?.tax) {
      if (itc) taxLines(v, b.rcm, 'dr', L, true); else v.dr(ledger, b.rcm.tax);
      taxLines(v, b.rcm, 'cr', L, false, true);
    }
    if (b.kind === 'service' && !b.category) warnings.push(`${b.billNo} (${b.supplierName}) is a service bill with no expense head — it posts to ${L.purchase}`);
    v.dr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const e of expenses) {
    if (!e.supplier) continue; // its payment debits the head
    const t = e.totals || {};
    // The supplier's ledger is its name on file; the payee typed on the
    // expense may be spelt another way, and Tally would take it as new.
    const p = party('supplier', e.supplier, e.payeeName);
    const v = voucher('Journal', { docType: 'Expense', doc: e._id, number: e.expenseNo, date: e.date, party: p, partyType: 'supplier', reference: e.refNo || '', narration: `${e.categoryName}: ${e.description}` });
    v.cr(p, t.grand, [{ name: e.refNo || e.expenseNo, type: 'New Ref', amount: t.grand }]);
    const itc = !!e.itc?.eligible;
    v.dr(headOf(e.category, L.sundryExpenses), itc ? t.taxable : r2((t.taxable || 0) + (t.tax || 0)));
    if (itc) taxLines(v, t, 'dr', L, true);
    v.dr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const n of notes) {
    const t = n.totals || {};
    const toCustomer = n.partyType === 'customer';
    const p = party(n.partyType, toCustomer ? n.customer : n.supplier, n.partyName);
    const ref = n.against ? refOf(n.against.docType, n.against.doc, n.against.docNo) : n.noteNo;
    const type = n.kind === 'credit' ? 'Credit Note' : 'Debit Note';
    const v = voucher(type, { docType: 'AccountNote', doc: n._id, number: n.noteNo, date: n.date, party: p, partyType: n.partyType, gstin: n.partyGstin || '', reference: n.partyNoteNo || '', narration: `${n.reason} (${n.against?.docNo || ''})` });
    // What it set against its own document then, by that document's name;
    // the rest stands "On Account", as it does here, until applied.
    const first = n.applied === undefined || n.applied === null ? r2(t.grand) : r2(n.applied);
    const onAccount = r2((t.grand || 0) - first);
    const bills = [
      ...(first > 0.005 ? [{ name: ref, type: 'Agst Ref', amount: first }] : []),
      ...(onAccount > 0.005 ? [{ name: n.noteNo, type: 'On Account', amount: onAccount }] : []),
    ];
    if (n.kind === 'credit') {
      // To a customer: their account down, sales and output tax back.
      v.cr(p, t.grand, bills);
      v.dr(L.sales, t.taxable);
      taxLines(v, t, 'dr', L, false);
      v.dr(L.roundOff, -(t.roundOff || 0));
    } else if (toCustomer) {
      v.dr(p, t.grand, [{ name: ref, type: 'Agst Ref', amount: t.grand }]);
      v.cr(L.sales, t.taxable);
      taxLines(v, t, 'cr', L, false);
      v.cr(L.roundOff, t.roundOff || 0);
    } else {
      v.dr(p, t.grand, bills);
      v.cr(L.purchase, t.taxable);
      taxLines(v, t, 'cr', L, true);
      v.cr(L.roundOff, t.roundOff || 0);
    }
    finish(v);
  }

  const ADJ_RECEIPT = { bank_charges: L.bankCharges, discount: L.discountAllowed, tds_by_customer: L.tdsReceivable, round_off: L.roundOff, write_off: L.badDebts };
  const ADJ_PAYMENT = { discount: L.discountReceived, round_off: L.roundOff, write_off: L.writtenBack };
  for (const pay of payments) {
    const bank = acct.get(String(pay.account)) || pay.accountName || 'Bank';
    const adjustments = pay.adjustments || [];
    const adjTotal = r2(adjustments.reduce((s, a) => s + a.amount, 0));
    const tds = r2(pay.tds?.amount || 0);
    const settled = r2(pay.amount + tds + adjTotal);
    const p = pay.partyType === 'customer' ? party('customer', pay.customer, pay.partyName) : pay.partyType === 'supplier' ? party('supplier', pay.supplier, pay.partyName) : pay.partyName;
    // Allocations made later (an advance applied) go as their own journal.
    const live = (pay.allocations || []).filter((a) => !a.appliedAt);
    const bills = (onAccount) => [
      ...live.map((a) => ({ name: refOf(a.docType, a.doc, a.docNo), type: 'Agst Ref', amount: a.amount })),
      ...(onAccount > 0.005 ? [{ name: pay.voucherNo, type: 'On Account', amount: onAccount }] : []),
    ];
    const v = voucher(pay.kind === 'receipt' ? 'Receipt' : 'Payment', { docType: 'Payment', doc: pay._id, number: pay.voucherNo, date: pay.date, party: p, partyType: pay.partyType === 'other' ? null : pay.partyType, reference: pay.reference || '', narration: pay.narration || `${pay.kind === 'receipt' ? 'Received from' : 'Paid to'} ${pay.partyName}` });
    const onAccount = r2(settled - live.reduce((s, a) => s + a.amount, 0));
    if (pay.kind === 'receipt') {
      v.dr(bank, pay.amount);
      for (const a of adjustments) v.dr(ADJ_RECEIPT[a.kind] || L.roundOff, a.amount);
      if (pay.partyType === 'other') v.cr(p, settled);
      else v.cr(p, settled, bills(onAccount));
    } else {
      v.cr(bank, pay.amount);
      v.cr(L.tdsPayable, tds);
      for (const a of adjustments) v.cr(ADJ_PAYMENT[a.kind] || L.roundOff, a.amount);
      if (pay.partyType === 'supplier') {
        v.dr(p, settled, bills(onAccount));
      } else {
        // Not a supplier on file: the expenses it settles debit their heads.
        let left = settled;
        for (const a of live) {
          const e = a.docType === 'Expense' ? expById.get(String(a.doc)) : null;
          if (!e) continue;
          const t = e.totals || {};
          const share = t.grand ? a.amount / t.grand : 1;
          const itc = !!e.itc?.eligible;
          const tax = { cgst: r2((t.cgst || 0) * share), sgst: r2((t.sgst || 0) * share), igst: r2((t.igst || 0) * share) };
          const taxTotal = itc ? r2(tax.cgst + tax.sgst + tax.igst) : 0;
          v.dr(headOf(e.category, L.sundryExpenses), r2(a.amount - taxTotal));
          if (itc) taxLines(v, tax, 'dr', L, true);
          left = r2(left - a.amount);
        }
        v.dr(L.sundryExpenses, left);
      }
    }
    finish(v);
  }

  for (const c of contras) {
    const v = voucher('Contra', { docType: 'Contra', doc: c._id, number: c.contraNo, date: c.date, party: '', reference: c.reference || '', narration: c.narration || `${c.fromName} to ${c.toName}` });
    v.dr(acct.get(String(c.to)) || c.toName, c.amount);
    v.cr(acct.get(String(c.from)) || c.fromName, c.amount);
    finish(v);
  }

  // ── Credits applied later: the party both sides of a journal ─────
  // A customer's advance sits as a credit "On Account"; setting it
  // against an invoice debits it off and credits the invoice. For a
  // supplier, the other way round.
  const applications = [];
  for (const s of paySources) {
    (s.allocations || []).forEach((a, i) => { if (a.appliedAt && a.appliedAt >= from && a.appliedAt <= to && (!fresh || !a.tallyBatch)) applications.push({ src: s, srcType: 'Payment', srcNo: s.voucherNo, srcBill: { name: s.voucherNo, type: 'On Account' }, a, at: a.appliedAt, i }); });
  }
  for (const s of noteSources) {
    (s.applications || []).forEach((a, i) => { if (a.at >= from && a.at <= to && (!fresh || !a.tallyBatch)) applications.push({ src: s, srcType: 'AccountNote', srcNo: s.noteNo, srcBill: { name: s.noteNo, type: 'On Account' }, a, at: a.at, i }); });
  }
  for (const s of obSources) {
    (s.applications || []).forEach((a, i) => { if (a.at >= from && a.at <= to && (!fresh || !a.tallyBatch)) applications.push({ src: s, srcType: 'OpeningBalance', srcNo: s.docNo, srcBill: s.refNo ? { name: s.refNo, type: 'Agst Ref' } : { name: s.docNo, type: 'On Account' }, a, at: a.at, i }); });
  }
  for (const x of applications) {
    const pt = x.src.partyType;
    const p = party(pt, pt === 'customer' ? x.src.customer : x.src.supplier, x.src.partyName);
    const target = { name: refOf(x.a.docType, x.a.doc, x.a.docNo), type: 'Agst Ref', amount: x.a.amount };
    const v = voucher('Journal', {
      docType: x.srcType, doc: x.src._id, number: `${x.srcNo}/ADJ${x.i + 1}`, date: x.at, party: p, partyType: pt,
      narration: `${x.srcNo} set against ${x.a.docNo}`, kind: 'application',
      key: `application:${x.srcType}:${x.src._id}:${x.a.doc}:${new Date(x.at).getTime()}`,
      extra: { target: x.a.doc, at: x.at },
    });
    if (pt === 'customer') {
      v.dr(p, x.a.amount, [{ ...x.srcBill, amount: x.a.amount }]);
      v.cr(p, x.a.amount, [target]);
    } else {
      v.cr(p, x.a.amount, [{ ...x.srcBill, amount: x.a.amount }]);
      v.dr(p, x.a.amount, [target]);
    }
    finish(v);
  }

  out.sort((a, b) => new Date(a.date) - new Date(b.date) || a.number.localeCompare(b.number));
  return { vouchers: out, cancels: cancelled, problems, warnings, partyInfo };
}

/** Parties that appear, by side, for optional ledger masters. */
function partiesOf(vouchers) {
  const debtors = new Set(); const creditors = new Set();
  for (const v of vouchers) {
    if (!v.party || !v.partyType) continue;
    (v.partyType === 'customer' ? debtors : creditors).add(v.party);
  }
  return { debtors: [...debtors], creditors: [...creditors].filter((p) => !debtors.has(p)) };
}

function ledgerLine(l) {
  // Tally: a debit is ISDEEMEDPOSITIVE Yes with a negative AMOUNT.
  const debit = l.amount > 0;
  const amt = (debit ? -1 : 1) * Math.abs(l.amount);
  const bills = (l.bills || []).map((b) => (
    `<BILLALLOCATIONS.LIST><NAME>${esc(b.name)}</NAME><BILLTYPE>${esc(b.type)}</BILLTYPE><AMOUNT>${((debit ? -1 : 1) * Math.abs(b.amount)).toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>`
  )).join('');
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${l.bills ? 'Yes' : 'No'}</ISPARTYLEDGER><AMOUNT>${amt.toFixed(2)}</AMOUNT>${bills}</ALLLEDGERENTRIES.LIST>`;
}

/** One voucher as a <TALLYMESSAGE>. */
function voucherMessage(v) {
  return [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${tallyDate(v.date)}</DATE><EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`,
    v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : '',
    v.party ? `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>` : '',
    v.gstin ? `<PARTYGSTIN>${esc(v.gstin)}</PARTYGSTIN>` : '',
    v.placeOfSupply ? `<PLACEOFSUPPLY>${esc(v.placeOfSupply)}</PLACEOFSUPPLY>` : '',
    `<NARRATION>${esc(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    ...v.lines.map(ledgerLine),
    '</VOUCHER></TALLYMESSAGE>',
  ].join('');
}

/** A voucher already in Tally, cancelled there by its type, number and date. */
function cancelMessage(c) {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER DATE="${tallyAttrDate(c.date)}" TAGNAME="Voucher Number" TAGVALUE="${esc(c.number)}" VCHTYPE="${esc(c.type)}" ACTION="Cancel"><NARRATION>${esc(c.narration)}</NARRATION></VOUCHER></TALLYMESSAGE>`;
}

/** A party ledger, with what Tally's GST reports need of it. */
function masterMessage(name, group, info = {}) {
  return [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create">`,
    `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(group)}</PARENT><ISBILLWISEON>Yes</ISBILLWISEON>`,
    info.address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(info.address)}</ADDRESS></ADDRESS.LIST>` : '',
    info.state ? `<LEDSTATENAME>${esc(info.state)}</LEDSTATENAME>` : '',
    '<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>',
    info.registration ? `<GSTREGISTRATIONTYPE>${esc(info.registration)}</GSTREGISTRATIONTYPE>` : '',
    info.gstin ? `<PARTYGSTIN>${esc(info.gstin)}</PARTYGSTIN>` : '',
    '</LEDGER></TALLYMESSAGE>',
  ].join('');
}

/**
 * Everything an export sends, one message each, in the order Tally needs:
 * party ledgers, then vouchers by date, then cancellations.
 * Each carries what it stamps, so a refused one can be put back.
 */
function messagesOf({ vouchers, cancels = [], masters = null, partyInfo = new Map() }) {
  const msgs = [];
  if (masters) {
    for (const [group, names] of [[masters.debtorsGroup, masters.debtors], [masters.creditorsGroup, masters.creditors]]) {
      for (const name of names) msgs.push({ key: `master:${name}`, kind: 'master', number: name, xml: masterMessage(name, group, partyInfo.get(name)) });
    }
  }
  for (const v of vouchers) msgs.push({ key: v.key, kind: v.kind, docType: v.docType, doc: v.doc, number: v.number, ...(v.kind === 'application' ? { target: v.target, at: v.at } : {}), xml: voucherMessage(v) });
  for (const c of cancels) msgs.push({ key: c.key, kind: 'cancel', docType: c.docType, doc: c.doc, number: c.number, xml: cancelMessage(c) });
  return msgs;
}

/** The whole export as one file to import. */
function toXml(vouchers, { company = '', masters = null, cancels = [], partyInfo = new Map() } = {}) {
  const { envelope } = require('./tallyQueue');
  return envelope(messagesOf({ vouchers, cancels, masters, partyInfo }).map((m) => m.xml), { company, masters: !!masters });
}

/** What each kind of document came to, for the preview. */
function countOf(vouchers, cancels = []) {
  const c = {};
  for (const v of vouchers) { const k = v.kind === 'application' ? 'Credit applied' : v.type; c[k] = (c[k] || 0) + 1; }
  if (cancels.length) c.Cancellations = cancels.length;
  return c;
}

const ledgersOf = (vouchers) => [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)))].sort();

module.exports = { build, toXml, messagesOf, voucherMessage, cancelMessage, masterMessage, countOf, ledgersOf, partiesOf, TYPES, tallyDate, tallyAttrDate, esc };

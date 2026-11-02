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
//
//  Opening balances are not exported: they came from Tally. An expense
//  with no supplier is not a voucher of its own — the payment that
//  settles it debits its head.
//
//  build() returns the vouchers with their lines (each balanced to the
//  paisa, round-off absorbing any difference) and the XML.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const AccountNote = require('../models/AccountNote');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const BankAccount = require('../models/BankAccount');
const ExpenseCategory = require('../models/ExpenseCategory');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const tallyDate = (d) => { const x = new Date(d); return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const TYPES = ['Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'Contra'];

/**
 * A voucher being built: dr()/cr() add to a ledger (same ledger lines
 * merge), party lines carry bill references.
 */
function voucher(type, { docType, doc, number, date, narration, reference, party, partyType }) {
  const lines = [];
  const add = (ledger, amount, bills) => {
    const a = r2(amount);
    if (!ledger || !a) return;
    const hit = !bills && lines.find((l) => l.ledger === ledger && !l.bills);
    if (hit) hit.amount = r2(hit.amount + a);
    else lines.push({ ledger, amount: a, bills: bills || null });
  };
  return {
    type, docType, doc, number, date, narration: narration || '', reference: reference || '', party: party || '', partyType: partyType || null, lines,
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

/** GST lines: input on the debit side, output on the credit side. */
function taxLines(v, t, side, L, input) {
  const put = side === 'dr' ? v.dr : v.cr;
  put(input ? L.inputCgst : L.outputCgst, t.cgst || 0);
  put(input ? L.inputSgst : L.outputSgst, t.sgst || 0);
  put(input ? L.inputIgst : L.outputIgst, t.igst || 0);
}

/**
 * Collect the documents in a period and turn them into vouchers.
 * @param from,to   the period (inclusive)
 * @param fresh     only documents not yet sent to Tally
 * @param L         the ledger names (AccountsSettings.tally)
 */
async function build({ from, to, fresh = true, L }) {
  const range = { $gte: from, $lte: to };
  const notSent2 = fresh ? { $or: [{ 'tally.batch': { $exists: false } }, { 'tally.batch': null }] } : {};
  const [invoices, bills, expenses, notes, payments, contras, accounts, categories] = await Promise.all([
    Invoice.find({ status: 'issued', invoiceDate: range, ...notSent2 }).select('invoiceNumber invoiceDate buyer customerPo orderNo totals tally').lean(),
    SupplierBill.find({ status: { $ne: 'cancelled' }, billDate: range, ...notSent2 }).select('billNo supplierBillNo billDate supplierName kind category totals itc poNo tally reverseCharge rcm').lean(),
    Expense.find({ status: { $in: ['approved', 'paid'] }, date: range, ...notSent2 }).select('expenseNo date supplier payeeName refNo category categoryName description totals itc tally').lean(),
    AccountNote.find({ status: 'issued', date: range, ...notSent2 }).select('kind noteNo date partyType partyName against reason totals partyNoteNo tally').lean(),
    Payment.find({ status: 'posted', date: range, ...notSent2 }).lean(),
    Contra.find({ status: 'posted', date: range, ...notSent2 }).lean(),
    BankAccount.find({}).select('name tallyLedger').lean(),
    ExpenseCategory.find({}).select('name ledger').lean(),
  ]);
  const acct = new Map(accounts.map((a) => [String(a._id), a.tallyLedger || a.name]));
  const head = new Map(categories.map((c) => [String(c._id), c.ledger || '']));
  const headOf = (category, fallbackName) => head.get(String(category)) || fallbackName || L.sundryExpenses;

  // Expenses and bills a payment may settle: their heads, tax split and supplier numbers.
  const expIds = new Set(); const billIds = new Set();
  for (const p of payments) for (const a of p.allocations || []) {
    if (a.docType === 'Expense') expIds.add(String(a.doc));
    if (a.docType === 'SupplierBill') billIds.add(String(a.doc));
  }
  const [allocExpenses, allocBills] = await Promise.all([
    Expense.find({ _id: { $in: [...expIds] } }).select('expenseNo supplier category categoryName totals itc').lean(),
    SupplierBill.find({ _id: { $in: [...billIds] } }).select('billNo supplierBillNo').lean(),
  ]);
  const expById = new Map(allocExpenses.map((e) => [String(e._id), e]));
  const billRef = new Map(allocBills.map((b) => [String(b._id), b.supplierBillNo || b.billNo]));
  const noteRefBill = new Set(notes.filter((n) => n.against?.docType === 'SupplierBill').map((n) => String(n.against.doc)));
  const notesBills = noteRefBill.size ? await SupplierBill.find({ _id: { $in: [...noteRefBill] } }).select('supplierBillNo billNo').lean() : [];
  for (const b of notesBills) billRef.set(String(b._id), b.supplierBillNo || b.billNo);

  const out = [];
  const problems = [];
  const finish = (v) => { if (!balance(v, L.roundOff)) problems.push(`${v.number} does not balance`); out.push(v); };

  for (const inv of invoices) {
    const t = inv.totals || {};
    const party = inv.buyer?.name || 'Customer';
    const v = voucher('Sales', { docType: 'Invoice', doc: inv._id, number: inv.invoiceNumber, date: inv.invoiceDate, party, partyType: 'customer', reference: inv.customerPo || '', narration: `Order #${inv.orderNo ?? ''}`.trim() });
    v.dr(party, t.grand, [{ name: inv.invoiceNumber, type: 'New Ref', amount: t.grand }]);
    v.cr(L.sales, t.taxable);
    taxLines(v, t, 'cr', L, false);
    v.cr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const b of bills) {
    const t = b.totals || {};
    const ledger = b.kind === 'service' && b.category ? headOf(b.category, L.purchase) : L.purchase;
    const v = voucher('Purchase', { docType: 'SupplierBill', doc: b._id, number: b.billNo, date: b.billDate, party: b.supplierName, partyType: 'supplier', reference: b.supplierBillNo, narration: `Bill ${b.supplierBillNo}${b.poNo ? ` · PO #${b.poNo}` : ''}` });
    v.cr(b.supplierName, t.grand, [{ name: b.supplierBillNo, type: 'New Ref', amount: t.grand }]);
    const itc = b.itc?.eligible !== false;
    v.dr(ledger, itc ? t.taxable : r2((t.taxable || 0) + (t.tax || 0)));
    if (itc) taxLines(v, t, 'dr', L, true);
    // Reverse charge: we owe the tax (output) and claim it (input).
    if (b.reverseCharge && b.rcm?.tax) {
      if (itc) taxLines(v, b.rcm, 'dr', L, true); else v.dr(ledger, b.rcm.tax);
      taxLines(v, b.rcm, 'cr', L, false);
    }
    v.dr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const e of expenses) {
    if (!e.supplier) continue; // its payment debits the head
    const t = e.totals || {};
    const party = e.payeeName || 'Supplier';
    const v = voucher('Journal', { docType: 'Expense', doc: e._id, number: e.expenseNo, date: e.date, party, partyType: 'supplier', reference: e.refNo || '', narration: `${e.categoryName}: ${e.description}` });
    v.cr(party, t.grand, [{ name: e.refNo || e.expenseNo, type: 'New Ref', amount: t.grand }]);
    const itc = !!e.itc?.eligible;
    v.dr(headOf(e.category, L.sundryExpenses), itc ? t.taxable : r2((t.taxable || 0) + (t.tax || 0)));
    if (itc) taxLines(v, t, 'dr', L, true);
    v.dr(L.roundOff, t.roundOff || 0);
    finish(v);
  }

  for (const n of notes) {
    const t = n.totals || {};
    const party = n.partyName;
    const toCustomer = n.partyType === 'customer';
    const ref = n.against?.docType === 'SupplierBill' ? billRef.get(String(n.against.doc)) || n.against.docNo : n.against?.docNo;
    const type = n.kind === 'credit' ? 'Credit Note' : 'Debit Note';
    const v = voucher(type, { docType: 'AccountNote', doc: n._id, number: n.noteNo, date: n.date, party, partyType: n.partyType, reference: n.partyNoteNo || '', narration: `${n.reason} (${n.against?.docNo || ''})` });
    if (n.kind === 'credit') {
      // To a customer: their account down, sales and output tax back.
      v.cr(party, t.grand, [{ name: ref, type: 'Agst Ref', amount: t.grand }]);
      v.dr(L.sales, t.taxable);
      taxLines(v, t, 'dr', L, false);
      v.dr(L.roundOff, -(t.roundOff || 0));
    } else if (toCustomer) {
      v.dr(party, t.grand, [{ name: ref, type: 'Agst Ref', amount: t.grand }]);
      v.cr(L.sales, t.taxable);
      taxLines(v, t, 'cr', L, false);
      v.cr(L.roundOff, t.roundOff || 0);
    } else {
      v.dr(party, t.grand, [{ name: ref, type: 'Agst Ref', amount: t.grand }]);
      v.cr(L.purchase, t.taxable);
      taxLines(v, t, 'cr', L, true);
      v.cr(L.roundOff, t.roundOff || 0);
    }
    finish(v);
  }

  const ADJ_RECEIPT = { bank_charges: L.bankCharges, discount: L.discountAllowed, tds_by_customer: L.tdsReceivable, round_off: L.roundOff, write_off: L.badDebts };
  const ADJ_PAYMENT = { discount: L.discountReceived, round_off: L.roundOff, write_off: L.writtenBack };
  for (const p of payments) {
    const bank = acct.get(String(p.account)) || p.accountName || 'Bank';
    const adjustments = p.adjustments || [];
    const adjTotal = r2(adjustments.reduce((s, a) => s + a.amount, 0));
    const tds = r2(p.tds?.amount || 0);
    const settled = r2(p.amount + tds + adjTotal);
    const refOf = (a) => (a.docType === 'SupplierBill' ? billRef.get(String(a.doc)) || a.docNo : a.docNo);
    // Allocations made later (an advance applied) are not on this voucher in Tally.
    const live = (p.allocations || []).filter((a) => !a.appliedAt);
    const bills = (onAccount) => [
      ...live.map((a) => ({ name: refOf(a), type: 'Agst Ref', amount: a.amount })),
      ...(onAccount > 0.005 ? [{ name: p.voucherNo, type: 'On Account', amount: onAccount }] : []),
    ];
    const v = voucher(p.kind === 'receipt' ? 'Receipt' : 'Payment', { docType: 'Payment', doc: p._id, number: p.voucherNo, date: p.date, party: p.partyName, partyType: p.partyType === 'other' ? null : p.partyType, reference: p.reference || '', narration: p.narration || `${p.kind === 'receipt' ? 'Received from' : 'Paid to'} ${p.partyName}` });
    const onAccount = r2(settled - live.reduce((s, a) => s + a.amount, 0));
    if (p.kind === 'receipt') {
      v.dr(bank, p.amount);
      for (const a of adjustments) v.dr(ADJ_RECEIPT[a.kind] || L.roundOff, a.amount);
      if (p.partyType === 'other') v.cr(p.partyName, settled);
      else v.cr(p.partyName, settled, bills(onAccount));
    } else {
      v.cr(bank, p.amount);
      v.cr(L.tdsPayable, tds);
      for (const a of adjustments) v.cr(ADJ_PAYMENT[a.kind] || L.roundOff, a.amount);
      if (p.partyType === 'supplier') {
        v.dr(p.partyName, settled, bills(onAccount));
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

  out.sort((a, b) => new Date(a.date) - new Date(b.date) || a.number.localeCompare(b.number));
  return { vouchers: out, problems };
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

function toXml(vouchers, { company = '', masters = null } = {}) {
  const msgs = [];
  if (masters) {
    for (const [group, names] of [[masters.debtorsGroup, masters.debtors], [masters.creditorsGroup, masters.creditors]]) {
      for (const name of names) {
        msgs.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(group)}</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></TALLYMESSAGE>`);
      }
    }
  }
  for (const v of vouchers) {
    msgs.push([
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
      `<DATE>${tallyDate(v.date)}</DATE><EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>`,
      `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`,
      v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : '',
      v.party ? `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>` : '',
      `<NARRATION>${esc(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
      ...v.lines.map(ledgerLine),
      '</VOUCHER></TALLYMESSAGE>',
    ].join(''));
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>',
    `<REQUESTDESC><REPORTNAME>${masters ? 'All Masters' : 'Vouchers'}</REPORTNAME>${company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ''}</REQUESTDESC>`,
    '<REQUESTDATA>',
    ...msgs,
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
  ].join('\n');
}

/** What each kind of document came to, for the preview. */
function countOf(vouchers) {
  const c = {};
  for (const v of vouchers) c[v.type] = (c[v.type] || 0) + 1;
  return c;
}

const ledgersOf = (vouchers) => [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)))].sort();

module.exports = { build, toXml, countOf, ledgersOf, partiesOf, TYPES, tallyDate, esc };

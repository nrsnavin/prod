'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PARTY'S LEDGER ACCOUNT, THE WAY TALLY PRINTS IT
//
//    Date  Particulars          Vch Type     Vch No.   Debit    Credit
//          Opening Balance                             10,000.00
//    1-Apr To Sales             Sales        INV/1     11,800.00
//    5-Apr By Kotak Bank        Receipt      REC/1              11,800.00
//                               Current Total          11,800.00 11,800.00
//                               Closing Balance        10,000.00 Dr
//
//  Particulars is the other side of the entry — the ledger the voucher
//  posts against — with "To" on the debit side and "By" on the credit,
//  named exactly as the Tally export names it (Accounts → Settings →
//  Tally ledgers, a bank account's ledger, an expense head's ledger).
//
//  The detailed view adds, under each row, what Tally's "Detailed"
//  shows: the voucher's other ledgers (sales and each tax, the bank and
//  the TDS), and bill by bill which documents it settled ("Agst Ref")
//  or left on account. The figures themselves are partyLedger's: this
//  only describes rows the books already hold.
// ══════════════════════════════════════════════════════════════════

const partyLedger = require('./partyLedger');
const PartyLedgerEntry = require('../models/PartyLedgerEntry');
const { getSettings } = require('./booksLock');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const DEFAULT_LEDGERS = {
  sales: 'Sales', purchase: 'Purchase', outputCgst: 'Output CGST', outputSgst: 'Output SGST', outputIgst: 'Output IGST',
  inputCgst: 'Input CGST', inputSgst: 'Input SGST', inputIgst: 'Input IGST', roundOff: 'Round Off', tdsPayable: 'TDS Payable',
  tdsReceivable: 'TDS Receivable', bankCharges: 'Bank Charges', discountAllowed: 'Discount Allowed', discountReceived: 'Discount Received',
  badDebts: 'Bad Debts Written Off', writtenBack: 'Sundry Balances Written Back', sundryExpenses: 'Sundry Expenses',
};

/** Which side of the party's balance it sits: a customer owing is Dr, a supplier owed is Cr. */
const sideOf = (partyType, balance) => {
  if (Math.abs(balance) < 0.005) return '';
  return partyType === 'customer' ? (balance > 0 ? 'Dr' : 'Cr') : (balance > 0 ? 'Cr' : 'Dr');
};

function taxLines(t, L, input) {
  return [
    [input ? L.inputCgst : L.outputCgst, t.cgst],
    [input ? L.inputSgst : L.outputSgst, t.sgst],
    [input ? L.inputIgst : L.outputIgst, t.igst],
  ].filter(([, a]) => Math.abs(a || 0) > 0.004).map(([ledger, amount]) => ({ ledger, amount: r2(amount) }));
}
const withRound = (lines, t, L) => (Math.abs(t.roundOff || 0) > 0.004 ? [...lines, { ledger: L.roundOff, amount: r2(t.roundOff) }] : lines);

async function load(rows) {
  // A journal's ledger rows carry a per-line id; the journal itself is `source`.
  const ids = (type) => rows.filter((r) => r.docType === type).map((r) => (type === 'Journal' ? r.source : r.doc)).filter(Boolean);
  const pick = (Model, type, fields) => (ids(type).length ? Model.find({ _id: { $in: ids(type) } }).select(fields).lean() : []);
  const [invoices, bills, expenses, notes, payments, openings, journalsList] = await Promise.all([
    pick(require('../models/Invoice'), 'Invoice', 'invoiceNumber customerPo orderNo totals'),
    pick(require('../models/SupplierBill'), 'SupplierBill', 'billNo supplierBillNo kind category totals reverseCharge poNo'),
    pick(require('../models/Expense'), 'Expense', 'expenseNo refNo category categoryName description totals itc'),
    pick(require('../models/AccountNote'), 'AccountNote', 'kind noteNo partyType against reason totals partyNoteNo'),
    pick(require('../models/Payment'), 'Payment', 'kind voucherNo amount mode account accountName reference tds adjustments allocations unallocated narration'),
    pick(require('../models/OpeningBalance'), 'OpeningBalance', 'docNo refNo kind'),
    pick(require('../models/Journal'), 'Journal', 'journalNo purpose narration reason lines'),
  ]);
  const byId = new Map();
  for (const d of [...invoices, ...bills, ...expenses, ...notes, ...payments, ...openings, ...journalsList]) byId.set(String(d._id), d);
  const accountIds = payments.map((p) => p.account).filter(Boolean);
  const catIds = [...bills, ...expenses].map((d) => d.category).filter(Boolean);
  const [accounts, cats] = await Promise.all([
    accountIds.length ? require('../models/BankAccount').find({ _id: { $in: accountIds } }).select('name tallyLedger').lean() : [],
    catIds.length ? require('../models/ExpenseCategory').find({ _id: { $in: catIds } }).select('name ledger').lean() : [],
  ]);
  return {
    byId,
    bank: new Map(accounts.map((a) => [String(a._id), a.tallyLedger || a.name])),
    head: new Map(cats.map((c) => [String(c._id), c.ledger || c.name])),
  };
}

/** Particulars, voucher type, references and the detailed breakup of one row. */
function describe(row, partyType, ctx, L) {
  const d = ctx.byId.get(String(row.docType === 'Journal' ? row.source : row.doc)) || {};
  const t = d.totals || {};
  const headOf = (cat, fallback) => ctx.head.get(String(cat)) || fallback || L.sundryExpenses;
  const out = { vchType: '', particulars: '', refs: [], lines: [], partyRef: '' };
  switch (row.docType) {
    case 'Invoice':
      out.vchType = 'Sales';
      out.particulars = L.sales;
      out.partyRef = d.customerPo ? `PO ${d.customerPo}` : '';
      out.lines = withRound([{ ledger: L.sales, amount: r2(t.taxable) }, ...taxLines(t, L, false)], t, L);
      break;
    case 'SupplierBill': {
      out.vchType = 'Purchase';
      out.particulars = d.kind === 'service' ? headOf(d.category, L.purchase) : L.purchase;
      out.partyRef = d.supplierBillNo ? `Supplier inv. ${d.supplierBillNo}` : '';
      out.lines = withRound([{ ledger: out.particulars, amount: r2(t.taxable) }, ...(d.reverseCharge ? [] : taxLines(t, L, true))], t, L);
      break;
    }
    case 'Expense': {
      out.vchType = 'Purchase';
      out.particulars = headOf(d.category, d.categoryName);
      out.partyRef = d.refNo ? `Ref ${d.refNo}` : '';
      const itc = !!d.itc?.eligible;
      const tax = r2((t.cgst || 0) + (t.sgst || 0) + (t.igst || 0));
      out.lines = withRound([{ ledger: out.particulars, amount: r2((t.taxable || 0) + (itc ? 0 : tax)) }, ...(itc ? taxLines(t, L, true) : [])], t, L);
      break;
    }
    case 'AccountNote': {
      out.vchType = d.kind === 'debit' ? 'Debit Note' : 'Credit Note';
      out.particulars = (d.partyType || partyType) === 'customer' ? L.sales : L.purchase;
      out.partyRef = d.partyNoteNo ? `Their note ${d.partyNoteNo}` : '';
      if (d.against?.docNo) out.refs.push({ type: 'Agst Ref', name: d.against.docNo, amount: r2(t.grand) });
      out.lines = withRound([{ ledger: out.particulars, amount: r2(t.taxable) }, ...taxLines(t, L, (d.partyType || partyType) === 'supplier')], t, L);
      break;
    }
    case 'Payment': {
      out.vchType = d.kind === 'receipt' ? 'Receipt' : 'Payment';
      const bank = ctx.bank.get(String(d.account)) || d.accountName || (d.mode === 'cash' ? 'Cash' : 'Bank');
      out.particulars = bank;
      out.partyRef = [d.mode && d.mode !== 'bank' ? d.mode.toUpperCase() : '', d.reference].filter(Boolean).join(' ');
      const ADJ = d.kind === 'receipt'
        ? { bank_charges: L.bankCharges, discount: L.discountAllowed, tds_by_customer: L.tdsReceivable, round_off: L.roundOff, write_off: L.badDebts }
        : { discount: L.discountReceived, round_off: L.roundOff, write_off: L.writtenBack };
      out.lines = [{ ledger: bank, amount: r2(d.amount) }];
      if ((d.tds?.amount || 0) > 0) out.lines.push({ ledger: `${L.tdsPayable}${d.tds.section ? ` (${d.tds.section})` : ''}`, amount: r2(d.tds.amount) });
      for (const a of d.adjustments || []) out.lines.push({ ledger: ADJ[a.kind] || L.roundOff, amount: r2(a.amount) });
      for (const a of d.allocations || []) out.refs.push({ type: 'Agst Ref', name: a.docNo, amount: r2(a.amount) });
      if ((d.unallocated || 0) > 0.004) out.refs.push({ type: 'On Account', name: d.voucherNo, amount: r2(d.unallocated) });
      // Only one ledger on the other side: nothing to break down.
      if (out.lines.length === 1) out.lines = [];
      break;
    }
    case 'Journal': {
      out.vchType = 'Journal';
      const i = Number(row.line) || 0;
      const mine = (d.lines || [])[i];
      const others = (d.lines || []).filter((l, k) => k !== i);
      out.particulars = others.length === 1 ? others[0].ledger : 'As per details';
      out.partyRef = d.purpose && d.purpose !== 'other' ? d.purpose : '';
      out.lines = others.map((l) => ({ ledger: `${l.debit > 0 ? 'Dr' : 'Cr'} ${l.ledger}`, amount: r2(l.debit > 0 ? l.debit : l.credit) }));
      for (const r of mine?.refs || []) out.refs.push({ type: 'Agst Ref', name: r.docNo, amount: r2(r.amount) });
      break;
    }
    case 'OpeningBalance':
      out.vchType = 'Opening';
      out.particulars = 'Opening Balance';
      out.partyRef = d.refNo || '';
      if (d.refNo) out.refs.push({ type: d.kind === 'advance' ? 'Advance' : 'New Ref', name: d.refNo, amount: r2(row.debit || row.credit) });
      break;
    default:
      out.vchType = row.docType;
      out.particulars = row.narration || '';
  }
  // A one-line breakup says only what Particulars already says.
  if (out.lines.length === 1 && out.lines[0].ledger === out.particulars) out.lines = [];
  return out;
}

const ledgerNames = async () => ({ ...DEFAULT_LEDGERS, ...Object.fromEntries(Object.entries((await getSettings()).tally || {}).filter(([, v]) => typeof v === 'string' && v.trim())) });

/**
 * The ledger account: partyLedger.statement() with each row described,
 * the period's totals, and the balances' sides.
 */
// ── Cheques that bounced: shown, never counted ────────────────────
//  A bounced cheque's voucher is cancelled and its row leaves the
//  ledger, so the balance is as if it never came. The statement still
//  says what happened, on the day each thing happened: the cheque as it
//  was entered, and its return. Both are lines to read, with no Debit
//  or Credit: the balance runs on past them unchanged.
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function bouncedCheques(partyType, party, { from, to } = {}) {
  const Payment = require('../models/Payment');
  const list = await Payment.find({ partyType, [partyType]: party, mode: 'cheque', 'cheque.status': 'bounced' })
    .select('kind voucherNo amount date accountName cheque cancel').lean();
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const out = [];
  for (const p of list) {
    const c = p.cheque || {};
    const no = c.number ? `Cheque ${c.number}` : 'Cheque';
    const returnedOn = c.bouncedOn || p.cancel?.at || p.date;
    const base = { docType: 'Payment', doc: p._id, docNo: p.voucherNo, debit: 0, credit: 0, memoAmount: r2(p.amount) };
    if (inRange(new Date(p.date))) {
      out.push({ ...base, _id: `${p._id}:entered`, memo: 'cheque-entered', date: p.date, vchType: p.kind === 'receipt' ? 'Receipt' : 'Payment',
        particulars: `${no} (bounced)`, partyRef: [c.bank, `₹${inr(p.amount)}`, 'not counted'].filter(Boolean).join(' · ') });
    }
    if (inRange(new Date(returnedOn))) {
      out.push({ ...base, _id: `${p._id}:returned`, memo: 'cheque-returned', date: returnedOn, vchType: 'Bounced',
        particulars: `${no} returned`,
        partyRef: [`₹${inr(p.amount)}`, c.bounceReason, c.charges > 0 ? `bank charges ₹${inr(c.charges)}` : ''].filter(Boolean).join(' · ') });
    }
  }
  return out.sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** The memo lines placed by date among the posted rows, each carrying the balance as it stood. */
function withBouncedCheques(posted, memos, opening, partyType) {
  if (!memos.length) return posted;
  const out = [];
  let i = 0;
  let balance = opening;
  for (const r of posted) {
    while (i < memos.length && new Date(memos[i].date) < new Date(r.date)) out.push({ ...memos[i++], balance, balanceSide: sideOf(partyType, balance) });
    out.push(r);
    balance = r.balance;
  }
  while (i < memos.length) out.push({ ...memos[i++], balance, balanceSide: sideOf(partyType, balance) });
  return out;
}

async function ledgerAccount(partyType, party, { from, to } = {}) {
  const s = await partyLedger.statement(partyType, party, { from, to });
  const [ctx, L] = await Promise.all([load(s.rows), ledgerNames()]);
  const posted = s.rows.map((r) => {
    const x = describe(r, partyType, ctx, L);
    const debitSide = r.debit > 0;
    return { ...r, ...x, toBy: debitSide ? 'To' : 'By', balanceSide: sideOf(partyType, r.balance) };
  });
  const rows = withBouncedCheques(posted, await bouncedCheques(partyType, party, { from, to }), s.opening, partyType);
  const totals = { debit: r2(rows.reduce((t, r) => t + (r.debit || 0), 0)), credit: r2(rows.reduce((t, r) => t + (r.credit || 0), 0)) };
  return {
    opening: s.opening, openingSide: sideOf(partyType, s.opening),
    rows, totals,
    closing: s.closing, closingSide: sideOf(partyType, s.closing),
  };
}

/**
 * Tally's group summary for Sundry Debtors / Sundry Creditors: every
 * party with its opening, the period's debits and credits, and closing.
 */
async function groupSummary(partyType, { from, to } = {}) {
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const rows = await PartyLedgerEntry.aggregate([
    { $match: { partyType, ...(to ? { date: { $lte: to } } : {}) } },
    { $group: {
      _id: '$party',
      openDr: { $sum: from ? { $cond: [{ $lt: ['$date', from] }, '$debit', 0] } : 0 },
      openCr: { $sum: from ? { $cond: [{ $lt: ['$date', from] }, '$credit', 0] } : 0 },
      debit: { $sum: from ? { $cond: [{ $gte: ['$date', from] }, '$debit', 0] } : '$debit' },
      credit: { $sum: from ? { $cond: [{ $gte: ['$date', from] }, '$credit', 0] } : '$credit' },
    } },
  ]);
  const Model = partyType === 'customer' ? require('../models/Customer') : require('../models/Supplier');
  const names = new Map((await Model.find({ _id: { $in: rows.map((r) => r._id) } }).select('name gstin').lean()).map((p) => [String(p._id), p]));
  const out = rows.map((r) => {
    const opening = partyLedger.balanceOf(partyType, { debit: r.openDr, credit: r.openCr });
    const closing = partyLedger.balanceOf(partyType, { debit: r.openDr + r.debit, credit: r.openCr + r.credit });
    const p = names.get(String(r._id)) || {};
    return {
      party: r._id, partyName: p.name || '(removed)', gstin: p.gstin || '',
      opening, openingSide: sideOf(partyType, opening), debit: r2(r.debit), credit: r2(r.credit), closing, closingSide: sideOf(partyType, closing),
    };
  }).filter((r) => Math.abs(r.opening) > 0.004 || r.debit > 0.004 || r.credit > 0.004 || Math.abs(r.closing) > 0.004)
    .sort((a, b) => a.partyName.localeCompare(b.partyName));
  const sum = (k) => r2(out.reduce((t, r) => t + r[k], 0));
  const totals = { opening: sum('opening'), debit: sum('debit'), credit: sum('credit'), closing: sum('closing') };
  return { partyType, group: partyType === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors', rows: out, totals: { ...totals, openingSide: sideOf(partyType, totals.opening), closingSide: sideOf(partyType, totals.closing) } };
}

module.exports = { ledgerAccount, groupSummary, describe, sideOf, DEFAULT_LEDGERS };

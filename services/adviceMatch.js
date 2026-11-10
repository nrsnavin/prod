'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PAYMENT ADVICE, PLACED ON THE BOOKS
//
//  From what a customer's advice says (utils/adviceOcr.js) to a receipt
//  ready to check: the customer on file (GSTIN, then name), each invoice
//  it names found among their open invoices, settled GROSS by the money
//  paid against it plus what was taken off it (TDS, discount, other),
//  never past what is outstanding; the TDS and discount as the receipt's
//  adjustments; whether it all adds up; and the bank statement line the
//  money came in on, when one is waiting.
//
//  An invoice number matches exactly, or — written short, "701" or
//  "INV-701" — by its last number when that is one open invoice of this
//  customer and no other. Anything unsure is listed, not guessed.
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const BankStatement = require('../models/BankStatement');
const outstanding = require('./outstanding');

const { r2 } = require('../utils/money');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const lastNumber = (s) => { const m = String(s || '').match(/(\d+)\D*$/); return m ? Number(m[1]) : null; };

async function findCustomer(read, customerId) {
  if (customerId) {
    const c = await Customer.findById(customerId).select('name gstin').lean();
    if (c) return { ...c, matchedBy: 'chosen' };
  }
  if (read.payerGstin) {
    const c = await Customer.findOne({ gstin: read.payerGstin }).select('name gstin').lean();
    if (c) return { ...c, matchedBy: 'gstin' };
  }
  const words = String(read.payerName || '').split(/\s+/).filter((w) => w.length >= 3 && !/^(pvt|ltd|private|limited|the|and)$/i.test(w)).slice(0, 3);
  if (words.length) {
    const re = new RegExp(words.map((w) => `(?=.*${escapeRegex(w)})`).join(''), 'i');
    const c = await Customer.findOne({ name: re }).select('name gstin').lean();
    if (c) return { ...c, matchedBy: 'name' };
  }
  return null;
}

/** The open invoice an advice's number names, or why none. */
function invoiceFor(no, open, taken) {
  const exact = open.filter((d) => squash(d.docNo) === squash(no) && !taken.has(String(d.id)));
  if (exact.length === 1) return { doc: exact[0] };
  const n = lastNumber(no);
  if (n == null) return { why: 'no invoice number' };
  const byNumber = open.filter((d) => d.docType === 'Invoice' && lastNumber(d.docNo) === n && !taken.has(String(d.id)));
  if (byNumber.length === 1) return { doc: byNumber[0], short: true };
  if (byNumber.length > 1) return { why: `more than one open invoice ends in ${n}` };
  return { why: 'not an open invoice of this customer' };
}

async function statementLineFor(read) {
  if (!(read.amount > 0)) return null;
  const since = new Date(Date.now() - 45 * 86_400_000);
  const statements = await BankStatement.find({ createdAt: { $gte: since }, lines: { $elemMatch: { direction: 'in', amount: read.amount } } })
    .select('account accountName lines').sort({ createdAt: -1 }).limit(10).lean();
  const placed = new Set();
  for (const s of statements) for (const l of s.lines) if (['recorded', 'posted', 'ignored'].includes(l.status)) placed.add(l.key);
  const ref = squash(read.reference).replace(/^(UTR|REF|NEFT|RTGS|IMPS|CHQ|CHEQUE)/, '');
  let best = null;
  for (const s of statements) {
    for (const l of s.lines) {
      if (l.direction !== 'in' || Math.abs(l.amount - read.amount) > 0.005 || placed.has(l.key)) continue;
      const byRef = ref.length >= 6 && squash(`${l.narration} ${l.ref}`).includes(ref);
      const score = byRef ? 2 : 1;
      if (!best || score > best.score) best = { score, statement: s._id, account: s.account, accountName: s.accountName, key: l.key, date: l.date, narration: l.narration, byReference: byRef };
    }
  }
  if (!best) return null;
  const { score, ...out } = best;
  return out;
}

/**
 * @param read  what utils/adviceOcr.js read
 * @param opts  { customer?: id } — the customer, when the person chose one
 */
async function placeAdvice(read, { customer: customerId = null } = {}) {
  const customer = await findCustomer(read, customerId);
  const out = {
    customer: customer ? { _id: customer._id, name: customer.name, gstin: customer.gstin || '', matchedBy: customer.matchedBy } : null,
    amount: read.amount, date: read.date, reference: read.reference,
    allocations: [], adjustments: [], unmatched: [], notes: [], difference: null,
    statementLine: await statementLineFor(read),
  };
  if (!customer) {
    out.notes.push(`${read.payerName || 'The payer'} is not a customer on file — choose the customer`);
    return out;
  }
  const open = (await outstanding.receivables({ customer: customer._id })).filter((d) => d.docType === 'Invoice' || d.docType === 'OpeningBalance');
  const taken = new Set();
  let tds = 0; let discount = 0; let other = 0;
  for (const line of read.lines) {
    const found = invoiceFor(line.invoiceNo, open, taken);
    if (!found.doc) { out.unmatched.push({ invoiceNo: line.invoiceNo, why: found.why, paid: line.paid }); continue; }
    const d = found.doc;
    taken.add(String(d.id));
    // TDS and a discount settle the invoice with the money; another
    // deduction (a debit note, short supply) leaves it short until a
    // credit note says why.
    const off = r2((line.tds || 0) + (line.discount || 0));
    const settles = line.paid != null ? r2(line.paid + off) : line.invoiceAmount != null ? r2(line.invoiceAmount - (line.other || 0)) : d.outstanding;
    const gross = r2(Math.min(settles, d.outstanding));
    if (settles > d.outstanding + 0.5) out.notes.push(`${d.docNo}: the advice settles ₹${settles.toFixed(2)}, but only ₹${d.outstanding.toFixed(2)} is outstanding`);
    if (found.short) out.notes.push(`"${line.invoiceNo}" taken as ${d.docNo}`);
    out.allocations.push({ docType: d.docType, doc: d.id, docNo: d.docNo, amount: gross, outstanding: d.outstanding, paid: line.paid, tds: line.tds || 0, discount: line.discount || 0, other: line.other || 0 });
    tds += line.tds || 0; discount += line.discount || 0; other += line.other || 0;
  }
  // The totals as printed, where the lines did not say it per invoice.
  if (!tds && read.tdsTotal) tds = read.tdsTotal;
  if (!discount && read.discountTotal) discount = read.discountTotal;
  if (r2(tds) > 0) out.adjustments.push({ kind: 'tds_by_customer', amount: r2(tds) });
  if (r2(discount) > 0) out.adjustments.push({ kind: 'discount', amount: r2(discount) });
  if (r2(other) > 0) out.notes.push(`₹${r2(other).toFixed(2)} of other deductions (debit notes, short supply) — settle those with a credit note, or leave the invoice short`);

  const settled = r2(out.allocations.reduce((s, a) => s + a.amount, 0));
  if (read.amount != null) {
    out.difference = r2((read.amount + out.adjustments.reduce((s, a) => s + a.amount, 0)) - settled);
    if (out.difference > 0.5 && !out.unmatched.length) out.notes.push(`₹${out.difference.toFixed(2)} more than the invoices named — it stays on account`);
    if (out.difference < -0.5) out.notes.push(`The invoices need ₹${(-out.difference).toFixed(2)} more than was paid and taken off — check the figures`);
  }
  return out;
}

module.exports = { placeAdvice, invoiceFor, lastNumber };

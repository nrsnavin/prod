'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST FOR A PERIOD, AS ENTERED HERE
//
//  Output tax from sales less credit notes, plus debit notes raised on
//  customers, plus reverse charge on what unregistered suppliers did not
//  charge; input credit from purchases less debit notes raised on
//  suppliers, plus expenses with credit. By rate, and the net.
//  The GST report and the cash forecast read the same figures.
//
//  A DEBIT NOTE IS ONE OF TWO THINGS. Raised on a supplier (goods sent
//  back, a price cut) it lowers our input credit. Raised on a customer
//  (interest on a late payment, a price increase) it is more output tax.
//  Every debit note used to be taken as the first kind: the customer's
//  came off input credit and never reached output tax. The net payable
//  was the same either way, which hid it; but the output tax of the
//  month was less than GSTR-1 says (table 9B has those notes) and the
//  credit less than the purchase register's.
//
//  A financial credit note (issued past the time limit, no GST) is not
//  a GST document: GSTR-1 leaves it out, and so does this.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const AccountNote = require('../models/AccountNote');

const { r2 } = require('../utils/money');

function byRate(docs, lineKey = 'lines') {
  const out = new Map();
  for (const d of docs) for (const l of d[lineKey] || []) {
    const k = Number(l.gstPercent) || 0;
    const g = out.get(k) || { rate: k, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    g.taxable = r2(g.taxable + l.taxable); g.cgst = r2(g.cgst + l.cgst); g.sgst = r2(g.sgst + l.sgst); g.igst = r2(g.igst + l.igst);
    g.tax = r2(g.cgst + g.sgst + g.igst);
    out.set(k, g);
  }
  return [...out.values()].sort((a, b) => a.rate - b.rate);
}

const sum = (rows) => rows.reduce((t, g) => ({ taxable: r2(t.taxable + g.taxable), cgst: r2(t.cgst + g.cgst), sgst: r2(t.sgst + g.sgst), igst: r2(t.igst + g.igst), tax: r2(t.tax + g.tax) }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 });

async function summary({ from, to }) {
  const range = { $gte: from, $lte: to };
  const [invoices, creditNotes, customerDebitNotes, bills, debitNotes, expenses, rcmBills] = await Promise.all([
    Invoice.find({ status: 'issued', invoiceDate: range }).select('lines').lean(),
    AccountNote.find({ kind: 'credit', status: 'issued', financial: { $ne: true }, date: range }).select('lines').lean(),
    // Raised on a customer: more output tax.
    AccountNote.find({ kind: 'debit', partyType: 'customer', status: 'issued', date: range }).select('lines').lean(),
    SupplierBill.find({ status: { $ne: 'cancelled' }, 'itc.eligible': true, billDate: range }).select('lines').lean(),
    // Raised on a supplier: less input credit.
    AccountNote.find({ kind: 'debit', partyType: 'supplier', status: 'issued', date: range }).select('lines').lean(),
    Expense.find({ status: { $in: ['approved', 'paid'] }, 'itc.eligible': true, date: range }).select('lines').lean(),
    // Reverse charge: tax we owe on what the supplier did not charge.
    SupplierBill.find({ status: { $ne: 'cancelled' }, reverseCharge: true, billDate: range }).select('lines').lean(),
  ]);
  const output = { sales: byRate(invoices), creditNotes: byRate(creditNotes), debitNotes: byRate(customerDebitNotes), reverseCharge: byRate(rcmBills) };
  const input = { purchases: byRate(bills), debitNotes: byRate(debitNotes), expenses: byRate(expenses) };
  const outputTotal = sum(output.sales); const cnTotal = sum(output.creditNotes); const cdnTotal = sum(output.debitNotes); const rcmTotal = sum(output.reverseCharge);
  const inputTotal = sum(input.purchases); const dnTotal = sum(input.debitNotes); const expTotal = sum(input.expenses);
  const netOutput = {
    cgst: r2(outputTotal.cgst - cnTotal.cgst + cdnTotal.cgst + rcmTotal.cgst),
    sgst: r2(outputTotal.sgst - cnTotal.sgst + cdnTotal.sgst + rcmTotal.sgst),
    igst: r2(outputTotal.igst - cnTotal.igst + cdnTotal.igst + rcmTotal.igst),
  };
  // Rule 37: credit reversed on bills unpaid 180 days, and re-claimed once paid.
  const rule37 = await require('./itcReversal').inPeriod(from, to);
  const netInput = {
    cgst: r2(inputTotal.cgst - dnTotal.cgst + expTotal.cgst - rule37.reversed.cgst + rule37.reclaimed.cgst),
    sgst: r2(inputTotal.sgst - dnTotal.sgst + expTotal.sgst - rule37.reversed.sgst + rule37.reclaimed.sgst),
    igst: r2(inputTotal.igst - dnTotal.igst + expTotal.igst - rule37.reversed.igst + rule37.reclaimed.igst),
  };
  return {
    from, to, output, input,
    totals: {
      output: outputTotal, creditNotes: cnTotal, customerDebitNotes: cdnTotal, reverseCharge: rcmTotal, purchases: inputTotal, debitNotes: dnTotal, expenses: expTotal, rule37, netOutput, netInput,
      payable: { cgst: r2(netOutput.cgst - netInput.cgst), sgst: r2(netOutput.sgst - netInput.sgst), igst: r2(netOutput.igst - netInput.igst) },
    },
    counts: { invoices: invoices.length, creditNotes: creditNotes.length, customerDebitNotes: customerDebitNotes.length, bills: bills.length, debitNotes: debitNotes.length, expenses: expenses.length, reverseCharge: rcmBills.length },
  };
}

/**
 * Cash the month's return will take: the net per head, a head in credit
 * counted as nothing (before any credit carried from earlier months, or
 * set across heads, which the return works out).
 */
function cashDue(s) {
  const p = s.totals.payable;
  return r2(Math.max(0, p.cgst) + Math.max(0, p.sgst) + Math.max(0, p.igst));
}

module.exports = { summary, cashDue };

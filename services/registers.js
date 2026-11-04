'use strict';
// ══════════════════════════════════════════════════════════════════
//  SALES AND PURCHASE REGISTERS
//
//  The two books an auditor asks for first: every outward supply in a
//  period (invoices, and the credit and debit notes to customers), and
//  every inward one (supplier bills, and expenses carrying GST), one
//  row each, taxable value by rate, the tax split, the total, and what
//  the row's document says about itself — IRN, e-way bill, 2B match,
//  credit claimed, reverse charge, TDS, how much is still open.
//  Cancelled documents are listed and marked, as a register must.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const AccountNote = require('../models/AccountNote');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const { stateName } = require('./gst');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Taxable value per rate on a document, as "5": 1000. */
function byRate(lines) {
  const out = {};
  for (const l of lines || []) {
    const k = String(Number(l.gstPercent) || 0);
    out[k] = r2((out[k] || 0) + (l.taxable || 0));
  }
  return out;
}

function totalsOf(rows) {
  const t = { count: rows.length, cancelled: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, grand: 0, byRate: {} };
  for (const r of rows) {
    if (r.cancelled) { t.cancelled += 1; continue; }
    const sign = r.sign || 1;
    t.taxable = r2(t.taxable + sign * r.taxable); t.cgst = r2(t.cgst + sign * r.cgst); t.sgst = r2(t.sgst + sign * r.sgst); t.igst = r2(t.igst + sign * r.igst);
    t.tax = r2(t.tax + sign * r.tax); t.grand = r2(t.grand + sign * r.grand);
    for (const [k, v] of Object.entries(r.byRate || {})) t.byRate[k] = r2((t.byRate[k] || 0) + sign * v);
  }
  return t;
}

async function sales({ from, to }) {
  const range = { $gte: from, $lte: to };
  const [invoices, notes] = await Promise.all([
    Invoice.find({ invoiceDate: range }).select('invoiceNumber invoiceDate orderNo customer buyer supplyType placeOfSupply lines totals status einvoice.irn ewaybill.number paidAmount creditedAmount debitedAmount export').sort({ invoiceDate: 1, sequence: 1 }).lean(),
    AccountNote.find({ partyType: 'customer', date: range }).select('kind noteNo date customer partyName partyGstin against supplyType lines totals status financial einvoice.irn interest').sort({ date: 1 }).lean(),
  ]);
  const rows = [];
  for (const i of invoices) {
    const t = i.totals || {};
    rows.push({
      docType: 'Invoice', id: i._id, kind: 'Invoice', docNo: i.invoiceNumber, date: i.invoiceDate, party: i.customer, partyName: i.buyer?.name || '', gstin: i.buyer?.gstin || '',
      state: i.supplyType === 'export' ? 'Other country' : stateName(i.placeOfSupply || i.buyer?.stateCode) || '', supplyType: i.supplyType, exportKind: i.export?.kind || '', orderNo: i.orderNo ?? null,
      taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst), igst: r2(t.igst), tax: r2(t.tax), roundOff: r2(t.roundOff), grand: r2(t.grand), byRate: byRate(i.lines),
      irn: i.einvoice?.irn || '', ewaybill: i.ewaybill?.number || '', cancelled: i.status === 'cancelled', sign: 1,
      outstanding: i.status === 'cancelled' ? 0 : r2(t.grand + (i.debitedAmount || 0) - (i.paidAmount || 0) - (i.creditedAmount || 0)),
    });
  }
  for (const n of notes) {
    const t = n.totals || {};
    rows.push({
      docType: 'AccountNote', id: n._id, kind: n.kind === 'credit' ? 'Credit note' : 'Debit note', docNo: n.noteNo, date: n.date, party: n.customer, partyName: n.partyName, gstin: n.partyGstin || '',
      state: stateName(n.partyGstin?.slice(0, 2)) || '', supplyType: n.supplyType, exportKind: '', against: n.against?.docNo || '', financial: !!n.financial, interest: !!(n.interest || []).length,
      taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst), igst: r2(t.igst), tax: r2(t.tax), roundOff: r2(t.roundOff), grand: r2(t.grand), byRate: byRate(n.lines),
      irn: n.einvoice?.irn || '', ewaybill: '', cancelled: n.status === 'cancelled', sign: n.kind === 'credit' ? -1 : 1, outstanding: 0,
    });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || a.docNo.localeCompare(b.docNo));
  return { from, to, rows, totals: totalsOf(rows), counts: { invoices: invoices.length, creditNotes: notes.filter((n) => n.kind === 'credit').length, debitNotes: notes.filter((n) => n.kind === 'debit').length } };
}

async function purchase({ from, to }) {
  const range = { $gte: from, $lte: to };
  const [bills, expenses, notes] = await Promise.all([
    SupplierBill.find({ billDate: range }).select('billNo supplierBillNo billDate supplier supplierName supplierGstin supplierStateCode kind category supplyType lines totals itc reverseCharge rcm tds status gstr2b.status itcReversal paidAmount tdsAmount debitedAmount poNo costCentre').sort({ billDate: 1, sequence: 1 }).lean(),
    Expense.find({ date: range, status: { $in: ['approved', 'paid', 'cancelled'] } }).select('expenseNo date supplier payeeName payeeGstin categoryName description refNo supplyType lines totals itc status paidAmount costCentre').sort({ date: 1 }).lean(),
    AccountNote.find({ partyType: 'supplier', date: range }).select('kind noteNo date supplier partyName partyGstin against supplyType lines totals status partyNoteNo').sort({ date: 1 }).lean(),
  ]);
  const rows = [];
  for (const b of bills) {
    const t = b.totals || {};
    rows.push({
      docType: 'SupplierBill', id: b._id, kind: b.kind === 'service' ? 'Service bill' : 'Purchase bill', docNo: b.billNo, refNo: b.supplierBillNo, date: b.billDate, party: b.supplier, partyName: b.supplierName, gstin: b.supplierGstin || '',
      state: stateName(b.supplierStateCode || b.supplierGstin?.slice(0, 2)) || '', supplyType: b.supplyType, poNo: b.poNo ?? null, costCentre: b.costCentre?.name || '',
      taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst), igst: r2(t.igst), tax: r2(t.tax), roundOff: r2(t.roundOff), grand: r2(t.grand), byRate: byRate(b.lines),
      itc: b.itc?.eligible !== false, itcAmount: r2(b.itc?.amount), reverseCharge: !!b.reverseCharge, rcmTax: r2(b.rcm?.tax), tds: b.tds?.applicable ? `${b.tds.section} @ ${b.tds.rate}%` : '',
      gstr2b: b.gstr2b?.status || '', itcReversed: r2(b.itcReversal?.amount), cancelled: b.status === 'cancelled', sign: 1,
      outstanding: b.status === 'cancelled' ? 0 : r2(t.grand - (b.paidAmount || 0) - (b.tdsAmount || 0) - (b.debitedAmount || 0)),
    });
  }
  for (const e of expenses) {
    const t = e.totals || {};
    rows.push({
      docType: 'Expense', id: e._id, kind: 'Expense', docNo: e.expenseNo, refNo: e.refNo || '', date: e.date, party: e.supplier, partyName: e.payeeName, gstin: e.payeeGstin || '',
      state: stateName(e.payeeGstin?.slice(0, 2)) || '', supplyType: e.supplyType, head: e.categoryName, description: e.description, costCentre: e.costCentre?.name || '',
      taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst), igst: r2(t.igst), tax: r2(t.tax), roundOff: r2(t.roundOff), grand: r2(t.grand), byRate: byRate(e.lines),
      itc: !!e.itc?.eligible, itcAmount: r2(e.itc?.amount), reverseCharge: false, rcmTax: 0, tds: '', gstr2b: '', itcReversed: 0, cancelled: e.status === 'cancelled', sign: 1,
      outstanding: e.status === 'cancelled' ? 0 : r2(t.grand - (e.paidAmount || 0)),
    });
  }
  for (const n of notes) {
    const t = n.totals || {};
    rows.push({
      docType: 'AccountNote', id: n._id, kind: n.kind === 'debit' ? 'Debit note' : 'Credit note', docNo: n.noteNo, refNo: n.partyNoteNo || '', date: n.date, party: n.supplier, partyName: n.partyName, gstin: n.partyGstin || '',
      state: stateName(n.partyGstin?.slice(0, 2)) || '', supplyType: n.supplyType, against: n.against?.docNo || '',
      taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst), igst: r2(t.igst), tax: r2(t.tax), roundOff: r2(t.roundOff), grand: r2(t.grand), byRate: byRate(n.lines),
      itc: true, itcAmount: 0, reverseCharge: false, rcmTax: 0, tds: '', gstr2b: '', itcReversed: 0, cancelled: n.status === 'cancelled', sign: n.kind === 'debit' ? -1 : 1, outstanding: 0,
    });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || a.docNo.localeCompare(b.docNo));
  const live = rows.filter((r) => !r.cancelled);
  const itc = r2(live.reduce((s, r) => s + (r.sign || 1) * (r.docType === 'AccountNote' ? r.tax : r.itc ? r.tax : 0), 0));
  return { from, to, rows, totals: { ...totalsOf(rows), itc, reverseCharge: r2(live.reduce((s, r) => s + (r.rcmTax || 0), 0)) }, counts: { bills: bills.length, expenses: expenses.length, notes: notes.length } };
}

module.exports = { sales, purchase, byRate, totalsOf };

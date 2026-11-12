'use strict';
// Run by tests/api/accountsOtherZone.test.js as a child process, with TZ
// set to the zone under test. It puts a few documents on the first and
// the last day of a month (and the first day of a financial year) into
// an empty database, asks the accounts reports about them, and prints
// what they said as JSON. The answers must not depend on TZ.

process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const day = (s) => new Date(`${s}T00:00:00Z`);     // how every document date is kept
const iso = (d) => new Date(d).toISOString();

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const Payment = require('../../models/Payment');
  const SupplierBill = require('../../models/SupplierBill');
  const Invoice = require('../../models/Invoice');
  const supplier = new mongoose.Types.ObjectId();
  const customer = new mongoose.Types.ObjectId();
  const account = new mongoose.Types.ObjectId();

  // TDS deducted on the first and last day of October, and on 1 November.
  let seq = 0;
  const voucher = (date, tds) => ({ kind: 'payment', voucherNo: `PAY/2026-27/${String(++seq).padStart(4, '0')}`, financialYear: '2026-27', sequence: seq, date: day(date), partyType: 'supplier', supplier, partyName: 'Raja Dyers', amount: 50000 - tds, mode: 'bank', account, accountName: 'Kotak', status: 'posted', tds: { section: '194C', rate: 2, amount: tds, base: tds * 50 }, allocations: [], unallocated: 0 });
  await Payment.collection.insertMany([voucher('2026-10-01', 100), voucher('2026-10-31', 200), voucher('2026-11-01', 400)]);
  // Bills on the first and last day of October, one on 1 November.
  const bill = (no, date) => ({ billNo: no, supplierBillNo: no, supplier, supplierName: 'Raja Dyers', supplierGstin: '33AAAPR1234F1Z5', billDate: day(date), status: 'open', supplyType: 'intra', kind: 'service', lines: [], totals: { taxable: 1000, cgst: 25, sgst: 25, igst: 0, tax: 50, grand: 1050 }, itc: { eligible: true, amount: 50 }, tds: { applicable: true, section: '194C', rate: 2 }, paidAmount: 0, tdsAmount: 0, debitedAmount: 0 });
  await SupplierBill.collection.insertMany([bill('PB/1', '2026-10-01'), bill('PB/2', '2026-10-31'), bill('PB/3', '2026-11-01'), { ...bill('PB/0', '2026-04-01'), tds: { applicable: false } }]);
  // Invoices on the same days.
  const invoice = (no, date) => ({ invoiceNumber: no, financialYear: '2026-27', sequence: Number(no.slice(-1)), invoiceDate: day(date), dueDate: day(date), customer, status: 'issued', supplyType: 'intra', placeOfSupply: '33', buyer: { name: 'Sunrise', gstin: '33AAEPS1234F1Z2', stateCode: '33' }, seller: { name: 'Balu', gstin: '33AAECB1234F1Z5', stateCode: '33' }, lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 100, rate: 10, taxable: 1000, gstPercent: 5, cgst: 25, sgst: 25, igst: 0, amount: 1050 }], totals: { taxable: 1000, cgst: 25, sgst: 25, igst: 0, tax: 50, roundOff: 0, grand: 1050 } });
  await Invoice.collection.insertMany([invoice('INV/2026-27/0001', '2026-10-01'), invoice('INV/2026-27/0002', '2026-10-31'), invoice('INV/2026-27/0003', '2026-11-01')]);

  const cal = require('../../utils/bizDates');
  const tds = require('../../services/tds');
  const gstSummary = require('../../services/gstSummary');
  const gstr1 = require('../../services/gstr1');
  const itcReversal = require('../../services/itcReversal');
  const { allocate } = require('../../services/docNumbers');
  const creditNoteLimit = require('../../services/creditNoteLimit');
  const recurring = require('../../services/recurring');
  const insights = require('../../services/accountsInsights');

  const october = cal.monthRange('2026-10');
  const reg = await tds.register('2026-10');
  const q3 = await tds.form26q('2026-27', 'Q3');
  const gst = await gstSummary.summary({ from: october.from, to: october.to });
  const g1 = await gstr1.build('2026-10');
  const close = await insights.closeChecklist('2026-10');
  const out = {
    october: [iso(october.from), iso(october.to)],
    // 100 on the 1st + 200 on the 31st; the 400 of 1 November is not October's.
    tdsOctober: reg.totals.deducted,
    tdsDue: iso(reg.due),
    // Bills booked in October with a TDS section, unpaid at its end: PB/1 and PB/2, not November's PB/3.
    notDeducted: reg.notDeducted.rows.map((r) => r.billNo),
    tdsQuarter: q3.totals.tds,
    quarter: [iso(q3.from), iso(q3.to)],
    gstOutputTaxable: gst.totals.output.taxable,
    gstr1Invoices: (g1.b2b || []).reduce((t, p) => t + (p.inv || p.invoices || []).length, 0) || g1.summary?.invoices || g1.counts?.invoices,
    gstr1Period: g1.fp || g1.period || g1.month,
    closeMonth: [close.month, iso(close.from), iso(close.to)],
    closeTds: close.items.find((i) => i.key === 'tds').amount,
    rule37Months: await itcReversal.inPeriod(day('2026-09-30'), day('2026-11-01')).then(() => cal.monthsBetween(day('2026-09-30'), day('2026-11-01'))),
    // A document dated 1 April is the new year's; one dated 31 March the old one's.
    fyFirstDay: cal.fyOf(day('2026-04-01')),
    fyLastDay: cal.fyOf(day('2026-03-31')),
    numberFirstDay: (await allocate(Payment, 'PAY', { extra: { kind: 'payment' }, at: day('2027-04-01') })).financialYear,
    numberLastDay: (await allocate(Payment, 'RCT', { extra: { kind: 'receipt' }, at: day('2027-03-31') })).financialYear,
    quarterOfFirst: [cal.quarterOf(day('2026-04-01')), cal.quarterOf(day('2026-07-01')), cal.quarterOf(day('2026-12-31')), cal.quarterOf(day('2027-01-01'))],
    creditNoteLimit: iso(creditNoteLimit.limitFor(day('2026-04-01'))),
    itcDeadline: iso(insights.itcDeadline(day('2027-03-31'))),
    recurringNext: iso(recurring.advance(day('2026-10-31'), 1, 0)),
    dmy: [cal.dmy(day('2026-11-01')), cal.dmy(new Date('2026-10-31T20:00:00Z'))],
  };
  process.stdout.write(`\nPROBE${JSON.stringify(out)}\n`);
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });

'use strict';
// ══════════════════════════════════════════════════════════════════
//  STATUTORY, PART TWO
//
//    TDS         the month's register with the 7th as the due day, a
//                challan deposited, interest on what is late; the
//                quarter's 26Q rows with PAN checks; what customers
//                deducted against certificates and Form 26AS; 194Q
//                switching on once a supplier's purchases pass the limit
//    Payroll     the month's slips become a salary journal and a paid
//                journal; PF and ESI deposits with the 15th as due
//    Service bill a machine's service bill enters the books as a
//                supplier bill with its photo, and links both ways
//    E-way bill  generated from the IRN through the provider, or
//                pasted; a challan takes a pasted number
//    Credit note past 30 November of the next year only a financial
//                credit note, with no GST and nothing in GSTR-1
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Payment', 'BankAccount', 'Journal', 'Employee', 'Payroll', 'Machine', 'MachineServiceBill', 'DeliveryChallan', 'AccountNote', 'TdsChallan']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'stat2@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], invoice: { defaultGstPercent: 5, defaultHsn: '5806', stateCode: '33', city: 'Tiruppur', pincode: '641601' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const supplier = async (over = {}) => { n += 1; return M.Supplier.create({ name: `Supplier ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', ...over }); };
const bill = (s, body) => post('/accounts/bills', { supplier: s._id, supplierBillNo: `S/${++n}`, kind: 'service', lines: [{ description: 'Dyeing', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 }, ...body }).then((r) => { if (r.status !== 201) throw new Error(r.body.message); return r.body.bill; });
const bank = async () => { await get('/accounts/bank-accounts'); return (await post('/accounts/bank-accounts', { name: `Bank ${++n}`, kind: 'bank' })).body.account; };
const pay = (s, b, date, amount = 51500) => post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount, mode: 'bank', account: b.account, tds: { section: '194C', rate: 2 }, allocations: [{ docType: 'SupplierBill', doc: b.bill._id, amount: 52500 }], date });
async function customerWithInvoice(over = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Customer ${n}`, contactName: 'R', phoneNumber: `9300000${String(n).padStart(3, '0')}`, gstin: `33AAEPC${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30', address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-10-05'), dueDate: new Date('2026-11-04'),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 10000, rate: 10, taxable: 100000, gstPercent: 5, cgst: 2500, sgst: 2500, igst: 0, amount: 105000 }],
    totals: { taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, tax: 5000, roundOff: 0, grand: 105000 }, status: 'issued', ...over,
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 105000, narration: 'Sales' });
  return { customer, inv };
}

describe('TDS after the deduction', () => {
  it('keeps the register by section with the due day, takes a challan, and runs interest on what is late', async () => {
    const s = await supplier({ pan: 'AAAPS1234F' });
    const acct = await bank();
    const b = await bill(s, { billDate: '2026-09-02' });
    expect((await pay(s, { account: acct._id, bill: b }, '2026-09-20')).status).toBe(201);
    let reg = (await get('/accounts/tds/register?month=2026-09')).body;
    expect(reg.rows).toEqual([expect.objectContaining({ section: '194C', deducted: 1000, deposited: 0, balance: 1000, late: true })]);
    expect(new Date(reg.due).toISOString().slice(0, 10)).toBe('2026-10-07');
    expect(reg.rows[0].interestDue).toBeGreaterThan(0);
    const ch = await post('/accounts/tds/challans', { month: '2026-09', section: '194C', amount: 1000, interest: 30, bsrCode: '0510308', challanNo: '00412', depositedOn: '2026-11-03' });
    expect(ch.status).toBe(201);
    reg = ch.body.register;
    expect(reg.rows[0]).toMatchObject({ deposited: 1000, balance: 0, interestPaid: 30, late: false });
    expect(reg.totals).toMatchObject({ deducted: 1000, deposited: 1000, balance: 0 });
    // March is due 30 April.
    expect(new Date((await get('/accounts/tds/register?month=2027-03')).body.due).toISOString().slice(0, 10)).toBe('2027-04-30');
  });

  it('builds the quarter\'s 26Q with PAN checks and the challan on each line', async () => {
    const withPan = await supplier({ pan: 'AAAPS1234F' });
    const noPan = await supplier();
    const acct = await bank();
    await pay(withPan, { account: acct._id, bill: await bill(withPan, { billDate: '2026-10-02' }) }, '2026-10-10');
    await pay(noPan, { account: acct._id, bill: await bill(noPan, { billDate: '2026-11-02' }) }, '2026-11-10');
    await post('/accounts/tds/challans', { month: '2026-10', section: '194C', amount: 1000, bsrCode: '0510308', challanNo: '00413', depositedOn: '2026-11-05' });
    const q = (await get('/accounts/tds/26q?fy=2026-27&q=Q3')).body;
    expect(q.rows).toHaveLength(2);
    expect(q.rows[0]).toMatchObject({ deductee: withPan.name, pan: 'AAAPS1234F', section: '194C', rate: 2, amountPaid: 50000, tds: 1000, challan: '0510308/00413/2026-11-05' });
    expect(q.rows[1]).toMatchObject({ deductee: noPan.name, pan: '', challan: '' });
    expect(q.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', text: expect.stringMatching(/no PAN on file.*20%/) }),
      expect.objectContaining({ level: 'warn', text: expect.stringMatching(/No challan recorded for 194C of 2026-11/) }),
    ]));
    expect(q.totals).toMatchObject({ amountPaid: 100000, tds: 2000, deductees: 2 });
    const xlsx = await request(app).get('/api/v2/accounts/tds/26q?fy=2026-27&q=Q3&format=xlsx').set('Cookie', cookie());
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    const cert = await post('/accounts/tds/certificates', { kind: 'issued', party: withPan._id, fy: '2026-27', quarter: 'Q3', certNo: 'ABCDEFG', section: '194C', amount: 1000, on: '2027-02-10' });
    expect(cert.status).toBe(201);
    expect((await get('/accounts/tds/26q?fy=2026-27&q=Q3')).body.certificates).toHaveLength(1);
  });

  it('tracks what customers deducted from us against certificates and Form 26AS', async () => {
    const { customer, inv } = await customerWithInvoice();
    await M.Customer.updateOne({ _id: customer._id }, { $set: { tan: 'CHEC12345A' } });
    const acct = await bank();
    const r = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 103000, mode: 'bank', account: acct._id, date: '2026-10-20', adjustments: [{ kind: 'tds_by_customer', amount: 2000 }], allocations: [{ docType: 'Invoice', doc: inv._id, amount: 105000 }] });
    expect(r.status).toBe(201);
    let rec = (await get('/accounts/tds/receivable?fy=2026-27')).body;
    expect(rec.rows).toEqual([expect.objectContaining({ customerName: customer.name, deducted: 2000, certificates: 0, in26as: 0, state: 'no26as' })]);
    await post('/accounts/tds/certificates', { kind: 'received', party: customer._id, fy: '2026-27', quarter: 'Q3', certNo: 'XYZ', section: '194C', amount: 2000, on: '2027-01-20' });
    const csv = ['Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted', `${customer.name.toUpperCase()},CHEC12345A,194C,20-Oct-2026,"1,00,000.00","1,500.00"`, 'SOMEONE ELSE,DELS99999Z,194C,02-Nov-2026,5000,50'].join('\n');
    const up = await request(app).post('/api/v2/accounts/tds/26as').set('Cookie', cookie()).field('fy', '2026-27').attach('file', Buffer.from(csv), '26AS.csv');
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ lines: 2, matched: 1 });
    expect(up.body.unmatched[0].tan).toBe('DELS99999Z');
    rec = up.body.receivable;
    expect(rec.rows[0]).toMatchObject({ deducted: 2000, certificates: 2000, in26as: 1500, short26as: 500, state: 'short' });
    expect(rec.unmatched26as).toBe(50);
  });

  it('switches 194Q on once a supplier\'s goods purchases pass the limit', async () => {
    await put('/accounts/settings', { tds: { purchase194q: { enabled: true, limit: 100000, rate: 0.1 } } });
    const s = await supplier({ pan: 'AAAPS9999Q' });
    const goods = (rate) => post('/accounts/bills', { supplier: s._id, supplierBillNo: `G/${++n}`, kind: 'goods', billDate: '2026-10-05', lines: [{ description: 'Yarn', hsn: '5402', unit: 'kg', quantity: 100, rate, gstPercent: 5 }] }).then((r) => r.body.bill);
    const first = await goods(600);   // 60,000: under
    expect(first.tds.applicable).toBe(false);
    const second = await goods(600);  // 1,20,000 in all: over
    expect(second.tds).toMatchObject({ applicable: true, section: '194Q', rate: 0.1 });
    const reg = (await get('/accounts/tds/194q?fy=2026-27')).body;
    expect(reg.rows[0]).toMatchObject({ supplierName: s.name, pan: 'AAAPS9999Q', purchases: 120000, crossed: true, over: 20000, tdsDue: 20, billsFlagged: 1 });
    await put('/accounts/settings', { tds: { purchase194q: { enabled: false } } });
  });
});

describe('payroll into the books', () => {
  it('posts the month\'s slips as a salary journal and the cash paid as another, and tracks PF / ESI deposits', async () => {
    await get('/accounts/bank-accounts');   // the cash box
    const emp = await M.Employee.create({ name: 'Murugan', department: 'weaving' });
    const emp2 = await M.Employee.create({ name: 'Selvi', department: 'weaving' });
    await M.Payroll.create({ employee: emp._id, year: 2026, month: 10, grossEarnings: 20000, totalBonuses: 500, totalDeductions: 3400, pfDeduction: 2400, esiDeduction: 150, totalAdvanceDeduction: 500, netPay: 17100, status: 'paid', payouts: [{ at: new Date('2026-11-02'), cash: 17100, advanceRecovered: 500 }] });
    await M.Payroll.create({ employee: emp2._id, year: 2026, month: 10, grossEarnings: 15000, totalBonuses: 0, totalDeductions: 1800, pfDeduction: 1800, esiDeduction: 0, totalAdvanceDeduction: 0, netPay: 13200, status: 'finalized' });
    await M.Payroll.create({ employee: emp2._id, year: 2026, month: 11, grossEarnings: 15000, netPay: 15000, status: 'draft' });
    const s = (await get('/accounts/payroll-books?month=2026-10')).body;
    expect(s.totals).toMatchObject({ people: 2, gross: 35000, bonuses: 500, pf: 4200, esi: 150, advances: 500, net: 30300, other: 350, expense: 35150 });
    expect(s.paid).toBe(0);
    expect(s.journals.salary).toBeNull();
    const posted = await post('/accounts/payroll-books/salary', { month: '2026-10' });
    expect(posted.status).toBe(201);
    const j = posted.body.journal;
    expect(j.purpose).toBe('salary');
    expect(j.lines.map((l) => [l.ledger, l.debit, l.credit])).toEqual([
      ['Salaries & Wages', 35150, 0], ['PF Payable', 0, 4200], ['ESI Payable', 0, 150], ['Staff Advances', 0, 500], ['Salary Payable', 0, 30300],
    ]);
    // Posted again with nothing changed in HR: the journal stays as it is.
    const same = await post('/accounts/payroll-books/salary', { month: '2026-10' });
    expect(same.status).toBe(201);
    expect(same.body.journal.journalNo).toBe(j.journalNo);
    expect(await M.Journal.countDocuments({ source: 'payroll', sourceRef: 'salary:2026-10' })).toBe(1);
    // A slip corrected in HR: posting again replaces it.
    await M.Payroll.updateOne({ employee: emp2._id, year: 2026, month: 10 }, { $set: { grossEarnings: 15200, netPay: 13400 } });
    const again = await post('/accounts/payroll-books/salary', { month: '2026-10' });
    expect(again.status).toBe(201);
    expect(again.body.journal.journalNo).not.toBe(j.journalNo);
    expect(await M.Journal.countDocuments({ source: 'payroll', sourceRef: 'salary:2026-10', status: 'posted' })).toBe(1);
    expect(await M.Journal.countDocuments({ source: 'payroll', sourceRef: 'salary:2026-10', status: 'cancelled' })).toBe(1);
    await M.Payroll.updateOne({ employee: emp2._id, year: 2026, month: 10 }, { $set: { grossEarnings: 15000, netPay: 13200 } });
    expect((await post('/accounts/payroll-books/salary', { month: '2026-10' })).status).toBe(201);
    // The cash went out in November.
    expect((await post('/accounts/payroll-books/paid', { month: '2026-10' })).status).toBe(409);
    const nov = (await get('/accounts/payroll-books?month=2026-11')).body;
    expect(nov.paid).toBe(17100);
    const paid = await post('/accounts/payroll-books/paid', { month: '2026-11' });
    expect(paid.status).toBe(201);
    expect(paid.body.journal.lines.map((l) => [l.kind, l.debit, l.credit])).toEqual([['ledger', 17100, 0], ['bank', 0, 17100]]);
    // PF deposited after the 15th: late.
    const dep = await post('/accounts/payroll-books/deposits', { kind: 'pf', month: '2026-10', amount: 4200, challanNo: 'TRRN1234', depositedOn: '2026-11-20' });
    expect(dep.status).toBe(201);
    expect(dep.body.summary.statutory.pf).toMatchObject({ due: 4200, deposited: 4200, late: true });
    expect(new Date(dep.body.summary.statutory.due).toISOString().slice(0, 10)).toBe('2026-11-15');
  });
});

describe('a challan, a deposit or a certificate is recorded once', () => {
  it('the same save sent twice, or the same challan entered again, does not double what was deposited', async () => {
    const challan = { month: '2026-09', section: '194C', amount: 1000, bsrCode: '0510308', challanNo: '00412', depositedOn: '2026-10-06' };
    const first = await post('/accounts/tds/challans', { ...challan, requestId: 'ch-1' });
    expect(first.status).toBe(201);
    // The same request again: answered by the first one's challan.
    const again = await post('/accounts/tds/challans', { ...challan, requestId: 'ch-1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replay: true, challan: { _id: first.body.challan._id } });
    // Entered a second time by hand: refused, saying it is there.
    const twice = await post('/accounts/tds/challans', challan);
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/Challan 00412 of 2026-10-06 for ₹1000\.00 is already recorded for 2026-09, section 194C/);
    // Two saves at the same moment: one challan.
    const other = { ...challan, challanNo: '00455', amount: 700 };
    const both = await Promise.all([post('/accounts/tds/challans', other), post('/accounts/tds/challans', other)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await M.TdsChallan.countDocuments({})).toBe(2);
    // One challan paid for two months is entered against each: not the same entry.
    expect((await post('/accounts/tds/challans', { ...challan, month: '2026-08', amount: 400 })).status).toBe(201);
    // With no challan number yet there is nothing to tell two apart by, but a request id still does.
    const blank = { month: '2026-09', section: '194J', amount: 250, depositedOn: '2026-10-06', requestId: 'ch-2' };
    expect((await post('/accounts/tds/challans', blank)).status).toBe(201);
    expect((await post('/accounts/tds/challans', blank)).status).toBe(200);
    expect(await M.TdsChallan.countDocuments({ section: '194J' })).toBe(1);

    const StatutoryDeposit = require('../../models/StatutoryDeposit');
    const dep = { kind: 'pf', month: '2026-10', amount: 4200, challanNo: 'TRRN1234', depositedOn: '2026-11-10' };
    expect((await post('/accounts/payroll-books/deposits', { ...dep, requestId: 'dep-1' })).status).toBe(201);
    expect((await post('/accounts/payroll-books/deposits', { ...dep, requestId: 'dep-1' })).body.replay).toBe(true);
    const depTwice = await post('/accounts/payroll-books/deposits', dep);
    expect(depTwice.status).toBe(409);
    expect(depTwice.body.message).toMatch(/PF challan TRRN1234 of 2026-11-10 for ₹4200\.00 is already recorded for 2026-10/);
    expect((await post('/accounts/payroll-books/deposits', { ...dep, kind: 'esi' })).status).toBe(201);
    expect(await StatutoryDeposit.countDocuments({})).toBe(2);

    const TdsCertificate = require('../../models/TdsCertificate');
    const s = await supplier({ name: 'Raja Dyers', pan: 'AAAPR1234F' });
    const cert = { kind: 'issued', party: s._id, fy: '2026-27', quarter: 'Q2', certNo: 'ABCDEFG', section: '194C', amount: 1000, on: '2026-11-10' };
    expect((await post('/accounts/tds/certificates', { ...cert, requestId: 'cert-1' })).status).toBe(201);
    expect((await post('/accounts/tds/certificates', { ...cert, requestId: 'cert-1' })).body.replay).toBe(true);
    const certTwice = await post('/accounts/tds/certificates', cert);
    expect(certTwice.status).toBe(409);
    expect(certTwice.body.message).toMatch(/Certificate ABCDEFG for Raja Dyers, 2026-27 Q2, section 194C is already recorded/);
    expect((await post('/accounts/tds/certificates', { ...cert, quarter: 'Q3' })).status).toBe(201);
    expect(await TdsCertificate.countDocuments({})).toBe(2);
  });
});

describe('a machine\'s service bill into the books', () => {
  it('offers a draft from the service log, and the bill it becomes carries the photo and links back', async () => {
    const s = await supplier({ name: 'Comez Spares' });
    const machine = await M.Machine.create({ ID: 'M-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 });
    const log = await post('/machine/add-service-log', { machineId: String(machine._id), type: 'Corrective', description: 'Replaced drive belt' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await request(app).post('/api/v2/machine/service-bill').set('Cookie', cookie()).field('machineId', String(machine._id)).field('serviceLogId', log.body.log._id).field('kind', 'spare_bill').field('amount', '750').field('vendor', 'Comez Spares').field('billNo', 'CS/77').field('partName', 'Drive belt').attach('file', png, { filename: 'belt.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const sbId = up.body.bill._id;
    expect((await get('/accounts/inbox')).body.serviceBills).toMatchObject({ count: 1, amount: 750 });
    const draft = (await get(`/accounts/service-bills/${sbId}/draft`)).body.draft;
    expect(draft).toMatchObject({ supplier: String(s._id), supplierName: 'Comez Spares', supplierBillNo: 'CS/77', kind: 'service', lines: [{ description: 'Spare: Drive belt', quantity: 1, rate: 750 }] });
    const b = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'CS/77', kind: 'service', serviceBill: sbId, billDate: '2026-10-10', lines: [{ description: 'Spare: Drive belt', quantity: 1, rate: 750, gstPercent: 18 }], tds: { applicable: false } });
    expect(b.status).toBe(201);
    expect(String(b.body.bill.machine)).toBe(String(machine._id));
    const stored = await M.SupplierBill.findById(b.body.bill._id).lean();
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0]).toMatchObject({ filename: 'belt.png', contentType: 'image/png' });
    expect(String((await M.MachineServiceBill.findById(sbId).lean()).supplierBill)).toBe(String(b.body.bill._id));
    expect((await get(`/accounts/service-bills/${sbId}/draft`)).body.entered).toBe(String(b.body.bill._id));
    expect((await get('/accounts/inbox')).body.serviceBills.count).toBe(0);
    expect((await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'CS/78', kind: 'service', serviceBill: sbId, lines: [{ description: 'x', quantity: 1, rate: 1 }] })).status).toBe(409);

    // Entered wrongly and cancelled: the service bill is free again, back
    // on the list of what is not yet in the books, and can be entered right.
    expect((await post(`/accounts/bills/${b.body.bill._id}/cancel`, { reason: 'Entered at the wrong GST rate' })).status).toBe(200);
    expect((await M.MachineServiceBill.findById(sbId).lean()).supplierBill).toBeNull();
    expect((await get('/accounts/inbox')).body.serviceBills).toMatchObject({ count: 1, amount: 750 });
    expect((await get(`/accounts/service-bills/${sbId}/draft`)).body.entered).toBeFalsy();
    const again = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'CS/77', kind: 'service', serviceBill: sbId, billDate: '2026-10-10', lines: [{ description: 'Spare: Drive belt', quantity: 1, rate: 750, gstPercent: 28 }], tds: { applicable: false } });
    expect(again.status).toBe(201);
    expect(String((await M.MachineServiceBill.findById(sbId).lean()).supplierBill)).toBe(String(again.body.bill._id));
  });

  it('entered twice together becomes one bill', async () => {
    const s = await supplier({ name: 'Comez Spares' });
    const machine = await M.Machine.create({ ID: 'M-02', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 });
    const log = await post('/machine/add-service-log', { machineId: String(machine._id), type: 'Corrective', description: 'Replaced heald wire' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await request(app).post('/api/v2/machine/service-bill').set('Cookie', cookie()).field('machineId', String(machine._id)).field('serviceLogId', log.body.log._id).field('kind', 'spare_bill').field('amount', '900').field('vendor', 'Comez Spares').field('billNo', 'CS/90').field('partName', 'Heald wire').attach('file', png, { filename: 'heald.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const sbId = up.body.bill._id;
    const bill = (no) => post('/accounts/bills', { supplier: s._id, supplierBillNo: no, kind: 'service', serviceBill: sbId, billDate: '2026-10-12', lines: [{ description: 'Spare: Heald wire', quantity: 1, rate: 900, gstPercent: 18 }], tds: { applicable: false } });
    const both = await Promise.all([bill('CS/90'), bill('CS/90-A')]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await M.SupplierBill.countDocuments({ serviceBill: sbId, status: { $ne: 'cancelled' } })).toBe(1);
  });
});

describe('e-way bill', () => {
  it('is generated from the IRN through the provider, or pasted; a challan takes a pasted number', async () => {
    const { inv } = await customerWithInvoice({ einvoice: { status: 'registered', irn: 'a'.repeat(64), ackNo: '112010', ackDate: new Date(), signedQr: 'x', provider: 'test' } });
    const { PROVIDERS } = require('../../services/einvoiceProvider');
    PROVIDERS.test = () => ({ async register() { throw new Error('not here'); }, async ewaybill(p) { expect(p).toMatchObject({ Irn: 'a'.repeat(64), VehNo: 'TN39BX1234', TransMode: '1', Distance: 60 }); return { number: '341009876543', generatedAt: new Date('2026-10-06T10:00:00Z'), validUpto: new Date('2026-10-07T23:59:59Z') }; } });
    await put('/settings/document', { invoice: { gsp: { provider: 'test', baseUrl: 'https://t', clientId: 'x', clientSecret: 'y' } } });
    const json = await get(`/invoice/${inv._id}/ewaybill.json?vehicleNo=TN39BX1234&distanceKm=60`);
    expect(JSON.parse(json.text)).toMatchObject({ needed: true, value: 105000, byIrn: { Irn: 'a'.repeat(64), VehNo: 'TN39BX1234' } });
    const bad = await post(`/invoice/${inv._id}/ewaybill`, { vehicleNo: 'TRUCK-1', distanceKm: 60 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not in the RTO form/);
    const gen = await post(`/invoice/${inv._id}/ewaybill`, { vehicleNo: 'tn 39 bx 1234', distanceKm: 60, transporterName: 'VRL' });
    expect(gen.status).toBe(200);
    expect(gen.body.invoice.ewaybill).toMatchObject({ status: 'generated', number: '341009876543', vehicleNo: 'TN39BX1234', provider: 'test', distanceKm: 60 });
    expect((await post(`/invoice/${inv._id}/ewaybill`, { vehicleNo: 'TN39BX1234' })).status).toBe(409);
    delete PROVIDERS.test;
    await put('/settings/document', { invoice: { gsp: { provider: '' } } });
    // Another invoice, no provider: paste.
    const { inv: inv2 } = await customerWithInvoice();
    expect((await post(`/invoice/${inv2._id}/ewaybill/paste`, { number: '12345', vehicleNo: 'TN39BX1234' })).status).toBe(400);
    const pasted = await post(`/invoice/${inv2._id}/ewaybill/paste`, { number: '3410 1234 5678', vehicleNo: 'TN39BX1234', validUpto: '2026-10-08' });
    expect(pasted.status).toBe(200);
    expect(pasted.body.invoice.ewaybill).toMatchObject({ status: 'generated', number: '341012345678', provider: 'manual' });
    // A challan.
    const dc = await M.DeliveryChallan.create({ dcNumber: 'DC/2026-27/0001', type: 'elastic', financialYear: '2026-27', sequence: 1, customerName: 'Sunrise', totalAmount: 60000, status: 'dispatched' });
    const dcp = await post(`/dc/${dc._id}/ewaybill/paste`, { number: '341099998888', vehicleNo: 'TN39BX1234' });
    expect(dcp.status).toBe(200);
    expect(dcp.body.dc.ewaybill).toMatchObject({ status: 'generated', number: '341099998888' });
    expect(dcp.body.dc.vehicleNo).toBe('TN39BX1234');
  });
});

describe('a credit note past its time', () => {
  it('may carry GST until 30 November of the next year; after that only a financial credit note, outside GSTR-1', async () => {
    const { inv } = await customerWithInvoice({ invoiceDate: new Date('2025-06-10') });
    const lim = (await get(`/accounts/credit-note-limit?invoice=${inv._id}`)).body;
    expect(new Date(lim.limit).toISOString().slice(0, 10)).toBe('2026-11-30');
    const inTime = await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', date: '2026-11-20', lines: [{ description: '20mm', quantity: 100, rate: 1, gstPercent: 5 }] });
    expect(inTime.status).toBe(201);
    expect(inTime.body.note.totals.grand).toBe(105);
    const late = await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', date: '2026-12-05', lines: [{ description: '20mm', quantity: 100, rate: 1, gstPercent: 5 }] });
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('CN_TIME_LIMIT');
    expect(late.body.message).toMatch(/until 30 Nov 2026/);
    const fin = await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', date: '2026-12-05', financial: true, lines: [{ description: '20mm', quantity: 100, rate: 1, gstPercent: 5 }] });
    expect(fin.status).toBe(201);
    expect(fin.body.note).toMatchObject({ financial: true, totals: { taxable: 100, tax: 0, grand: 100 } });
    const g = (await get('/accounts/gstr1?month=2026-12')).body;
    expect(g.cdnr).toEqual([]);
    const nov = (await get('/accounts/gstr1?month=2026-11')).body;
    expect(nov.cdnr[0].nt[0].val).toBe(105);
    // Tally: the financial note goes to Discount Allowed, no tax.
    const built = await require('../../services/tallyExport').build({ from: new Date('2026-12-01'), to: new Date('2026-12-31T23:59:59'), fresh: true, L: require('../../services/partyStatement').DEFAULT_LEDGERS });
    const v = built.vouchers.find((x) => x.docType === 'AccountNote');
    expect(v.lines.map((l) => [l.ledger, l.amount])).toEqual(expect.arrayContaining([['Discount Allowed', 100]]));
    expect(v.lines.some((l) => /CGST|SGST|Sales/.test(l.ledger))).toBe(false);
  });
});

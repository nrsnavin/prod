'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE STATUTORY SIDE OF THE BOOKS
//
//    MSME       a bill to a micro supplier falls due in 15 days (or the
//               agreed days, at most 45), shows on the inbox when late,
//               is disallowed at year end if unpaid, and goes on Form I
//    GSTR-2B    the portal's JSON is matched to bills by GSTIN and
//               number (written any way), tax within a rupee; a bill
//               the supplier never reported is "missing" and its ITC held
//    Rule 37    a bill unpaid 180 days lists the credit to reverse,
//               the reversal is recorded, and re-claimed when paid; the
//               GST report carries both
//    GSTR-1     B2B, B2CS, CDNR, HSN and the document series, with the
//               checks a preparer makes, and the offline tool's JSON
//    Journal    a set-off between a party's two sides posts to both
//               ledgers bill-wise, goes to Tally balanced, and cancels
//               back; debits must equal credits
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Payment', 'BankAccount', 'Journal', 'Gstr2bEntry', 'PartyLedgerEntry']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'stat@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'stat-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806', stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const supplier = async (over = {}) => { n += 1; return M.Supplier.create({ name: `Supplier ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', ...over }); };
const bill = (s, body) => post('/accounts/bills', { supplier: s._id, supplierBillNo: `S/${++n}`, kind: 'service', lines: [{ description: 'Dyeing', quantity: 1, rate: 10000, gstPercent: 5 }], ...body }).then((r) => { if (r.status !== 201) throw new Error(r.body.message); return r.body.bill; });
const bank = async () => { await get('/accounts/bank-accounts'); return (await post('/accounts/bank-accounts', { name: `Bank ${++n}`, kind: 'bank', tallyLedger: 'Kotak Bank' })).body.account; };
async function customerWithInvoice(grand = 10500) {
  n += 1;
  const customer = await M.Customer.create({ name: `Customer ${n}`, contactName: 'R', phoneNumber: `9300000${String(n).padStart(3, '0')}`, gstin: `33AAEPC${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-10-05'), dueDate: new Date('2026-11-04'),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
  return { customer, inv };
}

describe('MSME suppliers (s.43B(h))', () => {
  it('caps the due date at the statutory days and lists the bill on the inbox when late', async () => {
    const micro = await supplier({ msme: { category: 'micro', udyam: 'UDYAM-TN-28-0001234', agreedDays: 0 } });
    const b = await bill(micro, { billDate: '2026-09-01' });
    // 15 days, not the supplier's 30-day terms.
    expect(new Date(b.dueDate).toISOString().slice(0, 10)).toBe('2026-09-16');
    // Agreed 45 days in writing, terms of 60: the law's 45 wins.
    const agreed = await supplier({ msme: { category: 'small', agreedDays: 45 }, paymentTermsDays: 60 });
    const b2 = await bill(agreed, { billDate: '2026-09-01' });
    expect(new Date(b2.dueDate).toISOString().slice(0, 10)).toBe('2026-10-16');
    const dues = (await get('/accounts/msme')).body;
    expect(dues.rows).toHaveLength(2);
    expect(dues.rows[0]).toMatchObject({ docNo: b.billNo, category: 'micro', days: 15, state: 'overdue' });
    expect(dues.totals.overdueCount).toBe(2);
    const inbox = (await get('/accounts/inbox')).body;
    expect(inbox.msmeDue).toMatchObject({ count: 2, overdue: 2 });
    // A medium enterprise is outside the rule.
    const medium = await supplier({ msme: { category: 'medium' } });
    const b3 = await bill(medium, { billDate: '2026-09-01' });
    expect(new Date(b3.dueDate).toISOString().slice(0, 10)).toBe('2026-10-01');
    expect((await get('/accounts/msme')).body.rows).toHaveLength(2);
  });

  it('at year end: paid in time is allowed, paid late is allowed with interest, unpaid is disallowed; Form I lists what is over 45 days', async () => {
    const micro = await supplier({ msme: { category: 'micro' } });
    const acct = await bank();
    const onTime = await bill(micro, { billDate: '2026-06-01' });
    const late = await bill(micro, { billDate: '2026-06-01' });
    const unpaid = await bill(micro, { billDate: '2026-07-01' });
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: micro._id, amount: 10500, mode: 'bank', account: acct._id, date: '2026-06-10', allocations: [{ docType: 'SupplierBill', doc: onTime._id, amount: 10500 }] });
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: micro._id, amount: 10500, mode: 'bank', account: acct._id, date: '2026-08-20', allocations: [{ docType: 'SupplierBill', doc: late._id, amount: 10500 }] });
    const ye = (await get('/accounts/msme/year-end?fy=2026-27')).body;
    const byNo = Object.fromEntries(ye.rows.map((r) => [r.docNo, r]));
    expect(byNo[onTime.billNo]).toMatchObject({ status: 'allowed', paidByDue: 10500 });
    expect(byNo[late.billNo]).toMatchObject({ status: 'late', paidLate: 10500 });
    expect(byNo[unpaid.billNo]).toMatchObject({ status: 'disallowed', disallowed: 10500 });
    expect(ye.totals).toMatchObject({ disallowed: 10500, late: 10500, allowed: 10500 });
    const f1 = (await get('/accounts/msme/form1?asOf=2026-09-30')).body;
    expect(f1.rows.map((r) => r.docNo)).toEqual([unpaid.billNo]);
    expect(f1.total).toBe(10500);
    const xlsx = await request(app).get('/api/v2/accounts/msme/form1?asOf=2026-09-30&format=xlsx').set('Cookie', cookie());
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
  });
});

describe('GSTR-2B against the books', () => {
  const twoB = (rows) => ({ data: { gstin: '33AAECB1234F1Z5', rtnprd: '102026', docdata: { b2b: rows } } });
  it('matches by GSTIN and number however written, flags a different tax, and holds ITC on bills the supplier did not report', async () => {
    const s = await supplier();
    const matched = await bill(s, { supplierBillNo: 'INV/0042', billDate: '2026-10-03' });                         // 10,000 + 500
    const off = await bill(s, { supplierBillNo: 'INV-43', billDate: '2026-10-05' });
    const missing = await bill(s, { supplierBillNo: 'INV-44', billDate: '2026-10-07' });
    const items = (txval, cgst, sgst) => [{ num: 1, rt: 5, txval, cgst, sgst, igst: 0, cess: 0 }];
    const json = twoB([{ ctin: s.gstin, trdnm: s.name, inv: [
      { inum: 'inv42', dt: '03-10-2026', val: 10500, pos: '33', rev: 'N', itcavl: 'Y', items: items(10000, 250, 250) },
      { inum: 'INV/43', dt: '05-10-2026', val: 10700, pos: '33', rev: 'N', itcavl: 'Y', items: items(10000, 350, 350) },
      { inum: 'INV/99', dt: '09-10-2026', val: 1180, pos: '33', rev: 'N', itcavl: 'N', rsn: 'POS and supplier state different', items: items(1000, 90, 90) },
    ] }]);
    const up = await request(app).post('/api/v2/accounts/gstr2b/upload').set('Cookie', cookie()).attach('file', Buffer.from(JSON.stringify(json)), 'gstr2b.json');
    expect(up.status).toBe(200);
    expect(up.body.period).toBe('2026-10');
    expect(up.body.counts).toEqual({ entries: 3, matched: 1, mismatch: 1, notInBooks: 1, missing: 1 });
    expect(up.body.itc).toMatchObject({ matched: 500, mismatch: 700, missing: 500, unavailable: 180 });
    const byNo = Object.fromEntries(up.body.rows.map((r) => [r.number, r]));
    expect(byNo.inv42.match).toMatchObject({ status: 'matched', docNo: matched.billNo, by: 'number' });
    expect(byNo['INV/43'].match).toMatchObject({ status: 'mismatch', docNo: off.billNo, diff: -200 });
    expect(byNo['INV/99'].match.status).toBe('notInBooks');
    expect(up.body.missing.map((b) => b.billNo)).toEqual([missing.billNo]);
    const b = await M.SupplierBill.findById(missing._id).lean();
    expect(b.gstr2b).toMatchObject({ status: 'missing', period: '2026-10' });
    expect((await M.SupplierBill.findById(off._id).lean()).gstr2b.note).toMatch(/in books ₹500.00, in 2B ₹700.00/);
    // A second upload of the month replaces the first; the close checklist knows.
    const again = await request(app).post('/api/v2/accounts/gstr2b/upload').set('Cookie', cookie()).field('period', '2026-10').attach('file', Buffer.from(JSON.stringify(json)), 'gstr2b.json');
    expect(again.body.counts.entries).toBe(3);
    const close = (await get('/accounts/close?month=2026-10')).body;
    const item = close.items.find((i) => i.key === 'gstr2b');
    expect(item.ok).toBe(false);
    expect(item.detail).toMatch(/1 bill not in 2B/);
  });

  it('refuses a file that is not GSTR-2B', async () => {
    const r = await request(app).post('/api/v2/accounts/gstr2b/upload').set('Cookie', cookie()).field('period', '2026-10').attach('file', Buffer.from('{"hello":1}'), 'x.json');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/not a GSTR-2B file/);
  });
});

describe('Rule 37: credit on bills unpaid 180 days', () => {
  it('lists the unpaid share to reverse, records it, and re-claims once paid', async () => {
    const s = await supplier();
    const acct = await bank();
    const old = await bill(s, { billDate: '2026-03-10' });   // 180 days: 6 Sep
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: 5250, mode: 'bank', account: acct._id, date: '2026-05-01', allocations: [{ docType: 'SupplierBill', doc: old._id, amount: 5250 }] });
    await bill(s, { billDate: '2026-08-01' });                // not yet 180 days in September
    const due = (await get('/accounts/itc-reversal?month=2026-09')).body;
    expect(due.toReverse).toHaveLength(1);
    expect(due.toReverse[0]).toMatchObject({ billNo: old.billNo, outstanding: 5250, itc: 500, reverse: 250, inMonth: true });
    const rev = await post(`/accounts/bills/${old._id}/itc-reverse`, { month: '2026-09' });
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ amount: 250, period: '2026-09' });
    expect((await post(`/accounts/bills/${old._id}/itc-reverse`, { month: '2026-09' })).status).toBe(409);
    const gst = (await get('/accounts/reports/gst?from=2026-09-01&to=2026-09-30')).body;
    expect(gst.totals.rule37.reversed).toMatchObject({ total: 250, cgst: 125, sgst: 125 });
    expect(gst.totals.netInput.cgst).toBe(-125);
    // Paid in November: re-claim there.
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: 5250, mode: 'bank', account: acct._id, date: '2026-11-02', allocations: [{ docType: 'SupplierBill', doc: old._id, amount: 5250 }] });
    const nov = (await get('/accounts/itc-reversal?month=2026-11')).body;
    expect(nov.toReclaim).toEqual([expect.objectContaining({ billNo: old.billNo, reclaim: 250, fully: true })]);
    expect((await post(`/accounts/bills/${old._id}/itc-reclaim`, { month: '2026-11' })).body.amount).toBe(250);
    expect((await get('/accounts/reports/gst?from=2026-11-01&to=2026-11-30')).body.totals.rule37.reclaimed.total).toBe(250);
    expect((await get('/accounts/itc-reversal?month=2026-11')).body.totals.reclaimed).toBe(250);
  });
});

describe('GSTR-1 for a month', () => {
  it('fills the tables, sums the HSN, lists the document series, and flags what a preparer would', async () => {
    const { customer, inv } = await customerWithInvoice();
    // A customer with a GSTIN on file but an invoice without one: flagged, and in B2CS.
    const { inv: noGstin } = await customerWithInvoice();
    await M.Invoice.updateOne({ _id: noGstin._id }, { $set: { 'buyer.gstin': '', 'lines.0.hsn': '58' } });
    await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', lines: [{ description: '20mm', hsn: '5806', unit: 'm', quantity: 100, rate: 1, gstPercent: 5 }], date: '2026-10-20' });
    const r = (await get('/accounts/gstr1?month=2026-10')).body;
    expect(r.fp).toBe('102026');
    expect(r.b2b).toHaveLength(1);
    expect(r.b2b[0]).toMatchObject({ ctin: customer.gstin });
    expect(r.b2b[0].inv[0]).toMatchObject({ inum: inv.invoiceNumber, idt: '05-10-2026', val: 10500, pos: '33' });
    expect(r.b2b[0].inv[0].itms[0].itm_det).toEqual({ rt: 5, txval: 10000, iamt: 0, camt: 250, samt: 250, csamt: 0 });
    expect(r.b2cs).toEqual([expect.objectContaining({ sply_ty: 'INTRA', pos: '33', rt: 5, txval: 10000, camt: 250, samt: 250, count: 1 })]);
    expect(r.cdnr[0].nt[0]).toMatchObject({ ntty: 'C', val: 105, against: inv.invoiceNumber });
    // HSN: two invoices less the credit note.
    expect(r.hsn).toEqual([expect.objectContaining({ hsn_sc: '58', qty: 1000, txval: 10000 }), expect.objectContaining({ hsn_sc: '5806', uqc: 'MTR', qty: 900, txval: 9900, camt: 247.5 })]);
    expect(r.docs[0].docs[0]).toMatchObject({ totnum: 2, cancel: 0, net_issue: 2 });
    expect(r.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', doc: noGstin.invoiceNumber, text: expect.stringMatching(/GSTIN .* on file but the invoice carries none/) }),
      expect.objectContaining({ level: 'warn', doc: noGstin.invoiceNumber, text: expect.stringMatching(/HSN 58 has 2 digits; 4 are required/) }),
    ]));
    const json = await request(app).get('/api/v2/accounts/gstr1/json?month=2026-10').set('Cookie', cookie());
    expect(json.headers['content-disposition']).toMatch(/GSTR1_33AAECB1234F1Z5_102026\.json/);
    const body = JSON.parse(json.text);
    expect(body).toMatchObject({ gstin: '33AAECB1234F1Z5', fp: '102026' });
    expect(body.b2b[0].inv[0]).not.toHaveProperty('customer');
    expect(body.hsn.data).toHaveLength(2);
    const xlsx = await request(app).get('/api/v2/accounts/gstr1/xlsx?month=2026-10').set('Cookie', cookie());
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
  });
});

describe('journal vouchers', () => {
  it('sets a party off between its customer and supplier sides, bill-wise, and reaches Tally balanced', async () => {
    const { customer, inv } = await customerWithInvoice();             // they owe us 10,500
    const s = await supplier({ name: customer.name });
    const b = await bill(s, { billDate: '2026-10-10' });                // we owe them 10,500
    const r = await post('/accounts/journals', {
      date: '2026-10-15', purpose: 'setoff', reason: 'Set off their bill against our invoice, agreed on the phone', narration: 'Mutual set-off',
      lines: [
        { kind: 'party', partyType: 'supplier', party: s._id, debit: 10500, refs: [{ docType: 'SupplierBill', doc: b._id, amount: 10500 }] },
        { kind: 'party', partyType: 'customer', party: customer._id, credit: 10500, refs: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] },
      ],
    });
    expect(r.status).toBe(201);
    const j = r.body.journal;
    expect(j.journalNo).toBe('JV/2026-27/0001');
    expect(j.total).toBe(10500);
    expect((await M.SupplierBill.findById(b._id).lean())).toMatchObject({ debitedAmount: 10500, status: 'paid' });
    expect((await M.Invoice.findById(inv._id).lean()).creditedAmount).toBe(10500);
    // Both ledgers: the customer's by Journal, closing nil.
    const cst = (await get(`/accounts/statement?partyType=customer&party=${customer._id}`)).body;
    expect(cst.rows[1]).toMatchObject({ docType: 'Journal', docNo: 'JV/2026-27/0001', vchType: 'Journal', toBy: 'By', credit: 10500 });
    expect(cst.rows[1].refs).toEqual([{ type: 'Agst Ref', name: inv.invoiceNumber, amount: 10500 }]);
    expect(cst.closing).toBe(0);
    expect((await get(`/accounts/statement?partyType=supplier&party=${s._id}`)).body.closing).toBe(0);
    // Tally: one Journal voucher, balanced, with the bill references.
    const built = await require('../../services/tallyExport').build({ from: new Date('2026-10-01'), to: new Date('2026-10-31T23:59:59'), fresh: true, L: require('../../services/partyStatement').DEFAULT_LEDGERS });
    expect(built.problems).toEqual([]);
    const jv = built.vouchers.find((v) => v.docType === 'Journal');
    expect(jv).toBeTruthy();
    expect(jv.type).toBe('Journal');
    expect(jv.lines.reduce((t, l) => t + l.amount, 0)).toBeCloseTo(0, 2);
    expect(jv.lines.find((l) => l.amount < 0).bills).toEqual([{ name: inv.invoiceNumber, type: 'Agst Ref', amount: 10500 }]);
    // Cancel: everything back.
    const c = await post(`/accounts/journals/${j._id}/cancel`, { reason: 'Entered against the wrong bill' });
    expect(c.status).toBe(200);
    expect((await M.SupplierBill.findById(b._id).lean()).debitedAmount).toBe(0);
    expect((await get(`/accounts/statement?partyType=customer&party=${customer._id}`)).body.closing).toBe(10500);
    expect(await M.PartyLedgerEntry.countDocuments({ docType: 'Journal' })).toBe(0);
  });

  it('refuses what does not balance, a reference on the wrong side, and a large one from a clerk when the limit says so', async () => {
    const { customer, inv } = await customerWithInvoice();
    const acct = await bank();
    const unbalanced = await post('/accounts/journals', { date: '2026-10-15', reason: 'Written off, customer closed down', lines: [{ kind: 'ledger', ledger: 'Bad Debts Written Off', debit: 500 }, { kind: 'party', partyType: 'customer', party: customer._id, credit: 400 }] });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.message).toMatch(/Debits 500.00 and credits 400.00 must be equal/);
    const wrongSide = await post('/accounts/journals', { date: '2026-10-15', reason: 'Written off, customer closed down', lines: [{ kind: 'bank', account: acct._id, credit: 500 }, { kind: 'party', partyType: 'customer', party: customer._id, debit: 500, refs: [{ docType: 'Invoice', doc: inv._id, amount: 500 }] }] });
    expect(wrongSide.status).toBe(400);
    expect(wrongSide.body.message).toMatch(/cannot raise what .* owes — issue a debit note/);
    await put('/accounts/settings', { journals: { approvalAbove: 1000 } });
    const big = { date: '2026-10-15', purpose: 'writeoff', reason: 'Written off, customer closed down', lines: [{ kind: 'ledger', ledger: 'Bad Debts Written Off', debit: 10500 }, { kind: 'party', partyType: 'customer', party: customer._id, credit: 10500, refs: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] }] };
    const byClerk = await post('/accounts/journals', big, clerk);
    expect(byClerk.status).toBe(403);
    expect(byClerk.body.message).toMatch(/needs an admin/);
    const byAdmin = await post('/accounts/journals', big);
    expect(byAdmin.status).toBe(201);
    expect((await get('/accounts/journals?purpose=writeoff')).body.journals).toHaveLength(1);
    expect((await get(`/accounts/journals/${byAdmin.body.journal._id}`)).body.journal.lines[1].refs[0].docNo).toBe(inv.invoiceNumber);
  });
});

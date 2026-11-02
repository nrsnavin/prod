'use strict';
// ══════════════════════════════════════════════════════════════════
//  TO TALLY, AND THE BANK RECONCILED
//
//    • every kind of document becomes the Tally voucher an accountant
//      would key, each balanced, party lines carrying bill references
//    • an export is a batch: its documents are stamped and never go
//      twice, and it can close the books up to its end
//    • a statement upload is kept: what the bank shows is cleared in
//      the books, a set-aside line stays set aside, and the
//      reconciliation explains the bank's balance to the paisa
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
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'BankAccount', 'ExpenseCategory', 'Contra', 'TallyBatch', 'AccountsSettings', 'BankStatement']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'tally@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'tally-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function scene() {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '30', phoneNumber: '9200000000' });
  const supplier = await M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${1000 + n}F1Z5` });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-07-02'), dueDate: new Date('2026-08-01'),
    order: new mongoose.Types.ObjectId(), orderNo: 40 + n, customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand: 10500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500 });
  await get('/accounts/bank-accounts'); // seeds the cash box
  const bank = (await post('/accounts/bank-accounts', { name: `Kotak ${n}`, kind: 'bank', openingBalance: 100000, tallyLedger: 'Kotak Bank CA' })).body.account;
  const cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
  return { customer, supplier, inv, bank, cash };
}

/** Each VOUCHER block's ledger amounts, as numbers. */
function vouchersIn(xml) {
  return [...xml.matchAll(/<VOUCHER VCHTYPE="([^"]+)"[\s\S]*?<\/VOUCHER>/g)].map((m) => ({
    type: m[1],
    number: m[0].match(/<VOUCHERNUMBER>([^<]+)</)[1],
    lines: [...m[0].matchAll(/<ALLLEDGERENTRIES.LIST><LEDGERNAME>([^<]+)<\/LEDGERNAME><ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><AMOUNT>([^<]+)<\/AMOUNT>/g)].map((l) => ({ ledger: l[1].replace(/&amp;/g, '&'), dr: l[2] === 'Yes', amount: Number(l[3]) })),
  }));
}

describe('the Tally export', () => {
  it('turns each document into a balanced Tally voucher, once', async () => {
    const s = await scene();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/118', billDate: '2026-07-03', lines: [{ description: 'Nylon', quantity: 100, rate: 300, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 1 } })).body.bill; // 31,500
    await get('/accounts/categories');
    const freight = await M.ExpenseCategory.findOne({ name: /Transport/i });
    await M.ExpenseCategory.updateOne({ _id: freight._id }, { approvalAbove: 100000, ledger: 'Freight Outward' });
    await post('/accounts/expenses', { category: freight._id, description: 'Lorry to Tiruppur', supplier: s.supplier._id, amount: 2000, date: '2026-07-04' });
    const cn = (await post('/accounts/notes', { kind: 'credit', against: { doc: s.inv._id }, reason: 'Rate difference', date: '2026-07-05', lines: [{ description: 'Rate', quantity: 1, rate: 1000, gstPercent: 5 }] })).body.note;
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 9400, mode: 'bank', account: s.bank._id, date: '2026-07-06', reference: 'UTR9',
      adjustments: [{ kind: 'bank_charges', amount: 50 }], allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 9450 }] });
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 31200, mode: 'bank', account: s.bank._id, date: '2026-07-07',
      allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 31500 }] });
    await post('/accounts/contras', { from: s.bank._id, to: s.cash._id, amount: 5000, date: '2026-07-08' });

    const preview = await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31');
    expect(preview.status).toBe(200);
    expect(preview.body.counts).toEqual({ Sales: 1, Purchase: 1, Journal: 1, 'Credit Note': 1, Receipt: 1, Payment: 1, Contra: 1 });
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.ledgers).toEqual(expect.arrayContaining(['Kotak Bank CA', 'Cash box', 'Sales', 'Purchase', 'Output CGST', 'Input SGST', 'TDS Payable', 'Bank Charges', 'Freight Outward', s.customer.name, s.supplier.name]));

    // A clerk exports; only an admin locks.
    expect((await post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31', lock: true }, clerk)).status).toBe(403);
    const ex = await post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31', lock: true, masters: true });
    expect(ex.status).toBe(201);
    expect(ex.body.batch).toMatchObject({ batchNo: 1, vouchers: 7 });
    const xml = (await request(app).get(`/api/v2/accounts/tally/batches/${ex.body.batch._id}/xml`).set('Cookie', cookie())).text;
    expect(xml).toMatch(/<TALLYREQUEST>Import Data<\/TALLYREQUEST>/);
    expect(xml).toMatch(/<SVCURRENTCOMPANY>Balu Elastics<\/SVCURRENTCOMPANY>/);
    expect(xml).toMatch(new RegExp(`<LEDGER NAME="${s.customer.name}" ACTION="Create">.*<PARENT>Sundry Debtors</PARENT>`));

    const vs = vouchersIn(xml);
    expect(vs).toHaveLength(7);
    for (const v of vs) expect(Math.round(v.lines.reduce((t, l) => t + l.amount, 0) * 100)).toBe(0);
    const sales = vs.find((v) => v.type === 'Sales');
    expect(sales.lines).toEqual(expect.arrayContaining([
      { ledger: s.customer.name, dr: true, amount: -10500 }, { ledger: 'Sales', dr: false, amount: 10000 }, { ledger: 'Output CGST', dr: false, amount: 250 },
    ]));
    expect(xml).toMatch(new RegExp(`<NAME>${s.inv.invoiceNumber.replace(/\//g, '\\/')}</NAME><BILLTYPE>New Ref</BILLTYPE>`));
    const purchase = vs.find((v) => v.type === 'Purchase');
    expect(purchase.lines).toEqual(expect.arrayContaining([{ ledger: s.supplier.name, dr: false, amount: 31500 }, { ledger: 'Purchase', dr: true, amount: -30000 }, { ledger: 'Input CGST', dr: true, amount: -750 }]));
    expect(vs.find((v) => v.type === 'Journal').lines).toEqual(expect.arrayContaining([{ ledger: 'Freight Outward', dr: true, amount: -2000 }]));
    expect(vs.find((v) => v.type === 'Receipt').lines).toEqual(expect.arrayContaining([
      { ledger: 'Kotak Bank CA', dr: true, amount: -9400 }, { ledger: 'Bank Charges', dr: true, amount: -50 }, { ledger: s.customer.name, dr: false, amount: 9450 },
    ]));
    // TDS on 30,000 net of GST at 1% = 300.
    expect(vs.find((v) => v.type === 'Payment').lines).toEqual(expect.arrayContaining([
      { ledger: s.supplier.name, dr: true, amount: -31500 }, { ledger: 'Kotak Bank CA', dr: false, amount: 31200 }, { ledger: 'TDS Payable', dr: false, amount: 300 },
    ]));
    expect(vs.find((v) => v.type === 'Contra').lines).toEqual([{ ledger: 'Cash box', dr: true, amount: -5000 }, { ledger: 'Kotak Bank CA', dr: false, amount: 5000 }]);
    expect(vs.find((v) => v.type === 'Credit Note').number).toBe(cn.noteNo);

    // Stamped: nothing new to send, and the books are closed to the 31st.
    expect((await M.Invoice.findById(s.inv._id).lean()).tally.batch).toEqual(expect.any(mongoose.Types.ObjectId));
    expect((await post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31' })).status).toBe(409);
    expect((await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body).toMatchObject({ vouchers: 0, alreadySent: 7 });
    const settings = (await get('/accounts/settings')).body.settings;
    expect(new Date(settings.lockDate).getDate()).toBe(31);
    expect((await post('/accounts/contras', { from: s.bank._id, to: s.cash._id, amount: 1, date: '2026-07-20' })).status).toBe(409);
    expect((await get('/accounts/tally/batches')).body.batches).toEqual([expect.objectContaining({ batchNo: 1, vouchers: 7 })]);
  });

  it('uses the names set in settings, and the account name when no Tally ledger is given', async () => {
    const s = await scene();
    await request(app).put('/api/v2/accounts/settings').set('Cookie', cookie()).send({ tally: { sales: 'Sales @5% Local', outputCgst: 'CGST Payable' } });
    const preview = await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31');
    expect(preview.body.sample[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: 'Sales @5% Local', credit: 10000 }), expect.objectContaining({ ledger: 'CGST Payable', credit: 250 })]));
    void s;
  });
});

const csv = (lines) => Buffer.from(['Txn Date,Narration,Ref No,Withdrawal,Deposit,Balance', ...lines].join('\n'));
const upload = (bank, file) => request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(bank._id)).field('useModel', 'false').attach('file', file, { filename: 'kotak.csv', contentType: 'text/csv' });

describe('bank reconciliation', () => {
  it('clears what the bank shows and explains the bank balance to the paisa', async () => {
    const s = await scene();
    const rct = (await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 10500, mode: 'bank', account: s.bank._id, date: '2026-07-06', reference: 'UTR1', allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 10500 }] })).body.payment;
    const chq = (await post('/accounts/payments', { kind: 'payment', partyType: 'other', partyName: 'Landlord', amount: 6300, mode: 'cheque', account: s.bank._id, date: '2026-07-07', reference: 'CHQ 77' })).body.payment;
    const file = csv([
      '06/07/2026,NEFT CR SUNRISE,UTR1,,10500,110500',
      '08/07/2026,SMS CHARGES,,50,,110450',
    ]);
    const up = await upload(s.bank, file);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ counts: { recorded: 1, matched: 0, unmatched: 1 }, closingBalance: 110450 });
    expect(new Date((await M.Payment.findById(rct._id).lean()).clearedOn).getDate()).toBe(6);

    const rec = await get(`/accounts/bank/reconciliation?account=${s.bank._id}&asOf=2026-07-31`);
    expect(rec.status).toBe(200);
    // Book: 100,000 + 10,500 − 6,300 = 104,200. The cheque has not been presented;
    // the bank kept 50 the books do not have.
    expect(rec.body).toMatchObject({ bookBalance: 104200, bankBalance: 110450, expectedBankBalance: 110450, difference: 0 });
    expect(rec.body.uncleared).toEqual([expect.objectContaining({ number: chq.voucherNo, direction: 'out', amount: 6300 })]);
    expect(rec.body.unmatched).toEqual([expect.objectContaining({ narration: 'SMS CHARGES', amount: 50, direction: 'out' })]);

    // Post the charges from the line: it is in the books and cleared.
    const line = up.body.rows[1];
    const posted = await post('/accounts/bank/statement/post', { account: s.bank._id, statement: up.body.statement, rows: [{ index: line.index, date: line.date, narration: line.narration, amount: 50, direction: 'out', partyType: 'other', partyName: 'Kotak bank charges' }] });
    expect(posted.body.posted).toBe(1);
    const rec2 = (await get(`/accounts/bank/reconciliation?account=${s.bank._id}&asOf=2026-07-31`)).body;
    expect(rec2).toMatchObject({ bookBalance: 104150, unmatched: [], difference: 0 });
    // The cheque is presented: ticked cleared by hand.
    expect((await post('/accounts/bank/clear', { voucherType: 'Payment', id: chq._id, account: s.bank._id, clearedOn: '2026-07-20' })).status).toBe(200);
    const rec3 = (await get(`/accounts/bank/reconciliation?account=${s.bank._id}&asOf=2026-07-31&bankBalance=104150`)).body;
    expect(rec3).toMatchObject({ uncleared: [], expectedBankBalance: 104150, difference: 0, bankBalanceFrom: 'entered' });
  });

  it('a line set aside stays set aside when the statement comes again, and a line can be linked to a contra', async () => {
    const s = await scene();
    const up = await upload(s.bank, csv(['10/07/2026,REVERSAL TEST,,1,,99999', '11/07/2026,CASH WDL SELF,,5000,,94999']));
    const [noise, wdl] = up.body.rows;
    expect((await post(`/accounts/bank/statements/${up.body.statement}/lines/${noise.index}/ignore`, { reason: 'Bank test debit, reversed' })).status).toBe(200);
    const contra = (await post('/accounts/contras', { from: s.bank._id, to: s.cash._id, amount: 5000, date: '2026-07-01' })).body.contra; // dated earlier than the bank's day
    expect((await post(`/accounts/bank/statements/${up.body.statement}/lines/${wdl.index}/link`, { voucherType: 'Contra', voucher: contra._id })).status).toBe(200);
    expect(new Date((await M.Contra.findById(contra._id).lean()).fromClearedOn).getDate()).toBe(11);
    const again = await upload(s.bank, csv(['10/07/2026,REVERSAL TEST,,1,,99999']));
    expect(again.body.rows[0]).toMatchObject({ status: 'ignored', note: 'Bank test debit, reversed' });
    const list = await get(`/accounts/bank/statements?account=${s.bank._id}`);
    expect(list.body.statements).toHaveLength(2);
    expect((await get(`/accounts/bank/statements/${up.body.statement}`)).body.statement.lines.map((l) => l.status)).toEqual(['ignored', 'recorded']);
  });
});

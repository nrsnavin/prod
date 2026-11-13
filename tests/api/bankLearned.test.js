'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK LINES THAT POST THEMSELVES (services/learnedPosting.js)
//
//  A remembered payer's line posted by a person exactly as suggested
//  counts one more; any change starts the count again. Five in a row,
//  and — only when the books allow it — the next statement's lines for
//  that payer post themselves: under the limit, a head or an exact
//  settlement only, through the same door a person posts by.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, bank, customer;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

const kotakCsv = (lines) => Buffer.from([
  'Kotak Mahindra Bank,,,,,,,',
  'Account No.,7612149219,,,,,,',
  ',,,,,,,',
  'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
  ...lines.map((l, i) => `${i + 1},${l}`),
].join('\n'));
const upload = (lines) => request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie())
  .field('account', String(bank._id)).field('useModel', 'false').attach('file', kotakCsv(lines), { filename: 'kotak.csv', contentType: 'text/csv' });
let day = 1;
/** A TNEB debit on a day of its own, for `amount`. */
const tneb = (amount) => { day += 1; const d = `${String(day).padStart(2, '0')}-08-2026`; return `${d},${d},TNEB ONLINE PAYMENT ${day},R${day},${amount.toFixed(2)},DR,100000.00,CR`; };
/** Post a stored line as its suggestion says, or with `change` laid over it. */
async function postAsSuggested(up, change = {}) {
  const row = up.body.rows[0];
  const s = row.suggestion;
  const res = await post('/accounts/bank/statement/post', { account: bank._id, statement: up.body.statement, rows: [{
    index: row.index, partyType: s.partyType, party: s.party, partyName: s.partyName, head: s.head, allocations: s.allocations, ...change,
  }] });
  expect(res.body.results[0]).toMatchObject({ ok: true });
  return res.body.results[0];
}
const alias = (text) => M.BankAlias.findOne({ text }).lean();

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'Payment', 'BankAccount', 'BankStatement', 'BankAlias', 'ExpenseCategory', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'learned@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await get('/accounts/bank-accounts');
  bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', accountNo: '7612149219', openingBalance: 100000 })).body.account;
  customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', gstin: '33AAEPS1001F1Z2', paymentTerms: '30', phoneNumber: '9200000000' });
  await M.BankAlias.create({ text: 'TNEB', direction: 'out', partyType: 'other', partyName: 'TNEB' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('counting what a person posts as suggested', () => {
  it('each line posted exactly as the payer suggested counts one; a change starts again', async () => {
    for (let i = 1; i <= 3; i++) await postAsSuggested(await upload([tneb(3000 + i)]));
    expect((await alias('TNEB')).acceptedUnchanged).toBe(3);
    const power = await M.ExpenseCategory.create({ name: 'Power & fuel' });
    await postAsSuggested(await upload([tneb(3100)]), { head: String(power._id) });
    expect((await alias('TNEB')).acceptedUnchanged).toBe(0);
    for (let i = 1; i <= 5; i++) await postAsSuggested(await upload([tneb(3200 + i)]));
    expect((await alias('TNEB')).acceptedUnchanged).toBe(5);
  });

  it('with the books not allowing it (as they start), a line that has earned it still waits for a person', async () => {
    const up = await upload([tneb(2900)]);
    expect(up.body.rows[0]).toMatchObject({ status: 'matched', suggestion: { partyName: 'TNEB', remembered: expect.any(String) } });
    expect((await get('/accounts/bank/learned')).body).toMatchObject({ enabled: false, after: 5, upTo: 50000, payers: [expect.objectContaining({ text: 'TNEB', acceptedUnchanged: 5, earned: true })] });
  });
});

describe('when the books allow it', () => {
  beforeAll(async () => {
    expect((await put('/accounts/settings', { bankLines: { postLearned: true } })).status).toBe(200);
  });

  it('the payer\'s next line posts itself, through the door a person posts by, and says so', async () => {
    const before = await M.Payment.countDocuments({});
    const up = await upload([tneb(2950)]);
    expect(up.body.rows[0]).toMatchObject({ status: 'posted', voucherNo: expect.stringMatching(/^PAY\//) });
    const stored = await M.BankStatement.findById(up.body.statement).lean();
    expect(stored.lines[0]).toMatchObject({ status: 'posted', note: 'Posted by itself: lines with "TNEB" were posted unchanged 5 times running' });
    const v = await M.Payment.findById(stored.lines[0].voucher).lean();
    expect(v).toMatchObject({ kind: 'payment', amount: 2950, partyType: 'other', partyName: 'TNEB', source: 'statement', requestId: `learned:${up.body.statement}:0` });
    expect(await M.Payment.countDocuments({})).toBe(before + 1);
    expect(await alias('TNEB')).toMatchObject({ autoPosted: 1, acceptedUnchanged: 5 });
  });

  it('never above the limit, and never in a closed period', async () => {
    await put('/accounts/settings', { bankLines: { learnedUpTo: 1000 } });
    expect((await upload([tneb(2990)])).body.rows[0].status).toBe('matched');
    await put('/accounts/settings', { bankLines: { learnedUpTo: 50000 } });
    await M.AccountsSettings.updateOne({}, { $set: { lockDate: new Date('2026-12-31') } });
    const up = await upload([tneb(2995)]);
    expect(up.body.rows[0].status).toBe('matched');
    expect((await M.BankStatement.findById(up.body.statement).lean()).lines[0].note).toMatch(/^Not posted by itself: /);
    await M.AccountsSettings.updateOne({}, { $set: { lockDate: null } });
  });

  it('a customer\'s line posts itself only when it settles their open invoices exactly', async () => {
    await M.BankAlias.create({ text: 'MURUGAN K', direction: 'in', partyType: 'customer', party: customer._id, partyName: customer.name, acceptedUnchanged: 9 });
    const inv = await M.Invoice.create({
      invoiceNumber: 'INV/2026-27/0101', financialYear: '2026-27', sequence: 101, invoiceDate: new Date('2026-08-01'), dueDate: new Date('2026-08-31'),
      order: new mongoose.Types.ObjectId(), orderNo: 101, customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [], totals: { taxable: 8000, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, grand: 8000 }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 8000 });
    // Part of it: "oldest first" is a guess a person may change. Left for them.
    const part = await upload(['20-08-2026,20-08-2026,NEFT-HDFC0001-MURUGAN K-PAYMENT,UTR5,5000.00,CR,105000.00,CR']);
    expect(part.body.rows[0]).toMatchObject({ status: 'matched', suggestion: { confidence: 0.65 } });
    // The invoice to the rupee: posted, against it.
    const whole = await upload(['21-08-2026,21-08-2026,NEFT-HDFC0001-MURUGAN K-PAYMENT,UTR6,8000.00,CR,113000.00,CR']);
    expect(whole.body.rows[0].status).toBe('posted');
    const v = await M.Payment.findOne({ voucherNo: whole.body.rows[0].voucherNo }).lean();
    expect(v).toMatchObject({ kind: 'receipt', amount: 8000, partyType: 'customer' });
    expect(v.allocations).toEqual([expect.objectContaining({ docNo: 'INV/2026-27/0101', amount: 8000 })]);
  });

  it('what the server posts itself does not count as a person accepting it', async () => {
    const n = (await alias('TNEB')).acceptedUnchanged;
    expect((await upload([tneb(2700)])).body.rows[0].status).toBe('posted');
    expect((await alias('TNEB')).acceptedUnchanged).toBe(n);
  });
});

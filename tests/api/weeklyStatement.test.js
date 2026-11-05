'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BANK STATEMENT DOWNLOADED EVERY WEEK AND UPLOADED
//
//    • the bank's file, whatever it really is: CSV, an Excel workbook,
//      an ".xls" that is a web page; an old binary .xls says what to do
//    • each upload says how it sits against the last: days nobody
//      downloaded, lines already brought in, and a balance that does not
//      carry over (lines missing between the two)
//    • a payer placed by hand is remembered, and next week's line from
//      them comes matched — for a person to confirm, never posted alone
//    • the inbox asks for the statement once a week has passed
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const ExcelJS  = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const del = (url) => request(app).delete(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'Payment', 'BankAccount', 'BankStatement', 'BankAlias']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'weekly@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
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
  const customer = await M.Customer.create({ name: `Sunrise Garments ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '30', phoneNumber: '9200000000' });
  const mk = async (no, grand) => {
    const inv = await M.Invoice.create({
      invoiceNumber: `INV/2026-27/${String(no).padStart(4, '0')}`, financialYear: '2026-27', sequence: no, invoiceDate: new Date('2026-07-02'), dueDate: new Date('2026-08-01'),
      order: new mongoose.Types.ObjectId(), orderNo: no, customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [], totals: { taxable: grand, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, grand }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
    return inv;
  };
  const inv1 = await mk(100 * n + 1, 10500);
  const inv2 = await mk(100 * n + 2, 8000);
  await get('/accounts/bank-accounts');
  const bank = (await post('/accounts/bank-accounts', { name: `Kotak ${n}`, kind: 'bank', accountNo: '7612149219', openingBalance: 100000 })).body.account;
  return { customer, inv1, inv2, bank };
}

// Kotak's columns: a Dr / Cr column beside a single amount, balance with its own side.
const kotakCsv = (lines) => Buffer.from([
  'Kotak Mahindra Bank,,,,,,,',
  'Account No.,7612149219,,,,,,',
  ',,,,,,,',
  'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
  ...lines,
].join('\n'));
const upload = (bank, buffer, filename = 'kotak.csv', contentType = 'text/csv') =>
  request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(bank._id)).field('useModel', 'false').attach('file', buffer, { filename, contentType });

describe('a weekly statement', () => {
  it('reads Kotak\'s CSV, and says how each week sits against the last', async () => {
    const s = await scene();
    const week1 = await upload(s.bank, kotakCsv([
      '1,01-07-2026,01-07-2026,OPENING CREDIT,,0.00,CR,100000.00,CR',
      '2,02-07-2026,02-07-2026,NEFT-SBIN0001234-RAVI KUMAR TEXTILE AGENCY,UTR111,500.00,CR,100500.00,CR',
      '3,03-07-2026,03-07-2026,SMS CHARGES,,50.00,DR,100450.00,CR',
    ]));
    expect(week1.status).toBe(200);
    expect(week1.body.rows.map((r) => [r.amount, r.direction])).toEqual([[500, 'in'], [50, 'out']]);
    expect(week1.body.continuity).toMatchObject({ previous: null, gapDays: 0, overlapLines: 0, openingBalance: 100000, balanceDiff: null });

    // Next week, from the 6th: the 4th and 5th were not downloaded, and the
    // balance does not carry over — ₹1,000 moved on a day nobody has.
    const week2 = await upload(s.bank, kotakCsv([
      '1,06-07-2026,06-07-2026,UPI/412345678901/sunrisepay@okaxis/Payment,UPI222,10500.00,CR,111950.00,CR',
    ]));
    expect(week2.body.continuity).toMatchObject({ gapDays: 2, overlapLines: 0, openingBalance: 101450, balanceDiff: 1000 });
    expect(week2.body.continuity.previous).toMatchObject({ closingBalance: 100450 });

    // The week after, downloaded from the 6th again: the overlap is counted, nothing is missing.
    const week3 = await upload(s.bank, kotakCsv([
      '1,06-07-2026,06-07-2026,UPI/412345678901/sunrisepay@okaxis/Payment,UPI222,10500.00,CR,111950.00,CR',
      '2,08-07-2026,08-07-2026,CASH WDL SELF,,1950.00,DR,110000.00,CR',
    ]));
    expect(week3.body.continuity).toMatchObject({ gapDays: 0, overlapLines: 1 });
    expect((await get(`/accounts/bank/statements?account=${s.bank._id}`)).body.statements[0]).toMatchObject({ openingBalance: 101450, closingBalance: 110000 });
  });

  it('reads an Excel workbook and an ".xls" that is a web page; an old binary .xls says what to do', async () => {
    const s = await scene();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Account Statement']);
    ws.addRow(['Sl. No.', 'Transaction Date', 'Description', 'Chq / Ref No.', 'Withdrawal (Dr.)', 'Deposit (Cr.)', 'Balance']);
    ws.addRow([1, '10-07-2026', 'NEFT CR SUNRISE', 'UTR1', '', '2,000.00', '102000.00']);
    const xlsx = await upload(s.bank, Buffer.from(await wb.xlsx.writeBuffer()), 'statement.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.status).toBe(200);
    expect(xlsx.body.rows).toEqual([expect.objectContaining({ amount: 2000, direction: 'in' })]);

    const html = Buffer.from(`<html><body><table>
      <tr><td>Kotak Mahindra Bank</td></tr>
      <tr><th>Sl. No.</th><th>Transaction Date</th><th>Description</th><th>Chq / Ref No.</th><th>Withdrawal (Dr.)</th><th>Deposit (Cr.)</th><th>Balance</th></tr>
      <tr><td>1</td><td>11-07-2026</td><td>IMPS-41231-SRI&nbsp;YARN &amp; CO</td><td>R9</td><td>750.00</td><td></td><td>101250.00</td></tr>
    </table></body></html>`);
    const asXls = await upload(s.bank, html, 'statement.xls', 'application/vnd.ms-excel');
    expect(asXls.status).toBe(200);
    expect(asXls.body.rows).toEqual([expect.objectContaining({ amount: 750, direction: 'out', narration: 'IMPS-41231-SRI YARN & CO' })]);

    const binary = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const old = await upload(s.bank, binary, 'statement.xls', 'application/vnd.ms-excel');
    expect(old.status).toBe(400);
    expect(old.body.message).toMatch(/old-style Excel file.*Download the statement as CSV/);
  });

  it('remembers a payer placed by hand, and matches them next week for a person to confirm', async () => {
    const s = await scene();
    // A customer paying from their proprietor's own account: the bank prints his name.
    const line = '06-07-2026,06-07-2026,NEFT-HDFC0001-MURUGAN K-PAYMENT,UTR5,8000.00,CR,108000.00,CR';
    const up = await upload(s.bank, kotakCsv([`1,${line}`]));
    // Nothing names the customer: only the amount points at the invoice.
    expect(up.body.rows[0].suggestion.reason).toMatch(/the only open document/);
    const row = up.body.rows[0];
    const posted = await post('/accounts/bank/statement/post', { account: s.bank._id, statement: up.body.statement, rows: [{
      index: row.index, date: row.date, narration: row.narration, ref: row.ref, amount: 8000, direction: 'in', partyType: 'customer', party: s.customer._id,
      allocations: [{ docType: 'Invoice', doc: s.inv2._id, amount: 8000 }], remember: { text: 'murugan k' },
    }] });
    expect(posted.body.results[0]).toMatchObject({ ok: true, remembered: true });
    const aliases = (await get('/accounts/bank/aliases')).body.aliases;
    expect(aliases).toEqual([expect.objectContaining({ text: 'MURUGAN K', direction: 'in', partyType: 'customer', partyName: s.customer.name })]);

    // Next week he pays the other invoice: matched to the customer, the invoice found by amount.
    const next = await upload(s.bank, kotakCsv(['1,13-07-2026,13-07-2026,NEFT-HDFC0001-MURUGAN K-PAYMENT,UTR6,10500.00,CR,118500.00,CR']));
    expect(next.body.rows[0]).toMatchObject({ status: 'matched', suggestion: { partyType: 'customer', partyName: s.customer.name, confidence: 0.9, allocations: [expect.objectContaining({ docNo: s.inv1.invoiceNumber, amount: 10500 })] } });
    expect(next.body.rows[0].suggestion.reason).toMatch(/remembered: lines with "MURUGAN K"/);

    // Text that is not in the line is not remembered; a wrong remember is forgotten.
    const other = await post('/accounts/bank/statement/post', { account: s.bank._id, rows: [{ date: '2026-07-14', narration: 'TNEB ONLINE PAYMENT', amount: 3000, direction: 'out', partyType: 'other', partyName: 'TNEB', remember: { text: 'SOMETHING ELSE' } }] });
    expect(other.body.results[0]).toMatchObject({ ok: true, remembered: false });
    const tneb = await post('/accounts/bank/statement/post', { account: s.bank._id, rows: [{ date: '2026-07-15', narration: 'TNEB ONLINE PAYMENT', amount: 3100, direction: 'out', partyType: 'other', partyName: 'TNEB', remember: { text: 'TNEB' } }] });
    expect(tneb.body.results[0].remembered).toBe(true);
    const after = await upload(s.bank, kotakCsv(['1,20-07-2026,20-07-2026,TNEB ONLINE PAYMENT AUG,R7,2900.00,DR,115600.00,CR']));
    expect(after.body.rows[0].suggestion).toMatchObject({ partyType: 'other', partyName: 'TNEB', allocations: [] });
    const id = (await get('/accounts/bank/aliases')).body.aliases.find((a) => a.text === 'TNEB')._id;
    expect((await del(`/accounts/bank/aliases/${id}`)).status).toBe(200);
    expect((await get('/accounts/bank/aliases')).body.aliases.map((a) => a.text)).toEqual(['MURUGAN K']);
  });

  it('the inbox asks for the statement once a week has passed', async () => {
    const s = await scene();
    // Something moved through the account, and no statement has come.
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 100, mode: 'bank', account: s.bank._id, date: new Date().toISOString().slice(0, 10) });
    let inbox = (await get('/accounts/inbox')).body;
    expect(inbox.statementsDue).toMatchObject({ count: 1, top: [expect.objectContaining({ accountName: s.bank.name, lastTo: null })] });
    const d = (k) => { const x = new Date(Date.now() - k * 86_400_000); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}`; };
    await upload(s.bank, kotakCsv([`1,${d(2)},${d(2)},SMS CHARGES,,10.00,DR,99990.00,CR`]));
    inbox = (await get('/accounts/inbox')).body;
    expect(inbox.statementsDue.count).toBe(0);
  });
});

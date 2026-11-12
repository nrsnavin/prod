'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE BANK LINE, ONE VOUCHER
//
//  What went wrong before (reproduced in the audit of 12 Nov 2026):
//
//    • one bank credit became three receipts: the same line posted from
//      two overlapping statements, and again under another request id —
//      the post route never read the stored line;
//    • a second bank charge of the same amount, on the next statement,
//      was marked "already in the books" against the first charge's
//      voucher and never booked;
//    • one receipt was linked to two bank credits, and a line already in
//      the books was linked again to another voucher;
//    • a supplier's bill number that happened to sit inside a bank
//      reference was a 95% match, and passed the test for automatic
//      posting.
//
//  Now a line has an identity, the voucher that answers it carries it
//  under a unique index, and every write to a line is conditional
//  (services/bankLines.js, services/statementPosting.js).
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, bank, sbi;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const DAY = 86_400_000;
const iso = (off = 0) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const dmy = (off = 0) => iso(off).split('-').reverse().join('/');
const csv = (rows) => Buffer.from(['Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt', ...rows].join('\n'));
const upload = (file, name = 'kotak.csv') => request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie())
  .field('account', String(bank._id)).field('useModel', 'false').attach('file', file, { filename: name, contentType: 'text/csv' });
const postLines = (statement, rows) => post('/accounts/bank/statement/post', { account: bank._id, statement, rows });
/** What the screen sends for a line: the line's own figures and its usual request id. */
const rowOf = (u, i, extra) => { const r = u.body.rows[i]; return { index: r.index, date: r.date, narration: r.narration, ref: r.ref, amount: r.amount, direction: r.direction, requestId: `${u.body.statement}:${r.index}:${r.amount}`, ...extra }; };
const lines = async (statement) => (await M.BankStatement.findById(statement).lean()).lines.map((l) => [l.status, l.voucherNo]);
let n = 0;

async function customerScene(grand = 10500) {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', phoneNumber: `92000000${String(n).padStart(2, '0')}`, gstin: `33AAEPS11${String(n).padStart(2, '0')}F1Z2`, paymentTerms: '30' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(900 + n).padStart(4, '0')}`, financialYear: '2026-27', sequence: 900 + n, invoiceDate: new Date('2026-06-01'), dueDate: new Date('2026-07-01'),
    order: new mongoose.Types.ObjectId(), orderNo: 900 + n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
  return { customer, inv };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const m of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Payment', 'Contra', 'BankAccount', 'BankStatement', 'ExpenseCategory']) M[m] = require(`../../models/${m}`);
  admin = await M.User.create({ name: 'Owner', email: 'lines@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
  await get('/accounts/bank-accounts');
  bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', bankName: 'Kotak Mahindra Bank', accountNo: '7612149219', openingBalance: 500000, isDefault: true })).body.account;
  sbi = (await post('/accounts/bank-accounts', { name: 'SBI CA', kind: 'bank', accountNo: '30211098765', openingBalance: 0 })).body.account;
  await get('/accounts/categories');
});

describe('a bank line is posted once', () => {
  it('the same line on two uploaded statements is one line: posted from the first, it is in the books on the second', async () => {
    const { customer } = await customerScene();
    const file = csv([`${dmy(-3)},UPI CR GAMMA TRADERS,UTR777,,2500`]);
    const u1 = await upload(file, 'a.csv');
    const u2 = await upload(file, 'a.csv');            // both uploaded before anything is placed
    expect([u1.body.rows[0].status, u2.body.rows[0].status]).toEqual(['unmatched', 'unmatched']);

    const p1 = await postLines(u1.body.statement, [rowOf(u1, 0, { partyType: 'customer', party: customer._id })]);
    expect(p1.body.results[0]).toMatchObject({ ok: true, replay: false });
    // From the second statement: the voucher the first made, and nothing new.
    const p2 = await postLines(u2.body.statement, [rowOf(u2, 0, { partyType: 'customer', party: customer._id })]);
    expect(p2.body.results[0]).toMatchObject({ ok: true, replay: true, voucherNo: p1.body.results[0].voucherNo });
    // The same line again, from another browser tab with another request id.
    const again = await postLines(u1.body.statement, [{ ...rowOf(u1, 0, { partyType: 'customer', party: customer._id }), requestId: 'another-browser-tab' }]);
    expect(again.body.results[0]).toMatchObject({ ok: true, replay: true, already: true, voucherNo: p1.body.results[0].voucherNo });

    expect(await M.Payment.countDocuments({ status: 'posted', amount: 2500 })).toBe(1);
    expect(await lines(u1.body.statement)).toEqual([['posted', p1.body.results[0].voucherNo]]);
    expect(await lines(u2.body.statement)).toEqual([['posted', p1.body.results[0].voucherNo]]);

    // A third upload of the same file: the line comes in already in the books.
    const u3 = await upload(file, 'a.csv');
    expect(u3.body.rows[0]).toMatchObject({ status: 'recorded', recorded: { voucherNo: p1.body.results[0].voucherNo } });
    expect(u3.body.counts).toEqual({ recorded: 1, matched: 0, unmatched: 0 });
  });

  it('two requests for the same line at the same moment make one voucher', async () => {
    const { customer } = await customerScene();
    const file = csv([`${dmy(-3)},UPI CR GAMMA TRADERS,UTR778,,2600`]);
    const u1 = await upload(file); const u2 = await upload(file);
    const [a, b] = await Promise.all([
      postLines(u1.body.statement, [rowOf(u1, 0, { partyType: 'customer', party: customer._id })]),
      postLines(u2.body.statement, [rowOf(u2, 0, { partyType: 'customer', party: customer._id })]),
    ]);
    expect([a.body.results[0].ok, b.body.results[0].ok]).toEqual([true, true]);
    expect(a.body.results[0].voucherNo).toBe(b.body.results[0].voucherNo);
    expect(await M.Payment.countDocuments({ amount: 2600 })).toBe(1);
  });

  it('what the bank shows is taken from the stored line, not from the request', async () => {
    const { customer } = await customerScene();
    const u = await upload(csv([`${dmy(-3)},UPI CR GAMMA TRADERS,UTR779,,2700`]));
    const res = await postLines(u.body.statement, [{ ...rowOf(u, 0, { partyType: 'customer', party: customer._id }), amount: 99999, direction: 'out', date: '2020-01-01', narration: 'SOMETHING ELSE' }]);
    expect(res.body.results[0].ok).toBe(true);
    const v = await M.Payment.findById(res.body.results[0]._id).lean();
    expect(v).toMatchObject({ kind: 'receipt', amount: 2700, narration: 'UPI CR GAMMA TRADERS', reference: 'UTR779', source: 'statement' });
    expect(new Date(v.date).toISOString().slice(0, 10)).toBe(iso(-3));
    // A line that is not on the statement is refused.
    const none = await postLines(u.body.statement, [{ index: 7, partyType: 'customer', party: customer._id }]);
    expect(none.body.results[0]).toMatchObject({ ok: false, error: 'That line is not on this statement' });
  });

  it('a transfer between our own accounts is one contra, whichever statement it is posted from', async () => {
    const file = csv([`${dmy(-2)},TRF TO SBI 30211098765,TRF55,20000,`]);
    const u1 = await upload(file); const u2 = await upload(file);
    const row = (u) => rowOf(u, 0, { contra: { account: sbi._id } });
    const p1 = await postLines(u1.body.statement, [row(u1)]);
    const p2 = await postLines(u2.body.statement, [row(u2)]);
    expect(p1.body.results[0]).toMatchObject({ ok: true, contra: true, replay: false });
    expect(p2.body.results[0]).toMatchObject({ ok: true, contra: true, replay: true, voucherNo: p1.body.results[0].voucherNo });
    expect(await M.Contra.countDocuments({})).toBe(1);
  });

  it('cancelling the voucher gives the line back, and posting it again makes a new voucher, not the cancelled one', async () => {
    const { customer } = await customerScene();
    const u = await upload(csv([`${dmy(-3)},UPI CR GAMMA TRADERS,UTR780,,2800`]));
    const p1 = await postLines(u.body.statement, [rowOf(u, 0, { partyType: 'customer', party: customer._id })]);
    const first = p1.body.results[0];
    expect((await post(`/accounts/payments/${first._id}/cancel`, { reason: 'Posted to the wrong customer' })).status).toBe(200);
    const st = await M.BankStatement.findById(u.body.statement).lean();
    expect(st.lines[0]).toMatchObject({ status: 'unmatched', voucher: null, voucherNo: '', note: `${first.voucherNo} was cancelled: to be placed again` });
    // The same request the screen sent before.
    const p2 = await postLines(u.body.statement, [rowOf(u, 0, { partyType: 'customer', party: customer._id })]);
    expect(p2.body.results[0]).toMatchObject({ ok: true, replay: false });
    expect(p2.body.results[0].voucherNo).not.toBe(first.voucherNo);
    expect(await M.Payment.countDocuments({ status: 'posted', amount: 2800 })).toBe(1);
    expect(await lines(u.body.statement)).toEqual([['posted', p2.body.results[0].voucherNo]]);
  });
});

describe('"already in the books" means this line, not one like it', () => {
  const chargeRow = (u, i, head) => rowOf(u, i, { partyType: 'other', partyName: 'Kotak Mahindra Bank', head: head._id });

  it('a second bank charge of the same amount, on the next statement, is to be placed and is booked', async () => {
    const head = await M.ExpenseCategory.findOne({}).lean();
    const s1 = await upload(csv([`${dmy(-10)},NEFT CHARGES INCL GST,,5.90,`]), 'week1.csv');
    await postLines(s1.body.statement, [chargeRow(s1, 0, head)]);
    const s2 = await upload(csv([`${dmy(-7)},IMPS CHARGES INCL GST,,5.90,`]), 'week2.csv');
    expect(s2.body.rows[0].status).not.toBe('recorded');
    expect((await postLines(s2.body.statement, [chargeRow(s2, 0, head)])).body.results[0]).toMatchObject({ ok: true, replay: false });
    expect(await M.Payment.countDocuments({ status: 'posted', amount: 5.9 })).toBe(2);
  });

  it('two lines with the same words and amount on one day are two lines', async () => {
    const head = await M.ExpenseCategory.findOne({}).lean();
    const file = csv([`${dmy(-4)},NEFT CHARGES INCL GST,,5.90,`, `${dmy(-4)},NEFT CHARGES INCL GST,,5.90,`]);
    const s1 = await upload(file, 'day.csv');
    const out = await postLines(s1.body.statement, [chargeRow(s1, 0, head), chargeRow(s1, 1, head)]);
    expect(out.body.results.map((r) => [r.ok, r.replay])).toEqual([[true, false], [true, false]]);
    expect(await M.Payment.countDocuments({ status: 'posted', amount: 5.9 })).toBe(2);
    // The same day uploaded again: both are in the books, each as its own voucher.
    const s2 = await upload(file, 'day-again.csv');
    expect(s2.body.rows.map((r) => r.status)).toEqual(['recorded', 'recorded']);
    expect(new Set(s2.body.rows.map((r) => r.recorded.voucherNo)).size).toBe(2);
  });

  it('an entry made by hand answers the line on its own day first, and one line only', async () => {
    const { customer } = await customerScene();
    // One receipt of 10,000 in the books (typed by hand, no reference) on the day of the second credit.
    const rc = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, date: iso(-3) });
    const s = await upload(csv([`${dmy(-6)},NEFT CR ALPHA,,,10000`, `${dmy(-3)},NEFT CR BETA,,,10000`]), 'two.csv');
    // The 3-days-earlier line does not take the entry that sits on the other line's day.
    expect(s.body.rows.map((r) => r.status)).toEqual(['unmatched', 'recorded']);
    expect(s.body.rows[1].recorded.voucherNo).toBe(rc.body.payment.voucherNo);
    // The next statement has another credit of the same amount two days later: the receipt is taken.
    const s2 = await upload(csv([`${dmy(-1)},NEFT CR GAMMA,,,10000`]), 'next.csv');
    expect(s2.body.rows[0].status).not.toBe('recorded');
  });

  it('an entry a few days from the bank\'s date still answers its line when nothing sits nearer', async () => {
    const { customer } = await customerScene();
    const rc = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 7300, mode: 'bank', account: bank._id, date: iso(-6) });
    const s = await upload(csv([`${dmy(-3)},NEFT CR ALPHA,UTR9,,7300`]));
    expect(s.body.rows[0]).toMatchObject({ status: 'recorded', recorded: { voucherNo: rc.body.payment.voucherNo } });
  });
});

describe('linking a line to an entry in the books', () => {
  it('one receipt answers one bank credit; a line in the books is not linked again; a wrong match can be undone', async () => {
    const { customer } = await customerScene();
    const rc = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, date: iso(-5) });
    const s = await upload(csv([`${dmy(-5)},NEFT CR ALPHA,,,10000`, `${dmy(-5)},NEFT CR BETA,,,10000`]), 'two.csv');
    expect(s.body.rows.map((r) => r.status)).toEqual(['recorded', 'unmatched']);
    const link = (index, voucher) => post(`/accounts/bank/statements/${s.body.statement}/lines/${index}/link`, { voucherType: 'Payment', voucher });

    // The second credit to the same receipt: refused.
    const twice = await link(1, rc.body.payment._id);
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/already answers another line on the bank statement/);
    // A line already in the books, to another voucher: refused.
    const other = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, date: iso(-5), reference: 'OTHER' });
    const relink = await link(0, other.body.payment._id);
    expect(relink.status).toBe(409);
    expect(relink.body.message).toMatch(new RegExp(`already in the books as ${rc.body.payment.voucherNo.replace(/\//g, '\\/')}`));
    // Setting it aside is refused as well.
    expect((await post(`/accounts/bank/statements/${s.body.statement}/lines/0/ignore`, { reason: 'Not ours at all' })).status).toBe(409);
    expect(await lines(s.body.statement)).toEqual([['recorded', rc.body.payment.voucherNo], ['unmatched', '']]);

    // The other receipt is free, and answers the second credit.
    expect((await link(1, other.body.payment._id)).status).toBe(200);
    expect(await lines(s.body.statement)).toEqual([['recorded', rc.body.payment.voucherNo], ['recorded', other.body.payment.voucherNo]]);
    expect((await M.Payment.findById(other.body.payment._id).lean()).clearedOn).toBeTruthy();

    // A wrong match undone: the line is to be placed again, the receipt free and no longer cleared.
    const un = await post(`/accounts/bank/statements/${s.body.statement}/lines/1/unlink`, {});
    expect(un.status).toBe(200);
    expect(await lines(s.body.statement)).toEqual([['recorded', rc.body.payment.voucherNo], ['unmatched', '']]);
    const freed = await M.Payment.findById(other.body.payment._id).lean();
    expect(freed.bankLine).toBeUndefined();
    expect(freed.clearedOn).toBeUndefined();
    expect((await link(1, other.body.payment._id)).status).toBe(200);
    // A voucher posted from a line is undone by cancelling it, not by unlinking.
    const u = await upload(csv([`${dmy(-2)},UPI CR GAMMA TRADERS,UTR781,,2900`]), 'p.csv');
    await postLines(u.body.statement, [rowOf(u, 0, { partyType: 'customer', party: customer._id })]);
    const refused = await post(`/accounts/bank/statements/${u.body.statement}/lines/0/unlink`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/cancel the voucher/);
  });

  it('a line set aside can still be placed; a line placed meanwhile is not set aside', async () => {
    const { customer } = await customerScene();
    const u = await upload(csv([`${dmy(-2)},UPI CR GAMMA TRADERS,UTR782,,3100`]));
    const ignore = () => post(`/accounts/bank/statements/${u.body.statement}/lines/0/ignore`, { reason: 'Looks like a test credit' });
    expect((await ignore()).status).toBe(200);
    expect((await lines(u.body.statement))[0][0]).toBe('ignored');
    const p = await postLines(u.body.statement, [rowOf(u, 0, { partyType: 'customer', party: customer._id })]);
    expect(p.body.results[0]).toMatchObject({ ok: true, replay: false });
    expect((await ignore()).status).toBe(409);
    expect((await lines(u.body.statement))[0][0]).toBe('posted');
  });
});

describe('a document named in the narration', () => {
  const supplierBill = async (no, name = 'Sri Yarn Traders') => {
    n += 1;
    const supplier = await M.Supplier.create({ name, gstin: `33AAAPS01${String(n).padStart(2, '0')}F1Z5`, address: 'Erode' });
    const bill = await post('/accounts/bills', { supplier: supplier._id, supplierBillNo: no, billDate: iso(-20), lines: [{ description: 'Nylon', quantity: 40, rate: 310, gstPercent: 5 }], tds: { applicable: false } });
    expect(bill.status).toBe(201);
    return { supplier, bill: bill.body.bill };       // 13,020
  };
  const autoPostable = (r) => !!(r.status === 'matched' && r.suggestion?.exact && r.suggestion.confidence >= 0.95);

  it('a short bill number inside a bank reference is not that bill', async () => {
    await supplierBill('4521');
    const s = await upload(csv([`${dmy(-1)},NEFT DR-KKBKN26314521998-ROYAL TRANSPORTS,KKBKN26314521998,5000,`]));
    const r = s.body.rows[0];
    expect(r.suggestion?.partyName).not.toBe('Sri Yarn Traders');
    expect(autoPostable(r)).toBe(false);
  });

  it('a short bill number standing alone counts only with the supplier\'s name beside it', async () => {
    await supplierBill('4521');
    // (Not the bill's own amount: one open document for exactly the amount is another rule's match.)
    const alone = await upload(csv([`${dmy(-1)},NEFT DR 4521 ROYAL TRANSPORTS,UTR1,5000,`]), 'alone.csv');
    expect(alone.body.rows[0].suggestion?.partyName).not.toBe('Sri Yarn Traders');
    const named = await upload(csv([`${dmy(-1)},NEFT DR SRI YARN TRADERS BILL 4521,UTR2,13020,`]), 'named.csv');
    expect(named.body.rows[0].suggestion).toMatchObject({ partyName: 'Sri Yarn Traders', confidence: 0.95, exact: true });
    expect(named.body.rows[0].suggestion.reason).toMatch(/their no\. 4521 \(PB\/\d{4}-\d{2}\/\d{4}\) named in the narration/);
  });

  it('our own number, or a long bill number, counts standing alone; sure only when the named documents add up', async () => {
    const { bill } = await supplierBill('SYT/2026/0457');
    const exact = await upload(csv([`${dmy(-1)},NEFT DR BILL SYT/2026/0457,UTR3,13020,`]), 'exact.csv');
    expect(exact.body.rows[0].suggestion).toMatchObject({ partyName: 'Sri Yarn Traders', confidence: 0.95, exact: true, allocations: [{ docType: 'SupplierBill', docNo: bill.billNo, amount: 13020 }] });
    expect(autoPostable(exact.body.rows[0])).toBe(true);
    // Part of the named bill: suggested, said so, and never posted by itself.
    const part = await upload(csv([`${dmy(-1)},NEFT DR ${bill.billNo} PART,UTR4,5000,`]), 'part.csv');
    expect(part.body.rows[0].suggestion).toMatchObject({ partyName: 'Sri Yarn Traders', confidence: 0.85, allocations: [{ docNo: bill.billNo, amount: 5000 }] });
    expect(part.body.rows[0].suggestion.exact).toBeUndefined();
    expect(part.body.rows[0].suggestion.reason).toMatch(/named in the narration, part paid/);
    expect(autoPostable(part.body.rows[0])).toBe(false);
    // The number inside a longer run of letters and digits is not the number.
    const inside = await upload(csv([`${dmy(-1)},NEFT DR XSYT/2026/04579,UTR5,13020,`]), 'inside.csv');
    expect(inside.body.rows[0].suggestion?.reason || '').not.toMatch(/named in the narration/);
  });
});

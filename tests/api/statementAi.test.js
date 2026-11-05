'use strict';
// ══════════════════════════════════════════════════════════════════
//  STATEMENT LINES PLACED BY THE MODEL, AND CHECKED
//
//    • a customer paying two invoices written short ("PYMT 701 702"):
//      the invoices it names, the amount exact
//    • the electricity board: an expense under its head; bank interest:
//      income to Interest Received — in the books and in Tally
//    • cash drawn: a transfer to the cash box, by rule; money moved to
//      another of our banks: a transfer the model names — posted as
//      contras, cleared on the line's day
//    • a name not on file, or a supplier paying us, is thrown away
//    • a statement is matched again once the party is on file, and the
//      model is shown how people placed lines before
//
//  The model is stubbed: it answers by narration, as a model would.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const answers = new Map();
const prompts = [];
const mockCreate = jest.fn(async ({ messages }) => {
  const prompt = messages[0].content;
  prompts.push(prompt);
  const lines = JSON.parse(prompt.slice(prompt.indexOf('Lines: ') + 7));
  const rows = lines.map((l) => ({ index: l.index, ...(answers.get(l.narration) || { kind: 'unknown', confidence: 0 }) }));
  return { content: [{ type: 'text', text: `Here you are: ${JSON.stringify({ rows })}` }], usage: { input_tokens: 10, output_tokens: 10 } };
});
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }), TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'Payment', 'Contra', 'BankAccount', 'BankStatement', 'ExpenseCategory', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'stai@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
  answers.clear(); prompts.length = 0; mockCreate.mockClear();
});

async function scene() {
  const customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', gstin: '33AAEPS1001F1Z2', paymentTerms: '30', phoneNumber: '9200000000' });
  const mk = async (no, grand) => {
    const inv = await M.Invoice.create({
      invoiceNumber: `INV/2026-27/${no}`, financialYear: '2026-27', sequence: Number(no), invoiceDate: new Date('2026-07-02'), dueDate: new Date('2026-08-01'),
      order: new mongoose.Types.ObjectId(), orderNo: Number(no), customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [], totals: { taxable: grand, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, grand }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
    return inv;
  };
  const a = await mk('0701', 10500);
  const b = await mk('0702', 8000);
  const c = await mk('0703', 4000);
  await get('/accounts/bank-accounts');
  await get('/accounts/categories');
  const kotak = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', accountNo: '7612149219', openingBalance: 100000 })).body.account;
  const sbi = (await post('/accounts/bank-accounts', { name: 'SBI CA', kind: 'bank', accountNo: '31234567890' })).body.account;
  const cash = await M.BankAccount.findOne({ kind: 'cash' }).lean();
  const electricity = await M.ExpenseCategory.findOne({ name: 'Electricity' }).lean();
  return { customer, a, b, c, kotak, sbi, cash, electricity };
}

const csv = (lines) => Buffer.from(['Txn Date,Narration,Ref No,Withdrawal,Deposit,Balance', ...lines].join('\n'));
const upload = (bank, file) => request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(bank._id)).attach('file', file, { filename: 'kotak.csv', contentType: 'text/csv' });

describe('the model places what the rules could not, and every answer is checked', () => {
  it('names the invoices, an expense head, interest, transfers; throws away what is not on file', async () => {
    const s = await scene();
    answers.set('NEFT-HDFC0001-MURUGAN TEX-PYMT 701 702', { kind: 'customer', party: 'Sunrise Garments', docs: ['INV/2026-27/0701', 'INV/2026-27/0702'], confidence: 0.92, why: 'invoice numbers written short' });
    answers.set('BBPS TNEB 0412 SC NO 0412', { kind: 'expense', head: 'Electricity', payee: 'TNEB', confidence: 0.9, why: 'electricity board' });
    answers.set('INT.PD 01-07-26 TO 30-09-26', { kind: 'income', income: 'interest', payee: 'Kotak interest', confidence: 0.95 });
    answers.set('IB FUNDS TRANSFER TO OWN SBI', { kind: 'transfer', account: 'SBI CA', confidence: 0.9 });
    answers.set('UPI/GHOSTLTD/PAY', { kind: 'supplier', party: 'Ghost Ltd', confidence: 0.9 });
    answers.set('NEFT REFUND XYZ', { kind: 'supplier', party: 'Sunrise Garments', confidence: 0.9 });
    const up = await upload(s.kotak, csv([
      '10/07/2026,NEFT-HDFC0001-MURUGAN TEX-PYMT 701 702,UTR1,,18500,118500',
      '11/07/2026,BBPS TNEB 0412 SC NO 0412,R2,3000,,115500',
      '12/07/2026,INT.PD 01-07-26 TO 30-09-26,,,412,115912',
      '13/07/2026,CASH WDL SELF CHQ 000123,000123,50000,,65912',
      '14/07/2026,IB FUNDS TRANSFER TO OWN SBI,R5,20000,,45912',
      '15/07/2026,UPI/GHOSTLTD/PAY,R6,999,,44913',
      '16/07/2026,NEFT REFUND XYZ,R7,,500,45413',
    ]));
    expect(up.status).toBe(200);
    const [inv2, eb, interest, cashWdl, toSbi, ghost, refund] = up.body.rows;
    expect(inv2.suggestion).toMatchObject({ partyType: 'customer', partyName: 'Sunrise Garments', confidence: 0.85, byModel: true, allocations: [expect.objectContaining({ docNo: 'INV/2026-27/0701', amount: 10500 }), expect.objectContaining({ docNo: 'INV/2026-27/0702', amount: 8000 })] });
    expect(inv2.suggestion.reason).toMatch(/^AI: names INV\/2026-27\/0701 \+ INV\/2026-27\/0702, amount exact — invoice numbers written short/);
    expect(eb.suggestion).toMatchObject({ partyType: 'other', partyName: 'TNEB', headName: 'Electricity', head: String(s.electricity._id), confidence: 0.8 });
    expect(interest.suggestion).toMatchObject({ partyType: 'other', incomeLedger: 'interest', partyName: 'Kotak interest' });
    // Cash drawn is a rule, before the model is asked.
    expect(cashWdl.suggestion).toMatchObject({ kind: 'contra', accountName: 'Cash box', confidence: 0.8 });
    expect(cashWdl.suggestion.byModel).toBeUndefined();
    expect(toSbi.suggestion).toMatchObject({ kind: 'contra', account: String(s.sbi._id), accountName: 'SBI CA', byModel: true });
    // Not on file, and a "supplier" paying us: thrown away.
    expect(ghost).toMatchObject({ status: 'unmatched', suggestion: null });
    expect(refund).toMatchObject({ status: 'unmatched', suggestion: null });
    // The model saw only what the rules could not place, and our other accounts and the heads.
    const prompt = prompts[0];
    expect(prompt).not.toContain('CASH WDL SELF');
    expect(prompt).toContain('"SBI CA"');
    expect(prompt).toContain('Electricity');
    expect(prompt).toContain('INV/2026-27/0701 | Sunrise Garments | 10500');
    expect(await M.AiSuggestion.countDocuments({ surface: 'bank-statement-match' })).toBe(1);

    // Posted as suggested: the receipt settles both invoices; the head, the
    // interest and the transfers go where they belong, in the books and in Tally.
    const rows = [inv2, eb, interest, cashWdl, toSbi].map((r) => ({
      index: r.index, date: r.date, narration: r.narration, ref: r.ref, amount: r.amount, direction: r.direction,
      partyType: r.suggestion.partyType, party: r.suggestion.party, partyName: r.suggestion.partyName,
      allocations: (r.suggestion.allocations || []).map((x) => ({ docType: x.docType, doc: x.doc, amount: x.amount })),
      head: r.suggestion.head, incomeLedger: r.suggestion.incomeLedger, ...(r.suggestion.kind === 'contra' ? { contra: { account: r.suggestion.account } } : {}),
      requestId: `st:${r.index}`, ...(r === eb ? { remember: { text: 'TNEB' } } : {}),
    }));
    const posted = await post('/accounts/bank/statement/post', { account: s.kotak._id, statement: up.body.statement, rows });
    expect(posted.body.results.map((x) => x.ok)).toEqual([true, true, true, true, true]);
    expect((await M.Invoice.findById(s.a._id).lean()).paidAmount).toBe(10500);
    expect((await M.Invoice.findById(s.b._id).lean()).paidAmount).toBe(8000);
    const ebPay = await M.Payment.findOne({ partyName: 'TNEB' }).lean();
    expect(ebPay).toMatchObject({ kind: 'payment', partyType: 'other', headName: 'Electricity', amount: 3000 });
    expect(await M.Payment.findOne({ incomeLedger: 'interest' }).lean()).toMatchObject({ kind: 'receipt', amount: 412 });
    const contras = await M.Contra.find({}).sort({ amount: -1 }).lean();
    expect(contras.map((c) => [c.fromName, c.toName, c.amount, c.mode])).toEqual([['Kotak CA', 'Cash box', 50000, 'cash'], ['Kotak CA', 'SBI CA', 20000, 'bank']]);
    expect(contras[0].fromClearedOn).toBeTruthy();
    const st = (await get(`/accounts/bank/statements/${up.body.statement}`)).body.statement;
    expect(st.lines.slice(0, 5).map((l) => [l.status, l.voucherType])).toEqual([['posted', 'Payment'], ['posted', 'Payment'], ['posted', 'Payment'], ['posted', 'Contra'], ['posted', 'Contra']]);
    // Replaying the same post makes nothing twice.
    await post('/accounts/bank/statement/post', { account: s.kotak._id, rows: rows.slice(3) });
    expect(await M.Contra.countDocuments()).toBe(2);

    const preview = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body.sample;
    const lines = (no) => preview.find((v) => v.number === no)?.lines;
    expect(lines(ebPay.voucherNo)).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: s.electricity.ledger || 'Sundry Expenses', debit: 3000 })]));
    expect(lines((await M.Payment.findOne({ incomeLedger: 'interest' }).lean()).voucherNo)).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: 'Interest Received', credit: 412 })]));

    // Next statement: TNEB is remembered with its head, no model needed for it.
    mockCreate.mockClear();
    const next = await upload(s.kotak, csv(['12/08/2026,BBPS TNEB 0512 SC NO 0412,R9,3100,,40000']));
    expect(next.body.rows[0].suggestion).toMatchObject({ partyType: 'other', partyName: 'TNEB', headName: 'Electricity', confidence: 0.8 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('matches a stored statement again once the party is on file, shown how lines were placed before', async () => {
    const s = await scene();
    answers.set('UPI/GHOSTLTD/PAY', { kind: 'supplier', party: 'Ghost Ltd', confidence: 0.9, why: 'name in the UPI id' });
    const up = await upload(s.kotak, csv(['15/07/2026,UPI/GHOSTLTD/PAY,R6,999,,99001', '16/07/2026,NEFT-HDFC0001-MURUGAN TEX-PYMT 703,UTR8,,4000,103001']));
    expect(up.body.rows[0].status).toBe('unmatched');
    // Post the second line by hand, so the next prompt carries it as an example.
    const second = up.body.rows[1];
    await post('/accounts/bank/statement/post', { account: s.kotak._id, statement: up.body.statement, rows: [{ index: second.index, date: second.date, narration: second.narration, ref: second.ref, amount: 4000, direction: 'in', partyType: 'customer', party: s.customer._id, allocations: [{ docType: 'Invoice', doc: s.c._id, amount: 4000 }] }] });
    await M.Supplier.create({ name: 'Ghost Ltd', gstin: '33AAAPG1234F1Z5' });
    prompts.length = 0;
    const again = await post(`/accounts/bank/statements/${up.body.statement}/rematch`, {});
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(1);
    expect(again.body.statement.lines[0]).toMatchObject({ status: 'matched', suggestion: expect.objectContaining({ partyType: 'supplier', partyName: 'Ghost Ltd', byModel: true, confidence: 0.55 }) });
    expect(again.body.statement.lines[1]).toMatchObject({ status: 'posted' });
    expect(prompts[0]).toContain('NEFT-HDFC0001-MURUGAN TEX-PYMT 703 → Sunrise Garments (customer)');
    expect((await post('/accounts/bank/statements/nope/rematch', {})).status).toBe(404);
  });
});

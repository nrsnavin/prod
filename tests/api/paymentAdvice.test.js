'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S PAYMENT ADVICE — POST /accounts/advice/read
//
//    • read (the model, stubbed) and placed on the books: the customer,
//      each invoice it names — written short or in full — settled gross,
//      TDS and discount as the receipt's adjustments, the bank line
//    • the receipt it fills posts as it stands, and scores the reading
//    • what is unsure is listed: an unknown payer, an invoice not open,
//      more than is outstanding, a deduction that is not TDS or discount
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const reply = (o) => mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 1, output_tokens: 1 } });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'Payment', 'BankAccount', 'BankStatement', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'pa@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await post('/settings/document', {});
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  mockCreate.mockReset();
});

let n = 0;
async function scene() {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise Garments ${n}`, contactName: 'R', phoneNumber: `93000000${String(n).padStart(2, '0')}`, gstin: `33AAEPS${String(2000 + n)}F1Z2`, paymentTerms: '30' });
  const invoice = async (seq, grand) => {
    const inv = await M.Invoice.create({
      invoiceNumber: `INV/2026-27/${String(seq).padStart(4, '0')}`, financialYear: '2026-27', sequence: seq, invoiceDate: new Date('2026-09-20'), dueDate: new Date('2026-10-20'),
      order: new mongoose.Types.ObjectId(), orderNo: seq, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: grand / 1050, taxable: r2(grand / 1.05), gstPercent: 5, cgst: 0, sgst: 0, igst: 0, amount: grand }],
      totals: { taxable: r2(grand / 1.05), cgst: 0, sgst: 0, igst: 0, tax: r2(grand - grand / 1.05), roundOff: 0, grand }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
    return inv;
  };
  const inv701 = await invoice(701 + n * 10, 52500);
  const inv702 = await invoice(702 + n * 10, 21000);
  const bank = await M.BankAccount.create({ name: `Kotak ${n}`, kind: 'bank', accountNo: `76121${n}`, openingBalance: 0 });
  return { customer, inv701, inv702, bank };
}
function r2(x) { return Math.round(x * 100) / 100; }

describe('a payment advice', () => {
  it('is placed on the books: the invoices it names, gross, with TDS and discount as adjustments, and the bank line', async () => {
    const s = await scene();
    const short = String(s.inv701.sequence);
    // The bank line the money came in on, waiting to be placed.
    await M.BankStatement.create({ account: s.bank._id, accountName: s.bank.name, lines: [{ index: 0, date: new Date(), narration: `NEFT HDFC000123456 ${s.customer.name}`, ref: '', amount: 72345, direction: 'in', key: 'k1' }] });
    reply({
      problem: null, payerName: s.customer.name, payerGstin: s.customer.gstin, amount: 72345, date: '2026-10-28', reference: 'UTR HDFC000123456',
      lines: [
        { invoiceNo: short, invoiceAmount: 52500, paid: 51450, tds: 500, discount: 550, other: 0 },
        { invoiceNo: s.inv702.invoiceNumber, invoiceAmount: 21000, paid: 20895, tds: 105, discount: 0, other: 0 },
      ],
      tdsTotal: 605, discountTotal: 550, confidence: 0.9,
    });
    const res = await post('/accounts/advice/read', { text: 'Dear sir, we have paid …' });
    expect(res.status).toBe(200);
    const p = res.body.placed;
    expect(p.customer).toMatchObject({ _id: String(s.customer._id), matchedBy: 'gstin' });
    expect(p.allocations).toEqual([
      expect.objectContaining({ docType: 'Invoice', doc: String(s.inv701._id), docNo: s.inv701.invoiceNumber, amount: 52500 }),
      expect.objectContaining({ docType: 'Invoice', doc: String(s.inv702._id), amount: 21000 }),
    ]);
    expect(p.adjustments).toEqual([{ kind: 'tds_by_customer', amount: 605 }, { kind: 'discount', amount: 550 }]);
    expect(p.difference).toBe(0);
    expect(p.notes).toEqual([`"${short}" taken as ${s.inv701.invoiceNumber}`]);
    expect(p.statementLine).toMatchObject({ key: 'k1', byReference: true, accountName: s.bank.name });
    expect(mockCreate.mock.calls[0][0].model).toBe('test-text');

    // The receipt it fills posts as it stands, settling both, and scores the reading.
    const v = await post('/accounts/payments', {
      kind: 'receipt', partyType: 'customer', customer: String(s.customer._id), amount: p.amount, date: p.date, mode: 'bank', account: String(s.bank._id), reference: p.reference,
      allocations: p.allocations.map((a) => ({ docType: a.docType, doc: a.doc, amount: a.amount })), adjustments: p.adjustments, adviceSuggestion: res.body.aiSuggestion,
    });
    expect(v.status).toBe(201);
    expect(v.body.payment.unallocated).toBe(0);
    const settled = await M.Invoice.findById(s.inv701._id).lean();
    expect(settled.paidAmount).toBe(52500);
    await new Promise((r) => setTimeout(r, 50));
    expect((await M.AiSuggestion.findById(res.body.aiSuggestion).lean()).outcome).toBe('accepted');
  });

  it('lists what is unsure instead of guessing', async () => {
    const s = await scene();
    reply({
      problem: null, payerName: 'Sunrise Garments', payerGstin: '', amount: 60000, date: '2026-10-28', reference: '',
      lines: [
        { invoiceNo: s.inv701.invoiceNumber, invoiceAmount: 52500, paid: 60000, tds: 0, discount: 0, other: 0 },
        { invoiceNo: '9999', paid: 100 },
        { invoiceNo: s.inv702.invoiceNumber, invoiceAmount: 21000, paid: null, other: 1000 },
      ],
    });
    const p = (await post('/accounts/advice/read', { text: 'x', customer: String(s.customer._id) })).body.placed;
    expect(p.customer.matchedBy).toBe('chosen');
    expect(p.allocations[0]).toMatchObject({ amount: 52500 });
    expect(p.allocations[1]).toMatchObject({ amount: 20000 });
    expect(p.unmatched).toEqual([expect.objectContaining({ invoiceNo: '9999', why: 'not an open invoice of this customer' })]);
    expect(p.notes.join(' | ')).toMatch(/settles ₹60000\.00, but only ₹52500\.00 is outstanding/);
    expect(p.notes.join(' | ')).toMatch(/₹1000\.00 of other deductions/);
  });

  it('says when the payer is not on file, and when it is not an advice', async () => {
    reply({ problem: null, payerName: 'Nobody Knits', amount: 500, lines: [{ invoiceNo: '1', paid: 500 }] });
    const p = (await post('/accounts/advice/read', { text: 'x' })).body.placed;
    expect(p.customer).toBeNull();
    expect(p.notes[0]).toMatch(/not a customer on file/);
    reply({ problem: 'not_an_advice', lines: [] });
    expect((await post('/accounts/advice/read', { text: 'a menu' })).body).toMatchObject({ placed: null, read: { problem: 'not_an_advice' } });
    expect((await post('/accounts/advice/read', {})).status).toBe(400);
  });
});

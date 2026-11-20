'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CREDIT NOTE'S ROUND-OFF, TO TALLY
//    services/tallyExport.js
//
//  A credit note of ₹50 at 5% comes to ₹52.50 and is rounded to ₹53:
//  fifty paise of round-off. The voucher put that round-off on the wrong
//  side, which left it out by twice the round-off; the balancer then
//  quietly put it right — as long as twice the round-off was under a
//  rupee. At exactly fifty paise it was a rupee: "CN/… does not balance",
//  and the export refuses the WHOLE period while one voucher does not
//  balance. One such note and nothing went to Tally.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'AccountNote']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'tro@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
async function invoiced() {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '30', phoneNumber: '9200000000' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-07-02'), dueDate: new Date('2026-08-01'),
    order: new mongoose.Types.ObjectId(), orderNo: 40 + n, customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand: 10500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500 });
  return { customer, inv };
}
const note = (inv, rate) => post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Price difference', date: '2026-07-05', lines: [{ description: 'Rate', quantity: 1, rate, gstPercent: 5 }] });
/** The lines of the built Credit Note voucher: ledger → signed amount (debit positive). */
async function creditNoteLines() {
  const tally = require('../../services/tallyExport');
  const { L } = { L: (await require('../../services/booksLock').getSettings()).tally };
  const built = await tally.build({ from: new Date('2026-07-01'), to: new Date('2026-07-31T23:59:59Z'), fresh: true, L });
  const v = built.vouchers.find((x) => x.type === 'Credit Note');
  return { problems: built.problems, lines: Object.fromEntries(v.lines.map((l) => [l.ledger, l.amount])), sum: Math.round(v.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100, L };
}

describe('a credit note rounded by fifty paise', () => {
  it('goes to Tally balanced, its round-off on the side it is on', async () => {
    const { customer, inv } = await invoiced();
    const made = await note(inv, 50);
    expect(made.status).toBe(201);
    expect(made.body.note.totals).toMatchObject({ taxable: 50, tax: 2.5, roundOff: 0.5, grand: 53 });

    const { problems, lines, sum, L } = await creditNoteLines();
    expect(problems).toEqual([]);
    expect(sum).toBe(0);
    expect(lines).toEqual({ [customer.name]: -53, [L.sales]: 50, [L.outputCgst]: 1.25, [L.outputSgst]: 1.25, [L.roundOff]: 0.5 });

    // And the export itself is not held up by it.
    const preview = await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31');
    expect(preview.body.problems).toEqual([]);
    expect((await post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31' })).status).toBe(201);
  });

  it('one rounded down, and one with nothing to round, as they were', async () => {
    const a = await invoiced();
    expect((await note(a.inv, 1006)).body.note.totals).toMatchObject({ taxable: 1006, tax: 50.3, roundOff: -0.3, grand: 1056 });
    let got = await creditNoteLines();
    expect(got.problems).toEqual([]);
    expect(got.lines).toEqual({ [a.customer.name]: -1056, [got.L.sales]: 1006, [got.L.outputCgst]: 25.15, [got.L.outputSgst]: 25.15, [got.L.roundOff]: -0.3 });
    await M.AccountNote.deleteMany({});
    expect((await note(a.inv, 1000)).body.note.totals).toMatchObject({ roundOff: 0, grand: 1050 });
    got = await creditNoteLines();
    expect(got.lines).toEqual({ [a.customer.name]: -1050, [got.L.sales]: 1000, [got.L.outputCgst]: 25, [got.L.outputSgst]: 25 });
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAPERS READ INTO DRAFTS — phase 3
//
//    a customer's debit note → our credit note against the invoice it names
//    a TDS challan, a Form 16A, Form 26AS → the TDS registers
//    a supplier's price list → the rates expected of them; a bill above flagged
//    the electricity bill → power cost per metre
//
//  The model is a stand-in that answers each reader's prompt: these pin
//  what the server checks and builds from what it reads.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mockClient = null;
const replies = {};
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClient, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));
const bizDates = require('../../utils/bizDates');

let mongo, app, M, admin, sunrise, sriYarn, nylon, spandex, invoice;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const upload = (url, fields = {}) => {
  let r = request(app).post(`/api/v2${url}`).set('Cookie', cookie());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('files', PDF, { filename: 'paper.pdf', contentType: 'application/pdf' });
};
const iso = (d) => d.toISOString().slice(0, 10);
const settle = () => new Promise((ok) => setTimeout(ok, 60));

function answer({ messages }) {
  const prompt = messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const key = prompt.includes('debit note to the factory') ? 'debit' : prompt.includes('TDS challan receipt') ? 'challan' : prompt.includes('Form 16A') ? 'form16a'
    : prompt.includes('Form 26AS') ? 'as26' : prompt.includes('price list or quotation') ? 'price' : prompt.includes('electricity bill') ? 'power' : 'none';
  return Promise.resolve({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 120 }, content: [{ type: 'text', text: JSON.stringify(replies[key] || { problem: 'unreadable' }) }] });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'AccountNote', 'RawMaterial', 'SupplierRate', 'TdsChallan', 'TdsCertificate', 'Tds26asEntry', 'PowerBill', 'ShiftDetail', 'AiSuggestion', 'DocumentSettings', 'PurchaseOrder']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'papers3@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await M.DocumentSettings.findOneAndUpdate({ key: 'document' }, { $set: { companyName: 'Balu Elastics', gstin: '33AABFB1234C1Z5' } }, { upsert: true });
  require('../../services/documentSettings').invalidate();
  sunrise = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9840011111', gstin: '33AAEPS1001F1Z2', tan: 'CHES12345D' });
  sriYarn = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
  nylon = await M.RawMaterial.create({ name: 'Nylon 70D/24F SD', category: 'yarn', unit: 'kg' });
  spandex = await M.RawMaterial.create({ name: 'Spandex 840D', category: 'rubber', unit: 'kg' });
  const invDate = bizDates.today();
  invoice = await M.Invoice.create({
    invoiceNumber: 'INV/2026-27/0701', financialYear: '2026-27', sequence: 701, invoiceDate: invDate, dueDate: new Date(invDate.getTime() + 30 * 86_400_000),
    order: new mongoose.Types.ObjectId(), orderNo: 701, customer: sunrise._id, seller: { name: 'Balu Elastics', stateCode: '33' },
    buyer: { name: sunrise.name, gstin: sunrise.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm white', quantity: 100, rate: 500, gstPercent: 5, taxable: 50000, cgst: 1250, sgst: 1250, igst: 0, amount: 52500 }],
    totals: { taxable: 50000, cgst: 1250, sgst: 1250, igst: 0, tax: 2500, roundOff: 0, grand: 52500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: sunrise._id, date: invDate, docType: 'Invoice', doc: invoice._id, docNo: invoice.invoiceNumber, debit: 52500 });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { mockClient = { messages: { create: jest.fn(answer) } }; for (const k of Object.keys(replies)) delete replies[k]; });

describe('a customer\'s debit note, into our credit note', () => {
  beforeEach(() => {
    replies.debit = { problem: null, kind: 'debit_note', customerName: 'SUNRISE GARMENTS PVT LTD', customerGstin: '33AAEPS1001F1Z2', noteNo: 'DN/112', date: iso(bizDates.today()), invoices: ['701'], reason: '12 rolls short received', taxable: null, gst: null, total: 4200, lines: [] };
  });

  it('the customer by GSTIN, the invoice by its number, the amount before GST at the invoice\'s rate; issued, it scores the read', async () => {
    const res = await upload('/accounts/debit-notes/read');
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ name: 'Sunrise Garments', matchedBy: 'gstin' });
    expect(res.body.invoice).toMatchObject({ invoiceNumber: 'INV/2026-27/0701', gstPercent: 5, supplyType: 'intra' });
    expect(res.body.checks.map((c) => c.code)).toEqual(['SHORT_NO']);
    expect(res.body.draft).toMatchObject({
      kind: 'credit', against: { docType: 'Invoice', docNo: 'INV/2026-27/0701' }, partyNoteNo: 'DN/112', financial: false,
      reason: 'Their debit note DN/112: 12 rolls short received', lines: [{ quantity: 1, rate: 4000, gstPercent: 5 }], totals: { taxable: 4000, grand: 4200 },
    });
    const { totals, basis, ...body } = res.body.draft;
    const note = await post('/accounts/notes', { ...body, date: iso(bizDates.today()), debitNoteSuggestion: res.body.aiSuggestion });
    expect(note.status).toBe(201);
    expect(note.body.note).toMatchObject({ kind: 'credit', partyNoteNo: 'DN/112', totals: { taxable: 4000, grand: 4200 } });
    await settle();
    expect((await M.AiSuggestion.findById(res.body.aiSuggestion).lean()).outcome).toBe('accepted');
  });

  it('more than is still open to credit after the notes already issued is stopped; an invoice it names that is not theirs is said', async () => {
    replies.debit = { ...replies.debit, total: 50000, invoices: ['701', 'INV/2026-27/0999'] };
    const r = (await upload('/accounts/debit-notes/read')).body;
    expect(r.notesSoFar).toMatchObject({ credited: 4200, left: 48300 });
    expect(r.checks.find((c) => c.code === 'ROOM')).toMatchObject({ severity: 'danger', message: expect.stringContaining('more than the ₹48,300 still open to credit on INV/2026-27/0701') });
    expect(r.checks.find((c) => c.code === 'INVOICE')).toMatchObject({ message: '"INV/2026-27/0999" is not one of their invoices' });
  });

  it('not matched to anyone, or not a debit note: said plainly', async () => {
    replies.debit = { ...replies.debit, customerGstin: '', customerName: 'Unknown Mills' };
    const r = (await upload('/accounts/debit-notes/read')).body;
    expect(r.customer).toBeNull();
    expect(r.draft).toBeNull();
    expect(r.checks[0]).toMatchObject({ code: 'CUSTOMER', severity: 'danger' });
    replies.debit = { problem: 'not_a_debit_note' };
    expect((await upload('/accounts/debit-notes/read')).body).toMatchObject({ read: { problem: 'not_a_debit_note' }, draft: null });
  });
});

describe('TDS papers, into the registers', () => {
  it('a challan: the month it pays, what does not add up, and the same challan twice', async () => {
    replies.challan = { problem: null, tan: 'CHEB12345C', bsrCode: '0510308', challanNo: '12345', depositedOn: '2026-11-07', section: '194C', natureOfPayment: 'Contractors', minorHead: '200', assessmentYear: '2027-28', tax: 15000, surcharge: 0, cess: 0, interest: 120, fee: 200, penalty: 0, total: 15320, cin: 'C1' };
    const r = (await upload('/accounts/tds/read', { kind: 'challan' })).body;
    expect(r.draft).toMatchObject({ month: '2026-10', section: '194C', amount: 15000, interest: 120, bsrCode: '0510308', challanNo: '12345', depositedOn: '2026-11-07' });
    expect(r.draft.monthWhy).toMatch(/Paid by the 7th/);
    expect(r.checks.map((c) => c.code)).toEqual(['FEE']);
    const { monthWhy, ...body } = r.draft;
    const saved = await post('/accounts/tds/challans', { ...body, tdsSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    await settle();
    expect((await M.AiSuggestion.findById(r.aiSuggestion).lean()).outcome).toBe('accepted');
    const again = (await upload('/accounts/tds/read', { kind: 'challan' })).body;
    expect(again.duplicate).toMatchObject({ month: '2026-10', section: '194C', amount: 15000 });
  });

  it('a challan for the month whose deduction it pays off exactly', async () => {
    const tds = require('../../services/tds');
    const spy = jest.spyOn(tds, 'register').mockImplementation(async (month) => ({ month, rows: month === '2026-09' ? [{ section: '194J', deducted: 8000, deposited: 0, balance: 8000 }] : [] }));
    replies.challan = { problem: null, bsrCode: '0510308', challanNo: '22222', depositedOn: '2026-11-20', section: '194J', minorHead: '200', tax: 8000, total: 8000 };
    const r = (await upload('/accounts/tds/read', { kind: 'challan' })).body;
    spy.mockRestore();
    expect(r.draft).toMatchObject({ month: '2026-09', amount: 8000 });
    expect(r.draft.monthWhy).toMatch(/still to be deposited: this pays them exactly/);
  });

  it('a Form 16A: the customer by TAN, the year from the assessment year; one issued to another PAN is not ours', async () => {
    replies.form16a = { problem: null, deductorName: 'Sunrise Garments Pvt Ltd', deductorTan: 'CHES12345D', deducteeName: 'Balu Elastics', deducteePan: 'AABFB1234C', certificateNo: 'QWERTYU', assessmentYear: '2027-28', quarter: 'Q2', periodFrom: '2026-07-01', periodTo: '2026-09-30', rows: [{ section: '194Q', amountPaid: 500000, tds: 500 }], totalTds: 500 };
    const r = (await upload('/accounts/tds/read', { kind: 'form16a' })).body;
    expect(r.customer).toMatchObject({ name: 'Sunrise Garments', matchedBy: 'tan' });
    expect(r.checks).toEqual([]);
    expect(r.draft).toMatchObject({ kind: 'received', party: String(sunrise._id), fy: '2026-27', quarter: 'Q2', certNo: 'QWERTYU', section: '194Q', amount: 500 });
    const saved = await post('/accounts/tds/certificates', { ...r.draft, tdsSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    expect((await upload('/accounts/tds/read', { kind: 'form16a' })).body.duplicate).toMatchObject({ amount: 500 });
    replies.form16a = { ...replies.form16a, deducteePan: 'ZZZZZ9999Z' };
    expect((await upload('/accounts/tds/read', { kind: 'form16a' })).body.checks[0]).toMatchObject({ code: 'PAN', severity: 'danger' });
  });

  it('Form 26AS as a PDF: its lines placed on customers, the year from its assessment year', async () => {
    replies.as26 = { problem: null, pan: 'AABFB1234C', assessmentYear: '2027-28', rows: [
      { deductorName: 'SUNRISE GARMENTS PVT LTD', tan: 'CHES12345D', section: '194Q', date: '2026-07-15', amountPaid: 500000, tds: 500, status: 'F' },
      { deductorName: 'UNKNOWN MILLS', tan: 'CHEU99999Z', section: '194Q', date: '2026-08-02', amountPaid: 100000, tds: 100, status: 'F' },
    ] };
    const r = (await upload('/accounts/tds/read', { kind: '26as' })).body;
    expect(r.read).toMatchObject({ assessmentYear: '2027-28', lines: 2 });
    expect(r.stored).toMatchObject({ fy: '2026-27', lines: 2, matched: 1, unmatched: [expect.objectContaining({ deductorName: 'UNKNOWN MILLS', tds: 100 })] });
    expect(await M.Tds26asEntry.countDocuments({ fy: '2026-27' })).toBe(2);
    expect(r.receivable).toBeTruthy();
    expect((await upload('/accounts/tds/read', { kind: 'nonsense' })).status).toBe(400);
  });
});

describe('suppliers\' price lists', () => {
  it('read: the supplier by GSTIN, each line on a material; saved, it is the live rate, and a newer one takes its place', async () => {
    replies.price = { problem: null, kind: 'quotation', supplierName: 'Sri Yarn Traders', supplierGstin: '33AAAPS0001F1Z5', ref: 'Q/118', date: '2026-11-01', validUntil: '2026-11-30',
      lines: [{ description: 'Nylon 70D/24F SD', rate: 310, unit: 'kg', gstPercent: 5 }, { description: 'Spandex 840D', rate: 900, unit: 'kg', gstPercent: 5 }, { description: 'Something else entirely', rate: 5, unit: 'pcs' }] };
    const r = (await upload('/accounts/price-lists/read')).body;
    expect(r.supplier).toMatchObject({ name: 'Sri Yarn Traders', matchedBy: 'gstin' });
    expect(r.rows.map((x) => x.materialName)).toEqual(['Nylon 70D/24F SD', 'Spandex 840D', null]);
    const saved = await post('/accounts/price-lists', { supplier: r.supplier._id, source: 'quotation', ref: 'Q/118', quotedOn: '2026-11-01', validUntil: '2026-11-30', aiSuggestion: r.aiSuggestion, rows: r.rows.filter((x) => x.rawMaterial) });
    expect(saved.body).toMatchObject({ saved: 2, replaced: 0 });
    const again = await post('/accounts/price-lists', { supplier: r.supplier._id, source: 'price_list', ref: 'PL-Dec', rows: [{ rawMaterial: String(nylon._id), rate: 305, unit: 'kg' }] });
    expect(again.body).toMatchObject({ saved: 1, replaced: 1 });
    const live = (await get(`/accounts/price-lists?supplier=${sriYarn._id}`)).body.rates;
    expect(live.map((x) => [x.materialName, x.rate])).toEqual([['Nylon 70D/24F SD', 305], ['Spandex 840D', 900]]);
    // Read again: each line shows the rate live now, and how far it moved.
    const next = (await upload('/accounts/price-lists/read')).body;
    expect(next.rows[0]).toMatchObject({ current: { rate: 305 }, change: 1.64 });
  });

  it('a bill line above the live rate is flagged when the bill is checked; at or below it, nothing', async () => {
    const lines = [{ rawMaterial: String(nylon._id), description: 'Nylon 70D', quantity: 60, rate: 320, gstPercent: 5 }, { rawMaterial: String(spandex._id), description: 'Spandex', quantity: 10, rate: 900, gstPercent: 5 }];
    const flags = (await post('/accounts/bills/check', { supplier: sriYarn._id, billDate: iso(bizDates.today()), lines })).body.flags;
    const above = flags.filter((f) => f.code === 'ABOVE_QUOTE');
    expect(above).toHaveLength(1);
    expect(above[0].message).toBe('Nylon 70D at ₹320 is 4.92% above Sri Yarn Traders\'s price list PL-Dec of ₹305/kg');
    expect((await post('/accounts/price-lists/check', { supplier: sriYarn._id, lines: [{ rawMaterial: String(nylon._id), rate: 310 }] })).body.flags).toEqual([]);
  });

  it('the same routes sit under /supplier: a buyer with Purchase orders and not Accounts checks a PO line and sees the rates', async () => {
    const buyer = await M.User.create({ name: 'Buyer', email: 'buyer3@t.co', password: 'pass1234', role: 'admin', department: 'admin', features: ['/purchase-orders'] });
    const as = [`token=${jwt.sign({ id: buyer._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
    const lines = [{ rawMaterial: String(nylon._id), description: 'Nylon 70D', rate: 320 }];
    // Accounts writes are not theirs …
    expect((await request(app).post('/api/v2/accounts/price-lists/check').set('Cookie', as).send({ supplier: sriYarn._id, lines })).status).toBe(403);
    // … the supplier mount is.
    const res = await request(app).post('/api/v2/supplier/price-lists/check').set('Cookie', as).send({ supplier: sriYarn._id, lines });
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual([expect.objectContaining({ code: 'ABOVE_QUOTE', line: 0 })]);
    const rates = await request(app).get(`/api/v2/supplier/price-lists?supplier=${sriYarn._id}`).set('Cookie', as);
    expect(rates.body.rates.map((x) => x.rate)).toEqual([305, 900]);
  });
});

describe('power cost per metre', () => {
  it('the bill read and checked; kept once a month; set against the metres woven', async () => {
    replies.power = { problem: null, consumerNo: '059-001-234', billNo: 'B1', billDate: '2026-11-05', periodFrom: '2026-10-01', periodTo: '2026-10-31', units: 24850, demandKva: 180, energyCharges: 186375, demandCharges: 63000, otherCharges: 4200, tax: 12430, total: 266005, dueDate: '2026-11-20' };
    const r = (await upload('/accounts/power-bills/read')).body;
    expect(r.checks).toEqual([]);
    expect(r.draft).toMatchObject({ month: '2026-10', units: 24850, total: 266005, ratePerUnit: 10.7 });
    const saved = await post('/accounts/power-bills', { ...r.draft, aiSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    expect((await post('/accounts/power-bills', r.draft)).status).toBe(409);
    expect((await upload('/accounts/power-bills/read')).body.duplicate).toMatchObject({ total: 266005 });
    for (const [d, m] of [['2026-10-05', 30000], ['2026-10-20', 40000], ['2026-10-25', 5000]]) {
      await M.ShiftDetail.create({ date: new Date(`${d}T00:00:00Z`), shift: 'DAY', timer: '08:00:00', elastics: [], employee: new mongoose.Types.ObjectId(), shiftPlan: new mongoose.Types.ObjectId(), machine: new mongoose.Types.ObjectId(), status: 'closed', productionMeters: m });
    }
    const rep = (await get('/accounts/power-bills/report')).body.rows;
    expect(rep[0]).toMatchObject({ month: '2026-10', units: 24850, total: 266005, metres: 75000, costPerMetre: 3.55, unitsPerMetre: 0.331, ratePerUnit: 10.7, partial: false });
    // This month's bill, entered before the month is over: marked, and not set against last month.
    const now = bizDates.monthKey(bizDates.today());
    await post('/accounts/power-bills', { month: now, consumerNo: '059-001-234', units: 9000, total: 96000 });
    const after = (await get('/accounts/power-bills/report')).body.rows;
    expect(after[0]).toMatchObject({ month: now, partial: true, change: null });
  });

  it('parts that do not make the total, and a rate a unit no Tamil Nadu bill has, are said', async () => {
    replies.power = { problem: null, consumerNo: 'X', periodTo: '2026-09-30', units: 2000, energyCharges: 10000, demandCharges: 0, otherCharges: 0, tax: 0, total: 90000 };
    const r = (await upload('/accounts/power-bills/read')).body;
    expect(r.checks.map((c) => c.code)).toEqual(['PARTS', 'RATE']);
  });
});

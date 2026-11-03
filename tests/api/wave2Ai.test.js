'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAKING THE TYPING OUT — WITHOUT A MODEL, AND WITH ONE PRETENDING
//
//    • a claim receipt photo fills the claim, warns when the same
//      receipt was claimed before, and what is sent scores the read
//    • a customer's complaint message: category, the likely jobs (only
//      ever theirs), the elastic only when named; a reply drafted that
//      promises nothing the resolution does not; kept on the notes
//    • a worker's words about a machine: severity never below high for
//      smoke or a shock, the same fault already open is pointed at
//    • a lorry receipt onto the challan: checks that it fits, the
//      transporter on file, the fields saved with a trail
//    • a visiting card into a party form, and who is already on file
//
//  The readers and the model are mocked: these pin what is done with
//  their answers, and what happens when there is no model at all.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockReadBill = jest.fn();
const mockReadLr = jest.fn();
const mockReadCard = jest.fn();
const mockCreate = jest.fn();
let mockModel = false;
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockReadBill(...a) }));
jest.mock('../../utils/lrOcr', () => ({ readLr: (...a) => mockReadLr(...a) }));
jest.mock('../../utils/partyCardOcr', () => {
  const real = jest.requireActual('../../utils/partyCardOcr');
  return { ...real, readCard: (...a) => mockReadCard(...a) };
});
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockModel ? { messages: { create: (...a) => mockCreate(...a) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const upload = (url, fields = {}, field = 'file') => {
  let r = request(app).post(`/api/v2${url}`).set('Cookie', cookie());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach(field, Buffer.from('fake-image'), { filename: 'p.jpg', contentType: 'image/jpeg' });
};
const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 10 } });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Expense', 'ExpenseCategory', 'AiSuggestion', 'JobOrder', 'Elastic', 'Machine', 'MachineIssue', 'DeliveryChallan']) M[n] = require(`../../models/${n}.js`);
  M.Complaint = require('../../models/Complaints.js');
  admin = await M.User.create({ name: 'Owner', email: 'wave2@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  mockReadBill.mockReset(); mockReadLr.mockReset(); mockReadCard.mockReset(); mockCreate.mockReset(); mockModel = false;
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const settled = async (id) => (await M.AiSuggestion.findById(id).lean());

describe('a claim from its receipt', () => {
  it('reads the receipt into the claim, says when it was claimed before, and scores the read on sending', async () => {
    await get('/accounts/categories');
    const fuel = await M.ExpenseCategory.findOne({ name: /transport/i });
    mockReadBill.mockResolvedValue({ kind: 'receipt', problem: null, supplierName: 'Indian Oil', supplierGstin: '', billNo: 'IO/551', billDate: '2026-11-01', lines: [{ description: 'Diesel 10 L', quantity: 1, rate: 960, amount: 960 }], totals: { grand: 960 }, confidence: 0.9, model: 'v', usage: {}, latencyMs: 5 });
    const first = await upload('/claims/scan');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ problem: null, alreadyClaimed: null, draft: { amount: 960, date: '2026-11-01', description: 'Diesel 10 L — Indian Oil', refNo: 'IO/551' } });
    const sent = await post('/claims', { category: fuel._id, description: 'Diesel 10 L for the genset', amount: 960, date: '2026-11-01', refNo: 'IO/551', aiSuggestion: first.body.aiSuggestion });
    expect(sent.status).toBe(201);
    await new Promise((r) => setTimeout(r, 150));
    const row = await settled(first.body.aiSuggestion);
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(expect.arrayContaining(['description']));
    // The same receipt again.
    const again = await upload('/claims/scan');
    expect(again.body.alreadyClaimed).toBe(sent.body.claim.expenseNo);
    // Not a receipt.
    mockReadBill.mockResolvedValue({ kind: null, problem: 'not_a_bill', lines: [] });
    expect((await upload('/claims/scan')).body).toMatchObject({ problem: 'not_a_bill', draft: null });
  });
});

async function customerWithJobs() {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, phoneNumber: '9876543210' });
  const black = await M.Elastic.create({ name: `25mm Black ${n}`, weaveType: '8', spandexEnds: 40, pick: 12, noOfHook: 8, weight: 2.4 });
  const white = await M.Elastic.create({ name: `40mm White ${n}`, weaveType: '8', spandexEnds: 40, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = new mongoose.Types.ObjectId();
  const older = await M.JobOrder.create({ order, customer: customer._id, date: new Date(Date.now() - 40 * 86_400_000), status: 'completed', elastics: [{ elastic: black._id, quantity: 1000 }] });
  const newer = await M.JobOrder.create({ order, customer: customer._id, date: new Date(Date.now() - 5 * 86_400_000), status: 'completed', elastics: [{ elastic: white._id, quantity: 1000 }] });
  return { customer, black, white, older, newer };
}

describe('a complaint from what the customer sent', () => {
  it('with no model: category from the words, the job carrying the named elastic first', async () => {
    const s = await customerWithJobs();
    const r = await post('/complaint/intake', { customer: s.customer._id, text: `The ${s.black.name} has a shade band across the rolls` });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ category: 'shade', aiGenerated: false, elastic: { _id: String(s.black._id) } });
    expect(r.body.data.jobs[0]._id).toBe(String(s.older._id));
    const vague = await post('/complaint/intake', { customer: s.customer._id, text: 'elastic is too loose, no stretch' });
    expect(vague.body.data).toMatchObject({ category: 'strength', elastic: null });
    expect(vague.body.data.jobs[0]._id).toBe(String(s.newer._id));
  });

  it('with a model: only its jobs and elastics are taken, by number; what is filed scores it', async () => {
    const s = await customerWithJobs();
    mockModel = true;
    mockCreate.mockResolvedValue(reply({ category: 'width', reason: 'The 40mm white measures 38mm', jobs: [{ n: 0, why: 'only job with 40mm white' }, { n: 7, why: 'invented' }], elastic: 0, confidence: 0.8 }));
    const r = await post('/complaint/intake', { customer: s.customer._id, text: '40mm white is coming 38mm only sir' });
    expect(r.body.data).toMatchObject({ category: 'width', reason: 'The 40mm white measures 38mm', aiGenerated: true, elastic: { _id: String(s.white._id) } });
    expect(r.body.data.jobs.map((j) => j._id)).toEqual([String(s.newer._id)]);
    const filed = await post('/complaint', { customer: s.customer._id, job: s.newer._id, elastic: s.white._id, category: 'width', reason: 'The 40mm white measures 38mm', aiSuggestion: r.body.data.aiSuggestion });
    expect(filed.status).toBe(201);
    await new Promise((x) => setTimeout(x, 150));
    expect((await settled(r.body.data.aiSuggestion)).outcome).toBe('accepted');
    // Another customer's job is refused, as before.
    const t = await customerWithJobs();
    expect((await post('/complaint', { customer: s.customer._id, job: t.newer._id, category: 'width', reason: 'x' })).status).toBe(400);
  });

  it('drafts a reply from the resolution, and keeps what was sent on the notes', async () => {
    const s = await customerWithJobs();
    const c = await M.Complaint.create({ customer: s.customer._id, job: s.older._id, elastic: s.black._id, category: 'shade', reason: 'Shade band', status: 'Resolved', resolution: 'We will replace the two rolls with the next delivery.' });
    const d = await get(`/complaint/${c._id}/reply-draft`);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ aiGenerated: false, phone: '9876543210' });
    expect(d.body.data.text).toMatch(/replace the two rolls/);
    expect(d.body.data.text).toMatch(/Balu Elastics/);
    const kept = await post(`/complaint/${c._id}/reply`, { text: d.body.data.text });
    expect(kept.status).toBe(200);
    expect((await M.Complaint.findById(c._id).lean()).feedback).toMatch(/^Reply sent .*by Owner:\n/);
  });
});

describe('a machine issue from what the worker said', () => {
  it('never puts smoke below high, and points at the same fault already open', async () => {
    const m = await M.Machine.create({ ID: `LOOM-W2-${++n}`, manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12 });
    const smoke = await post('/machine-issue/intake', { machineId: m._id, text: 'Motor la irundhu smoke varudhu, smell adikkudhu' });
    expect(smoke.status).toBe(200);
    expect(smoke.body.data).toMatchObject({ severity: 'critical', aiGenerated: false, duplicateOf: null });
    const filed = await post('/machine-issue', { machineId: m._id, title: 'Head 3 rubber breaking', description: 'Head 3 rubber breaking every few minutes', severity: 'high' });
    expect(filed.status).toBe(201);
    const again = await post('/machine-issue/intake', { machineId: m._id, text: 'head 3 rubber breaking again' });
    expect(again.body.data.duplicateOf).toBe(String(filed.body.data._id));
    expect(again.body.data.openIssues).toHaveLength(1);
    // A model that says "low" for a shock is overruled.
    mockModel = true;
    mockCreate.mockResolvedValue(reply({ title: 'Panel gives a shock', description: 'Touching the panel gives a shock', severity: 'low', duplicateOf: null, confidence: 0.7 }));
    const shock = await post('/machine-issue/intake', { machineId: m._id, text: 'panel touch panna shock adikkudhu' });
    expect(shock.body.data).toMatchObject({ severity: 'critical', aiGenerated: true, title: 'Panel gives a shock' });
  });
});

describe('a lorry receipt onto the challan', () => {
  it('reads it, says what does not fit, finds the transporter, and saves the transport with a trail', async () => {
    n += 1;
    const dc = await M.DeliveryChallan.create({ dcNumber: `DC-W2-${n}`, type: 'elastic', financialYear: '2026-27', sequence: n, customerName: 'Sunrise Garments', status: 'dispatched', dispatchDate: new Date('2026-11-01'), items: [{ elasticName: 'x', quantity: 100 }] });
    const vrl = await M.Supplier.create({ name: `VRL Logistics ${n}`, gstRegistration: 'unregistered' });
    mockReadLr.mockResolvedValue({ problem: null, lrNumber: 'TPR/4471', lrDate: '2026-11-12', vehicleNo: 'TN38AB1234', transporterName: `VRL Logistics ${n}`, transporterGstin: '', consignee: 'Lakshmi Exports', destination: 'Erode', packages: 14, weightKg: 320, freight: 4200, paidBy: 'paid', confidence: 0.8, model: 'v', usage: {}, latencyMs: 5 });
    const r = await upload(`/dc/${dc._id}/lr/scan`, {}, 'files');
    expect(r.status).toBe(200);
    expect(r.body.transporter).toMatchObject({ _id: String(vrl._id), gstRegistration: 'unregistered' });
    expect(r.body.checks).toEqual(expect.arrayContaining([expect.stringMatching(/Lakshmi Exports.*Sunrise Garments/), expect.stringMatching(/11 days after/)]));
    const saved = await post(`/dc/${dc._id}/transport`, { lrNumber: 'TPR/4471', vehicleNo: 'tn38ab1234', transporter: vrl.name, aiSuggestion: r.body.aiSuggestion });
    expect(saved.status).toBe(200);
    const after = await M.DeliveryChallan.findById(dc._id).lean();
    expect(after).toMatchObject({ lrNumber: 'TPR/4471', vehicleNo: 'TN38AB1234', transporter: vrl.name });
    expect(after.fingerprints.at(-1).meta).toMatchObject({ change: 'transport' });
    await M.DeliveryChallan.updateOne({ _id: dc._id }, { status: 'cancelled' });
    expect((await post(`/dc/${dc._id}/transport`, { lrNumber: 'X' })).status).toBe(409);
  });
});

describe('a customer or supplier from a card', () => {
  it('fills the form, finds who is already on file, checks the GSTIN, and scores the read on saving', async () => {
    await M.Customer.create({ name: 'SUNRISE GARMENTS PVT LTD', contactName: 'R', gstin: '27AAPFU0939F1ZV', phoneNumber: '9000000001' });
    mockReadCard.mockResolvedValue({ problem: null, name: 'Sunrise Garments', contactName: 'R. Kumar', phone: '9876543210', email: 'kumar@sunrise.in', gstin: '33AAECS1234F1Z5', gstinChecksumOk: false, address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33', model: 'v', usage: {}, latencyMs: 5 });
    const r = await upload('/customer/read-card', {}, 'files');
    expect(r.status).toBe(200);
    expect(r.body.read).toMatchObject({ name: 'Sunrise Garments', stateCode: '33' });
    expect(r.body.similar).toEqual([expect.objectContaining({ name: 'SUNRISE GARMENTS PVT LTD', why: 'similar name' })]);
    expect((await get('/customer/similar?gstin=27AAPFU0939F1ZV')).body.similar[0]).toMatchObject({ why: 'same GSTIN' });
    expect((await get('/customer/similar?name=Kumar%20Knits')).body.similar).toEqual([]);
    expect((await get('/customer/gstin/27AAPFU0939F1ZV')).body).toMatchObject({ valid: true, stateCode: '27', pan: 'AAPFU0939F', checksumOk: true });
    expect((await get('/customer/gstin/27AAPFU0939F1ZX')).body.checksumOk).toBe(false);
    const created = await post('/customer/create', { name: 'Sunrise Garments Tiruppur', contactName: 'R. Kumar', phoneNumber: '9876543210', email: 'kumar@sunrise.in', gstin: '33AAECS1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', aiSuggestion: r.body.aiSuggestion });
    expect(created.status).toBe(201);
    await new Promise((x) => setTimeout(x, 150));
    const row = await settled(r.body.aiSuggestion);
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['name']);
    // The supplier side answers the same way.
    expect((await get('/supplier/similar?name=Nobody')).status).toBe(200);
  });
});

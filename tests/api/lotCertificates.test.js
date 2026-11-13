'use strict';
// ══════════════════════════════════════════════════════════════════
//  A YARN LOT'S TEST CERTIFICATE — services/lotCertificates.js
//
//    • read: the lot it is for (picked, or by the number it names), each
//      property under a key, and the checks — out of its own range, a
//      fail, far off the lots before, another lot's number
//    • kept on the lot; the read scored
//    • lots searched by a property's value, and compared side by side
//
//  The model is a stand-in that answers the reader's prompt.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mockClient = null;
let reply = null;
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClient, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

let mongo, app, M, admin, nylon, spandex, supplier, lot;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const read = (fields = {}) => {
  let r = request(app).post('/api/v2/yarn-lots/certificate/read').set('Cookie', cookie());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('files', PDF, { filename: 'tc.pdf', contentType: 'application/pdf' });
};
const settle = () => new Promise((ok) => setTimeout(ok, 60));
const cert = (over = {}) => ({
  problem: null, issuer: 'Sri Yarn Traders', certNo: 'TC/2611/044', date: '2026-11-02', lotNo: 'L-4471', product: 'Nylon 70D/24F SD',
  tests: [
    { name: 'Denier', value: 70.4, unit: 'den', min: 68, max: 72 },
    { name: 'Tenacity', value: 4.6, unit: 'g/den', min: 4.2, max: null },
    { name: 'Elongation at break', value: 33, unit: '%', min: 24, max: 32 },
    { name: 'Boiling water shrinkage', value: 9.5, unit: '%', min: null, max: 12 },
    { name: 'Lustre', value: 2, unit: '', min: null, max: null },
  ],
  result: 'pass', ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'Supplier', 'YarnLot', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'lots@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  nylon = await M.RawMaterial.create({ name: 'Nylon 70D/24F SD', category: 'yarn', unit: 'kg' });
  spandex = await M.RawMaterial.create({ name: 'Spandex 840D', category: 'rubber', unit: 'kg' });
  supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
  lot = await M.YarnLot.create({ rawMaterial: nylon._id, lotNo: 'L-4471', shade: 'Raw white', supplier: supplier._id, receivedQty: 400 });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  reply = cert();
  mockClient = { messages: { create: jest.fn(() => Promise.resolve({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify(reply) }] })) } };
});

describe('reading a lot\'s test certificate', () => {
  it('the lot by the number it names, each property under a key, a value outside its own range flagged; kept, the read is scored', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.lot).toMatchObject({ lotNo: 'L-4471', materialName: 'Nylon 70D/24F SD', supplierName: 'Sri Yarn Traders', hasCertificate: false });
    expect(res.body.tests.map((t) => t.key)).toEqual(['denier', 'tenacity', 'elongation', 'shrinkage', 'other:lustre']);
    expect(res.body.checks).toEqual([expect.objectContaining({ code: 'OUT_OF_SPEC', severity: 'danger', key: 'elongation', message: 'Elongation 33 % is above the 32 the certificate itself gives' })]);

    const kept = await put(`/yarn-lots/${lot._id}/certificate`, { certNo: 'TC/2611/044', date: '2026-11-02', issuer: 'Sri Yarn Traders', result: 'pass', tests: res.body.tests, aiSuggestion: res.body.aiSuggestion });
    expect(kept.status).toBe(200);
    expect(kept.body.certificate).toMatchObject({ certNo: 'TC/2611/044', result: 'pass', byName: 'Owner', flags: [expect.objectContaining({ code: 'OUT_OF_SPEC' })] });
    expect(kept.body.certificate.tests).toHaveLength(5);
    await settle();
    expect((await M.AiSuggestion.findById(res.body.aiSuggestion).lean()).outcome).toBe('accepted');
    // The lot list carries it.
    const list = (await get(`/yarn-lots/list?material=${nylon._id}`)).body;
    expect((list.lots || list.data || []).find((l) => l.lotNo === 'L-4471').certificate.certNo).toBe('TC/2611/044');
  });

  it('far off the lots before is said; a fail is said', async () => {
    for (const [no, ten] of [['L-4401', 4.5], ['L-4402', 4.7], ['L-4403', 4.6]]) {
      const l = await M.YarnLot.create({ rawMaterial: nylon._id, lotNo: no, receivedQty: 100 });
      await put(`/yarn-lots/${l._id}/certificate`, { certNo: `TC/${no}`, date: '2026-10-01', tests: [{ label: 'Tenacity', value: ten, unit: 'g/den' }, { label: 'Denier', value: 70, unit: 'den' }] });
    }
    const next = await M.YarnLot.create({ rawMaterial: nylon._id, lotNo: 'L-4480', receivedQty: 100 });
    reply = cert({ lotNo: 'L-4480', result: 'fail', tests: [{ name: 'Tenacity', value: 3.9, unit: 'g/den', min: null, max: null }, { name: 'Denier', value: 70.2, unit: 'den', min: null, max: null }] });
    const r = (await read({ lot: String(next._id) })).body;
    expect(r.checks.map((c) => c.code)).toEqual(['FAIL', 'DRIFT']);
    // The average is over the last five certified lots: the three, and L-4471 kept above.
    expect(r.checks[1].message).toBe('Tenacity 3.9 g/den against 4.6 on average over the last 4 lots of Nylon 70D/24F SD');
    expect(r.history.denier).toEqual({ avg: 70.1, n: 4 });
  });

  it('another lot\'s number, a number not on file, and one on two yarns: said', async () => {
    reply = cert({ lotNo: 'L-9999' });
    let r = (await read({ lot: String(lot._id) })).body;
    expect(r.lot.lotNo).toBe('L-4471');
    expect(r.checks[0]).toMatchObject({ code: 'LOT_NO', message: 'The certificate is for lot L-9999; this is lot L-4471' });
    r = (await read()).body;
    expect(r.lot).toBeNull();
    expect(r.checks[0]).toMatchObject({ code: 'LOT', severity: 'danger', message: 'Lot L-9999 is not on file: pick the lot it belongs to' });
    await M.YarnLot.create({ rawMaterial: spandex._id, lotNo: 'L-4471', receivedQty: 50 });
    reply = cert();
    r = (await read()).body;
    expect(r.candidates).toHaveLength(2);
    expect(r.checks[0].message).toBe('Lot L-4471 is on file for 2 yarns: pick the lot');
  });

  it('not a certificate, or no reader on the server: said plainly', async () => {
    reply = { problem: 'not_a_certificate' };
    expect((await read()).body).toMatchObject({ read: { problem: 'not_a_certificate' }, lot: null, tests: [] });
    mockClient = null;
    const res = await read();
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Reading test certificates is not set up on this server: type the details in.');
  });
});

describe('lots searched and compared by their certificates', () => {
  it('tenacity 4.6 and over: the lots that have it; out of their own range marked', async () => {
    const lots = (await get(`/yarn-lots/certificates/search?material=${nylon._id}&key=tenacity&min=4.6`)).body.lots;
    expect(lots.map((l) => [l.lotNo, l.value]).sort()).toEqual([['L-4402', 4.7], ['L-4403', 4.6], ['L-4471', 4.6]]);
    const elong = (await get(`/yarn-lots/certificates/search?key=elongation&min=30`)).body.lots;
    expect(elong).toEqual([expect.objectContaining({ lotNo: 'L-4471', value: 33, max: 32, outOfSpec: true, balance: 400 })]);
    expect((await get('/yarn-lots/certificates/search')).status).toBe(400);
  });

  it('the certified lots of a yarn side by side, a row a property, with the average', async () => {
    const c = (await get(`/yarn-lots/certificates/compare?material=${nylon._id}`)).body;
    expect(c.lots[0]).toMatchObject({ lotNo: 'L-4471', certNo: 'TC/2611/044', flags: 1 });
    expect(c.rows.map((r) => r.key)).toEqual(['denier', 'tenacity', 'elongation', 'shrinkage', 'other:lustre']);
    const ten = c.rows.find((r) => r.key === 'tenacity');
    expect(ten).toMatchObject({ label: 'Tenacity', unit: 'g/den', avg: 4.6, low: 4.5, high: 4.7 });
    expect(ten.cells).toHaveLength(c.lots.length);
    expect(c.rows.find((r) => r.key === 'elongation').cells[0]).toMatchObject({ value: 33, outOfSpec: true });
    const two = (await get(`/yarn-lots/certificates/compare?lots=${c.lots[0]._id},${c.lots[1]._id}`)).body;
    expect(two.lots).toHaveLength(2);
  });
});

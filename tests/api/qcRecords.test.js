'use strict';
// ══════════════════════════════════════════════════════════════════
//  A QC CHECK, THE CERTIFICATE IT BECOMES, AND THE PHOTO EXPORT
//
//  Found reading api/qc.js line by line.
//
//  1. A CHECK FOR AN ELASTIC THE JOB DOES NOT MAKE. POST /qc/create took
//     any elastic id beside any job. The certificate for the job is built
//     from its checks, so a check filed against the wrong job put an
//     elastic on that job's certificate that the job never made.
//
//  2. "false" WAS A PASS. Each result's `pass` was Boolean(value): any
//     text is true, the text "false" included. On a quality record that
//     is the wrong way to be wrong.
//
//  3. A CERTIFICATE FROM A PASS THAT A LATER CHECK OVERTURNED. The
//     certificate shows each elastic's latest PASSING check. When a later
//     check of the same elastic failed, nothing said so: the sheet read
//     PASS, ready to print and sign.
//
//  4. THE PHOTO EXPORT WAS BUILT IN ONE PIECE. Up to 2,000 records, each
//     with its photo (megabytes of text), were read into memory and
//     turned into one string. It is ready to use at 200 photos — which is
//     about where one string stops being possible. It is written a
//     record at a time now; what arrives is the same document.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2/qc${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2/qc${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Elastic', 'Customer', 'Order', 'JobOrder', 'QcRecord']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'QC Admin', email: 'qc-records@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (name) => M.Elastic.create({
  name: `${name} ${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  testingParameters: { width: 20, elongation: 160 },
});
/** A job making `elastics`, for an order of the same. */
async function makeJob(elastics, { listOnJob = true } = {}) {
  const customer = await M.Customer.create({ name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered: elastics.map((e) => ({ elastic: e._id, quantity: 1000, rate: 10 })),
  });
  return M.JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status: 'checking',
    ...(listOnJob ? { elastics: elastics.map((e) => ({ elastic: e._id, quantity: 1000 })) } : {}),
  });
}
const width = (measured, pass) => ({ parameter: 'Width (mm)', expected: '20', measured: String(measured), pass });
const check = (job, elastic, over = {}) => post('/create', {
  jobId: String(job._id), elasticId: String(elastic._id), results: [width(20, true)], ...over,
});
/** A check already on file, at a given moment. */
const filed = (job, elastic, over = {}) => M.QcRecord.create({
  job: job._id, elastic: elastic._id, results: [width(20, true)], overallResult: 'pass', ...over,
});
const at = (iso) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });

// ══════════════════════════════════════════════════════════════════
describe('recording a check', () => {
  it('is for an elastic the job makes', async () => {
    const [made, other] = [await makeElastic('20mm Black'), await makeElastic('25mm White')];
    const job = await makeJob([made]);

    const res = await check(job, other);
    // Before: 201 — and "25mm White" on this job's certificate.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not .*this job/i);
    expect(await M.QcRecord.countDocuments()).toBe(0);

    expect((await check(job, made)).status).toBe(201);
  });

  it('a job that lists no elastics of its own is read off its order', async () => {
    const [made, other] = [await makeElastic('20mm Black'), await makeElastic('25mm White')];
    const job = await makeJob([made], { listOnJob: false });
    expect((await check(job, made)).status).toBe(201);
    expect((await check(job, other)).status).toBe(400);
  });

  it('an elastic id that is not one is refused, not a server error', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    const res = await post('/create', { jobId: String(job._id), elasticId: 'the black one', results: [width(20, true)] });
    expect(res.status).toBe(400);
  });

  it('a result sent as the text "false" is a fail', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    const res = await check(job, made, { results: [width(17, 'false')], defectCode: 'WIDTH-OOS' });
    expect(res.status).toBe(201);
    // Before: pass — Boolean("false") is true.
    expect(res.body.record.overallResult).toBe('fail');
    expect(res.body.record.results[0].pass).toBe(false);
    expect(res.body.record.defectCode).toBe('WIDTH-OOS');
  });

  it('true, and the text "true", are a pass (unchanged)', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    expect((await check(job, made, { results: [width(20, true)] })).body.record.overallResult).toBe('pass');
    expect((await check(job, made, { results: [width(20, 'true')] })).body.record.overallResult).toBe('pass');
    expect((await check(job, made, { results: [width(20, true), width(17, false)] })).body.record.overallResult).toBe('fail');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the certificate of analysis', () => {
  it('says when a later check of the elastic failed', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    await filed(job, made, at('2026-11-10T06:00:00Z'));
    await filed(job, made, {
      results: [width(17, false)], overallResult: 'fail', defectCode: 'WIDTH-OOS', rejectedMeters: 40, ...at('2026-11-12T06:00:00Z'),
    });

    const { coa } = (await get(`/coa?jobId=${job._id}`)).body;
    expect(coa.items).toHaveLength(1);
    // Still the passing check — that is what a certificate shows…
    expect(coa.items[0].results[0]).toMatchObject({ measured: '20', pass: true });
    // …with what came after it. Before: nothing.
    expect(coa.items[0].laterFail).toMatchObject({ defectCode: 'WIDTH-OOS', rejectedMeters: 40 });
    expect(new Date(coa.items[0].laterFail.at).toISOString()).toBe('2026-11-12T06:00:00.000Z');
  });

  it('says nothing of a failure that was put right by a later pass', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    await filed(job, made, { results: [width(17, false)], overallResult: 'fail', defectCode: 'WIDTH-OOS', ...at('2026-11-10T06:00:00Z') });
    await filed(job, made, at('2026-11-12T06:00:00Z'));

    const { coa } = (await get(`/coa?jobId=${job._id}`)).body;
    expect(coa.items).toHaveLength(1);
    expect(coa.items[0].laterFail).toBeNull();
    expect(new Date(coa.items[0].checkedAt).toISOString()).toBe('2026-11-12T06:00:00.000Z');
  });

  it('is per elastic: one failing afterwards says nothing of the other', async () => {
    const [black, white] = [await makeElastic('20mm Black'), await makeElastic('20mm White')];
    const job = await makeJob([black, white]);
    await filed(job, black, at('2026-11-10T06:00:00Z'));
    await filed(job, white, at('2026-11-10T07:00:00Z'));
    await filed(job, white, { results: [width(17, false)], overallResult: 'fail', ...at('2026-11-11T06:00:00Z') });

    const { coa } = (await get(`/coa?jobId=${job._id}`)).body;
    const by = Object.fromEntries(coa.items.map((i) => [i.elasticName.replace(/ \d+$/, ''), i]));
    expect(by['20mm Black'].laterFail).toBeNull();
    expect(by['20mm White'].laterFail).not.toBeNull();
  });

  it('an elastic that has never passed is not on it (unchanged)', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    await filed(job, made, { results: [width(17, false)], overallResult: 'fail' });
    expect((await get(`/coa?jobId=${job._id}`)).body.coa.items).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the labelled-photo export', () => {
  const photo = (n) => `data:image/png;base64,${Buffer.from(`photo ${n}`).toString('base64')}`;

  it('is one JSON document: newest first, each with its label, no more than asked for', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    await filed(job, made, { image: photo(1), ...at('2026-11-10T06:00:00Z') });
    await filed(job, made, { image: photo(2), results: [width(17, false)], overallResult: 'fail', defectCode: 'WIDTH-OOS', ...at('2026-11-11T06:00:00Z') });
    await filed(job, made, { image: photo(3), results: [width(17, false)], overallResult: 'fail', ...at('2026-11-12T06:00:00Z') });
    await filed(job, made, at('2026-11-13T06:00:00Z'));                    // no photo: not a sample

    const res = await get('/export-dataset');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ success: true, count: 3 });
    expect(typeof res.body.exportedAt).toBe('string');
    expect(res.body.samples.map((s) => s.image)).toEqual([photo(3), photo(2), photo(1)]);
    expect(res.body.samples.map((s) => s.label)).toEqual(['defect', 'WIDTH-OOS', 'pass']);
    expect(res.body.samples[1]).toMatchObject({
      overallResult: 'fail', elastic: made.name, parameters: [{ parameter: 'Width (mm)', measured: '17', pass: false }],
    });

    const two = await get('/export-dataset?limit=2');
    expect(two.body.count).toBe(2);
    expect(two.body.samples.map((s) => s.image)).toEqual([photo(3), photo(2)]);
  });

  it('is an empty list, still a document, when there are no photos', async () => {
    const res = await get('/export-dataset');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 0, samples: [] });
  });

  it('is written a record at a time, not built whole', async () => {
    const made = await makeElastic('20mm Black');
    const job = await makeJob([made]);
    for (let i = 0; i < 5; i++) await filed(job, made, { image: photo(i) });

    const res = await get('/export-dataset');
    expect(res.body.count).toBe(5);
    // Sent as it is written, in pieces. Before: one string of everything,
    // with its length worked out up front.
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(res.headers['content-length']).toBeUndefined();
  });
});

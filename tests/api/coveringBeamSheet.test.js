'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FILLED COVERING PROGRAMME, BACK FROM THE MACHINE
//
//    POST /covering/:id/beam-sheet     read a photo of it (nothing saved)
//    POST /covering/:id/beam-entries   save the rows a person checked
//    GET  /covering/:id/beam-labels.pdf  one label a beam
//
//  The model is replaced by a fixed reading: what is tested is how the
//  rows are marked against what is already recorded, what is saved, and
//  what is refused.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../utils/coveringBeamOcr', () => {
  const actual = jest.requireActual('../../utils/coveringBeamOcr');
  return { ...actual, readCoveringBeams: jest.fn() };
});

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');
const { readCoveringBeams, sheetRefOf } = require('../../utils/coveringBeamOcr');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url) => request(app).post(url).set('Cookie', cookie());
const download = (url) => request(app).get(url).set('Cookie', cookie())
  .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Covering', 'JobOrder', 'Order', 'Customer', 'Elastic', 'AiSuggestion']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  readCoveringBeams.mockReset();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

async function seed({ status = 'in_progress', beamEntries = [{ beamNo: 1, weight: 12.5 }] } = {}) {
  const customer = await M.Customer.create({ name: 'Suguna Garments', contactName: 'S', phoneNumber: '9111111111', address: 'T', email: 's@t.co' });
  const elastic = await M.Elastic.create({ name: 'SUGUNA PLAIN 8MM MAROON', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 9 });
  const order = await M.Order.create({
    customer: customer._id, po: 'PO-1', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1800 }],
  });
  const job = await M.JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 1800 }],
  });
  const covering = await M.Covering.create({
    date: new Date('2026-10-26'), job: job._id, status,
    elasticPlanned: [{ elastic: elastic._id, quantity: 1800 }],
    beamEntries: beamEntries.map((b) => ({ ...b, enteredAt: new Date('2026-10-26') })),
    producedWeight: beamEntries.reduce((t, b) => t + b.weight, 0),
  });
  await M.JobOrder.updateOne({ _id: job._id }, { $set: { covering: covering._id } });
  return { covering, job: await M.JobOrder.findById(job._id).lean() };
}

const reads = (reading) => readCoveringBeams.mockResolvedValue({
  available: true, model: 'vision', usage: { input_tokens: 10, output_tokens: 5 }, latencyMs: 40,
  reading: { jobOrderNo: null, sheetRef: null, totalWeight: null, problem: null, ...reading },
});
const row = (sNo, beamNo, weight, extra = {}) => ({ sNo, beamNo, weight, remarks: '', printed: false, confidence: 0.9, ...extra });

describe('reading the sheet', () => {
  it('marks each row against what is recorded, and saves nothing', async () => {
    const { covering, job } = await seed();
    reads({
      jobOrderNo: job.jobOrderNo, sheetRef: sheetRefOf(covering._id),
      rows: [row(1, 1, 12.5, { printed: true }), row(2, 2, 13.1), row(3, 3, 12.8), row(4, 3, 12.9), row(5, null, 11)],
    });
    const res = await post(`/api/v2/covering/${covering._id}/beam-sheet`).attach('photos', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.reading.rows.map((r) => r.status)).toEqual(['recorded_same', 'new', 'new', 'duplicate', 'invalid']);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.covering).toMatchObject({ jobOrderNo: job.jobOrderNo, sheetRef: sheetRefOf(covering._id) });
    expect(readCoveringBeams.mock.calls[0][0][0].mimetype).toBe('image/jpeg');

    const after = await M.Covering.findById(covering._id).lean();
    expect(after.beamEntries).toHaveLength(1);
    const s = await M.AiSuggestion.findById(res.body.suggestionId).lean();
    expect(s.surface).toBe('covering-beam-ocr');
    expect(s.proposed.beams).toEqual({ 1: 12.5, 2: 13.1, 3: 12.8 });
  });

  it('a weight that disagrees with the recorded one says both', async () => {
    const { covering } = await seed();
    reads({ rows: [row(1, 1, 15)] });
    const res = await post(`/api/v2/covering/${covering._id}/beam-sheet`).attach('photos', JPEG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(res.body.reading.rows[0]).toMatchObject({ status: 'recorded_different', weight: 15, recordedWeight: 12.5 });
  });

  it('warns when the sheet belongs to another job or covering', async () => {
    const { covering, job } = await seed();
    reads({ jobOrderNo: job.jobOrderNo + 7, sheetRef: 'CV-000000', rows: [row(1, 2, 12)] });
    const res = await post(`/api/v2/covering/${covering._id}/beam-sheet`).attach('photos', JPEG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(res.body.warnings).toEqual([
      `This sheet says J-${job.jobOrderNo + 7}; this covering is for J-${job.jobOrderNo}.`,
      `This sheet's reference is CV-000000; this covering's is ${sheetRefOf(covering._id)}.`,
    ]);
  });

  it('says so when reading is not set up', async () => {
    const { covering } = await seed();
    readCoveringBeams.mockResolvedValue({ available: false });
    const res = await post(`/api/v2/covering/${covering._id}/beam-sheet`).attach('photos', JPEG, { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('turns the reader\'s refusals into a 400', async () => {
    const { covering } = await seed();
    readCoveringBeams.mockRejectedValue(Object.assign(new Error('Attach a photo of the covering programme.'), { statusCode: 400 }));
    const res = await post(`/api/v2/covering/${covering._id}/beam-sheet`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Attach a photo/);
  });
});

describe('saving the checked rows', () => {
  it('adds the new beams together, totals the covering, and records each on the job', async () => {
    const { covering, job } = await seed();
    reads({ rows: [row(1, 2, 13.1), row(2, 3, 12.8)] });
    const read = await post(`/api/v2/covering/${covering._id}/beam-sheet`).attach('photos', JPEG, { filename: 's.jpg', contentType: 'image/jpeg' });

    const res = await post(`/api/v2/covering/${covering._id}/beam-entries`).send({
      suggestionId: read.body.suggestionId,
      beams: [{ beamNo: 1, weight: 12.5 }, { beamNo: 2, weight: 13.1, note: 'joint' }, { beamNo: 3, weight: 12.6 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.added.map((b) => b.beamNo)).toEqual([2, 3]);
    expect(res.body.skipped).toEqual([1]);
    expect(res.body.producedWeight).toBe(38.2);
    expect(res.body.totalBeams).toBe(3);

    const after = await M.Covering.findById(covering._id).lean();
    expect(after.beamEntries.map((b) => [b.beamNo, b.weight, b.note])).toEqual([[1, 12.5, ''], [2, 13.1, 'joint'], [3, 12.6, '']]);
    const j = await M.JobOrder.findById(job._id).lean();
    const fps = j.fingerprints.filter((f) => f.code === 'COVERING_BEAM_ENTRY');
    expect(fps).toHaveLength(2);

    // Beam 3 was read as 12.8 and saved as 12.6: an edit to a beam's weight
    // (the ledger folds the beam numbers into one path).
    const s = await M.AiSuggestion.findById(read.body.suggestionId).lean();
    expect(s.outcome).toBe('edited');
    expect(s.editedFields).toEqual(['beams[]']);
  });

  it('refuses the whole save when a beam is recorded at a different weight', async () => {
    const { covering } = await seed();
    const res = await post(`/api/v2/covering/${covering._id}/beam-entries`).send({ beams: [{ beamNo: 2, weight: 13 }, { beamNo: 1, weight: 15 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BEAM_ALREADY_RECORDED');
    expect(res.body.message).toMatch(/Beam 1 is already recorded at 12.5 kg/);
    expect((await M.Covering.findById(covering._id).lean()).beamEntries).toHaveLength(1);
  });

  it('checks every row as one beam entry is checked', async () => {
    const { covering } = await seed();
    const bad = async (beams) => (await post(`/api/v2/covering/${covering._id}/beam-entries`).send({ beams })).body.message;
    expect(await bad([])).toMatch(/at least one beam/);
    expect(await bad([{ beamNo: 1.5, weight: 2 }])).toMatch(/Row 1: beam number/);
    expect(await bad([{ beamNo: 4, weight: 0 }])).toMatch(/Row 1 \(beam 4\): weight must be/);
    expect(await bad([{ beamNo: 4, weight: 2500 }])).toMatch(/exceeds 2000 kg/);
    expect(await bad([{ beamNo: 4, weight: 2 }, { beamNo: 4, weight: 3 }])).toMatch(/Beam 4 is listed twice/);
  });

  it('adds nothing to a completed covering', async () => {
    const { covering } = await seed({ status: 'completed' });
    const res = await post(`/api/v2/covering/${covering._id}/beam-entries`).send({ beams: [{ beamNo: 2, weight: 13 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/completed covering/);
  });
});

describe('the beam labels', () => {
  it('prints every beam, or just the ones asked for', async () => {
    const { covering, job } = await seed({ beamEntries: [{ beamNo: 1, weight: 12.5 }, { beamNo: 2, weight: 13.25, note: 'joint' }] });
    const all = await download(`/api/v2/covering/${covering._id}/beam-labels.pdf`);
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toMatch(/pdf/);
    const text = await pdfText(all.body);
    expect(text).toMatch(new RegExp(`JOB J-${job.jobOrderNo}`));
    expect(text).toMatch(/12\.50 kg/);
    expect(text).toMatch(/13\.25 kg/);
    expect(text).toMatch(/SUGUNA PLAIN 8MM MAROON/);
    expect(text).toMatch(/Suguna Garments/);

    const one = await pdfText((await download(`/api/v2/covering/${covering._id}/beam-labels.pdf?beams=2`)).body);
    expect(one).toMatch(/13\.25 kg/);
    expect(one).not.toMatch(/12\.50 kg/);
  }, 30_000);
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  PROOF OF DELIVERY, READ FROM THE SIGNED COPY
//
//    • the photo reads into received-on, who, and their remark; checks
//      that it is this challan and the date makes sense; nothing saved
//    • recorded: a dispatched challan becomes delivered with its POD
//    • "2 boxes short" drafts a complaint against the order's job, once
//    • a draft challan, a date before dispatch: refused
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 10, output_tokens: 10 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, dc, job, customer;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const scan = (id) => request(app).post(`/api/v2/dc/${id}/pod/scan`).set('Cookie', cookie()).attach('files', photo, { filename: 'pod.jpg', contentType: 'image/jpeg' });
const record = (id, body) => request(app).post(`/api/v2/dc/${id}/pod`).set('Cookie', cookie()).send(body);
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'DeliveryChallan', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  M.Complaint = require('../../models/Complaints.js');
  admin = await M.User.create({ name: 'Owner', email: 'pod@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  customer = new mongoose.Types.ObjectId();
  const order = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('orders').insertOne({ _id: order, orderNo: 77, customer, status: 'Open' });
  job = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('joborders').insertOne({ _id: job, jobOrderNo: 512, order, customer, status: 'weaving', createdAt: new Date() });
  const base = { type: 'elastic', financialYear: '2026-27', customerName: 'Sunrise Garments', order, orderNo: 77, dispatchDate: new Date(Date.now() - 3 * 86_400_000), items: [] };
  dc = await M.DeliveryChallan.create({ ...base, dcNumber: 'DC/26-27/0142', sequence: 142, status: 'dispatched' });
  await M.DeliveryChallan.create({ ...base, dcNumber: 'DC/26-27/0143', sequence: 143, status: 'draft' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('proof of delivery', () => {
  it('reads the signed copy and says what does not fit, saving nothing', async () => {
    mockReply = { problem: null, dcNumber: 'DC/26-27/0149', deliveredOn: day(-1), receivedBy: 'Ramesh (stores)', stamped: true, remark: '2 box short', issue: null, shortPackages: 2 };
    const res = await scan(dc._id);
    expect(res.status).toBe(200);
    expect(res.body.read).toMatchObject({ deliveredOn: day(-1), receivedBy: 'Ramesh (stores)', issue: 'short', shortPackages: 2 });
    expect(res.body.checks).toEqual(['The copy says challan DC/26-27/0149; this is DC/26-27/0142.']);
    expect(res.body.complaint).toMatchObject({ customer: String(customer), category: 'quantity', jobs: [{ jobOrderNo: 512 }] });
    expect(res.body.complaint.reason).toMatch(/^short on delivery of DC\/26-27\/0142: “2 box short”/);
    expect((await M.DeliveryChallan.findById(dc._id).lean()).status).toBe('dispatched');

    mockReply = { problem: 'not_a_pod' };
    expect((await scan(dc._id)).body.read.problem).toBe('not_a_pod');
  });

  it('records it: delivered, with a complaint opened once for the shortage', async () => {
    mockReply = { problem: null, dcNumber: 'DC/26-27/0142', deliveredOn: day(-1), receivedBy: 'Ramesh', remark: '2 box short', issue: 'short' };
    const read = (await scan(dc._id)).body;
    const res = await record(dc._id, {
      deliveredOn: day(-1), receivedBy: 'Ramesh', remark: '2 box short', issue: 'short', source: 'photo', aiSuggestion: read.aiSuggestion,
      complaint: { job: String(job), reason: read.complaint.reason },
    });
    expect(res.status).toBe(200);
    const saved = await M.DeliveryChallan.findById(dc._id).lean();
    expect(saved.status).toBe('delivered');
    expect(saved.pod).toMatchObject({ receivedBy: 'Ramesh', issue: 'short', source: 'photo' });
    const c = await M.Complaint.findById(saved.pod.complaint).lean();
    expect(c).toMatchObject({ category: 'quantity', status: 'Open' });
    expect(String(c.job)).toBe(String(job));
    // Recorded again (a corrected name): the POD changes, no second complaint.
    expect((await record(dc._id, { deliveredOn: day(-1), receivedBy: 'Ramesh K', issue: 'short', complaint: { job: String(job) } })).status).toBe(200);
    expect(await M.Complaint.countDocuments()).toBe(1);
    expect((await M.DeliveryChallan.findById(dc._id).lean()).pod.receivedBy).toBe('Ramesh K');
    expect((await M.AiSuggestion.findById(read.aiSuggestion).lean()).outcome).toBe('accepted');
  });

  it('refuses a draft challan and a date before dispatch', async () => {
    const draft = await M.DeliveryChallan.findOne({ status: 'draft' });
    expect((await record(draft._id, { deliveredOn: day(0) })).status).toBe(409);
    const early = await record(dc._id, { deliveredOn: day(-10) });
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/dispatched on/);
    expect((await record(dc._id, { deliveredOn: day(2) })).status).toBe(400);
  });
});

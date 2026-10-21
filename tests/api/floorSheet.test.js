'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FLOOR SHEET — a production sheet with no plan behind it
//
//  Printed for any date and shift: every machine, its job or FREE, and
//  blank Operator / Timer / Production / Supervisor-signature columns.
//  A photo of it filled in, for a shift with no plan, waits as
//  needs_plan with the plan it proposes; creating that plan matches the
//  slip to it, and the metres written become the production draft.
//
//  The reading itself (Claude vision) is stubbed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.PUBLIC_BASE_URL = 'https://erp.example.com';

const mockRead = jest.fn();
jest.mock('../../utils/slipOcr', () => ({
  readSlip: (...a) => mockRead(...a),
  SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
}));
const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../utils/whatsapp', () => ({
  sendWhatsApp: (...a) => mockSend(...a),
  isConfigured: () => true,
  PROVIDER: 'twilio',
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, svc, SlipIngest, ShiftPlan, ShiftDetail, Machine, Employee, JobOrder, User;
let admin, production, accounts, job;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  svc = require('../../services/slipIngest');
  SlipIngest = require('../../models/SlipIngest');
  ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  Machine = require('../../models/Machine');
  Employee = require('../../models/Employee');
  JobOrder = require('../../models/JobOrder');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  production = await User.create({ name: 'Lead', email: 'l@t.co', password: 'pass1234', role: 'production', department: 'production' });
  accounts = await User.create({ name: 'Books', email: 'b@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
  mockRead.mockReset();
  mockSend.mockClear();
  const Customer = require('../../models/Customer');
  const Order = require('../../models/Order');
  const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(), elasticOrdered: [],
  });
  job = await JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [] });
  // M-10 sorts after M-2: the sheet orders machines as people count.
  for (const [ID, running] of [['M-10', false], ['M-2', true], ['M-1', false]]) {
    await Machine.create({
      ID, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, elastics: [],
      status: running ? 'running' : 'free', orderRunning: running ? job._id : null,
    });
  }
  await Employee.create({ name: 'Ravi Kumar', department: 'weaving' });
  await Employee.create({ name: 'Selvi', department: 'weaving' });
  await Employee.create({ name: 'Selvi', department: 'packing' }); // a namesake who does not weave
  await Employee.create({ name: 'Murugan', department: 'weaving' });
});

const row = (machine, over = {}) => ({
  code: null, machine, job: null, operator: null, production: null, timer: null, remarks: '', signed: false, confidence: 0.95, ...over,
});
const floorRead = (rows, over = {}) => ({
  format: 'floor', planNo: null, sheetNo: 'FS-20261021-D', date: null, shift: null, rows, problem: null,
  model: 'test-model', usage: {}, latencyMs: 5, ...over,
});
const photo = { buffer: Buffer.from('jpeg-bytes'), mimetype: 'image/jpeg' };

async function readSheet(rows, over) {
  mockRead.mockResolvedValueOnce(floorRead(rows, over));
  const slip = await svc.receiveUpload({ files: [photo], user: admin });
  await svc.readSlipJob(slip._id);
  return SlipIngest.findById(slip._id);
}

describe('the printed sheet', () => {
  const download = (u, q) => request(app).get(`/api/v2/shift/floor-sheet.pdf${q}`).set('Cookie', cookie(u))
    .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });

  it('lists every machine in order, with its job or FREE, under a sheet number naming the shift', async () => {
    const res = await download(production, '?date=2026-10-21&shift=NIGHT');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/floor-sheet-2026-10-21-NIGHT\.pdf/);
    const text = await pdfText(res.body);
    expect(text).toMatch(/FS-20261021-N/);
    expect(text).toMatch(/SUPERVISOR SIGNATURE/);
    expect(text).toMatch(/OPERATOR/);
    const at = (s) => text.indexOf(s);
    expect(at('M-1')).toBeLessThan(at('M-2'));
    expect(at('M-2')).toBeLessThan(at('M-10'));
    expect(text).toMatch(new RegExp(`J-${job.jobOrderNo}`));
    expect((text.match(/FREE/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a date it cannot read, and is not for accounts', async () => {
    expect((await download(admin, '?date=21-10-2026&shift=DAY')).status).toBe(400);
    expect((await download(admin, '?date=2026-10-21&shift=EVENING')).status).toBe(400);
    expect((await download(accounts, '?date=2026-10-21&shift=DAY')).status).toBe(403);
  });
});

describe('reading it back when the shift has no plan', () => {
  it('proposes the plan: each machine, the operator written matched by name, blank rows left out', async () => {
    const slip = await readSheet([
      row('M-1', { operator: 'ravi kumar', production: 1200, timer: '7:30:00' }),
      row('M-2', { job: `J-${job.jobOrderNo}`, operator: 'Selvi', production: 900, timer: '6:00:00' }),
      row('M-10', { job: 'FREE' }), // nothing written: not part of the shift
      row('M-7', { operator: 'Murugn', production: 50 }), // no such machine
    ]);
    expect(slip.status).toBe('needs_plan');
    expect(slip).toMatchObject({ dateKey: '2026-10-21', shift: 'DAY', dateFrom: 'sheet', format: 'floor' });
    expect(slip.problem).toMatch(/no day shift plan for 21 Oct 2026 yet/);
    const d = slip.planDraft.map((r) => r.toObject());
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ machineID: 'M-1', employeeName: 'Ravi Kumar', match: 'exact', production: 1200, notes: [] });
    // The weaving Selvi, not the packing one.
    expect(d[1]).toMatchObject({ machineID: 'M-2', employeeName: 'Selvi', jobNo: `J-${job.jobOrderNo}` });
    const weavingSelvi = await Employee.findOne({ name: 'Selvi', department: 'weaving' });
    expect(String(d[1].employee)).toBe(String(weavingSelvi._id));
    expect(d[2]).toMatchObject({ machine: null, machineRead: 'M-7', employeeName: 'Murugan', match: 'close' });
    expect(d[2].notes).toContain('No machine with this number');
  });

  it('a sheet with nothing written on it says so', async () => {
    const slip = await readSheet([row('M-1', { job: 'FREE' }), row('M-2')]);
    expect(slip.status).toBe('failed');
    expect(slip.problem).toMatch(/Nothing is written on the sheet yet/);
  });

  it('creating the plan matches the slip to it, and the metres become the draft to save', async () => {
    const slip = await readSheet([
      row('M-1', { operator: 'Ravi Kumar', production: 1200, timer: '7:30:00' }),
      row('M-2', { operator: 'Selvi', production: 900, timer: '6:00:00' }),
    ]);
    const out = await svc.createPlanFromSlip(slip._id, {});
    expect(out).toMatchObject({ created: true, detailCount: 2 });

    const plan = await ShiftPlan.findOne({ shift: 'DAY' }).lean();
    expect(plan.status).toBe('draft');
    expect(plan.description).toMatch(/FS-20261021-D/);
    const details = await ShiftDetail.find({ shiftPlan: plan._id }).populate('machine', 'ID').lean();
    const m2 = details.find((x) => x.machine.ID === 'M-2');
    expect(String(m2.job)).toBe(String(job._id)); // the machine's running job

    const after = out.slip;
    expect(after.status).toBe('ready');
    expect(String(after.shiftPlan)).toBe(String(plan._id));
    expect(after.dateFrom).toBe('sheet');
    expect(after.planDraft).toHaveLength(0);
    expect(after.rows.map((r) => [r.machineID, r.production])).toEqual([['M-1', 1200], ['M-2', 900]]);

    // And saving submits them for verification, like any slip.
    const saved = await svc.applySlip(after._id, { user: admin });
    expect(saved.saved).toBe(2);
    expect((await ShiftDetail.findById(m2._id).lean()).status).toBe('pending_verification');
  });

  it('on the web, a person picks the operator the sheet did not make clear', async () => {
    const slip = await readSheet([
      row('M-1', { operator: 'Ravi Kumar', production: 1200 }),
      row('M-10', { operator: 'Kannan', production: 800 }), // nobody called that
    ]);
    expect(slip.planDraft[1].employee).toBeNull();
    const murugan = await Employee.findOne({ name: 'Murugan' });

    const res = await request(app).post(`/api/v2/slips/${slip._id}/create-plan`).set('Cookie', cookie(production))
      .send({ expectedVersion: slip.__v, rows: [
        { index: 0, include: true },
        { index: 1, include: true, employee: String(murugan._id) },
      ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: true, planned: 2 });
    expect(res.body.slip.status).toBe('ready');
    expect(res.body.slip.rows.map((r) => r.operator)).toEqual(['Ravi Kumar', 'Murugan']);
  });

  it('a row left without an operator is refused, and a stale screen is told to reload', async () => {
    const slip = await readSheet([row('M-1', { operator: 'Kannan', production: 1200 })]);
    const post = (body) => request(app).post(`/api/v2/slips/${slip._id}/create-plan`).set('Cookie', cookie(admin)).send(body);
    expect((await post({ rows: [{ index: 0, include: true }] })).body.message).toMatch(/M-1: choose the operator/);
    expect((await post({ rows: [{ index: 0, include: false }] })).body.message).toMatch(/No machine has an operator/);
    expect((await post({ expectedVersion: slip.__v + 5, rows: [] })).status).toBe(409);
    expect(await ShiftPlan.countDocuments()).toBe(0);
  });

  it('if someone made the plan meanwhile, the slip is matched to that one', async () => {
    const slip = await readSheet([row('M-1', { operator: 'Ravi Kumar', production: 1200 })]);
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const m1 = await Machine.findOne({ ID: 'M-1' });
    const ravi = await Employee.findOne({ name: 'Ravi Kumar' });
    const { shiftPlan } = await createShiftPlan({ date: '2026-10-21', shiftType: 'DAY', machines: [{ machine: m1._id, operator: ravi._id }] });

    const out = await svc.createPlanFromSlip(slip._id, {});
    expect(out.created).toBe(false);
    expect(String(out.slip.shiftPlan)).toBe(String(shiftPlan._id));
    expect(await ShiftPlan.countDocuments()).toBe(1);
  });

  it('when the plan already exists, a floor sheet goes straight to the rows', async () => {
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const m1 = await Machine.findOne({ ID: 'M-1' });
    const ravi = await Employee.findOne({ name: 'Ravi Kumar' });
    await createShiftPlan({ date: '2026-10-21', shiftType: 'DAY', machines: [{ machine: m1._id, operator: ravi._id }] });
    const slip = await readSheet([row('M-1', { operator: 'Ravi', production: 1100, timer: '7:00:00' })]);
    expect(slip.status).toBe('ready');
    expect(slip.rows[0]).toMatchObject({ machineID: 'M-1', production: 1100, state: 'ready' });
  });

  it('tells a WhatsApp sender there is no plan, and what OK will do', async () => {
    mockRead.mockResolvedValueOnce(floorRead([
      row('M-1', { operator: 'Ravi Kumar', production: 1200 }),
      row('M-2', { operator: 'Kannan', production: 900 }),
    ]));
    const sender = { userId: admin._id, name: 'Owner' };
    const media = [{ url: 'https://api.twilio.com/x/Media/ME1', contentType: 'image/jpeg' }];
    const { slip } = await svc.receiveFromWhatsApp({ messageSid: 'SMF1', from: '+919100000001', media, sender });
    await SlipIngest.updateOne({ _id: slip._id }, { $set: { media: [] } });
    await require('../../models/SlipPhoto').create({
      slip: slip._id, page: 0, contentType: 'image/jpeg', size: 4, data: Buffer.from('jpeg').toString('base64'),
      expiresAt: new Date(Date.now() + 86400000),
    });
    await svc.readSlipJob(slip._id);
    const [, text] = mockSend.mock.calls[0];
    expect(text).toMatch(/no day shift plan for 21 Oct 2026 yet/);
    expect(text).toMatch(/2 machines written on the sheet; 1 with an operator matched/);
    expect(text).toMatch(/M-2 \(No employee called “Kannan”\)/);
    expect(text).toMatch(new RegExp(`Reply OK ${slip.confirmCode} to create the plan with those 1`));
  });
});

describe('OK on WhatsApp', () => {
  function sign(params) {
    const crypto = require('crypto');
    let data = 'https://erp.example.com/api/v2/notify/incoming';
    for (const k of Object.keys(params).sort()) data += k + params[k];
    return crypto.createHmac('sha1', 'tok').update(data, 'utf8').digest('base64');
  }
  const send = (params) => request(app).post('/api/v2/notify/incoming')
    .set('X-Twilio-Signature', sign(params)).type('form').send(params);

  it('creates the plan from the operators that matched, then says what is ready to save', async () => {
    const emp = await Employee.create({ name: 'Floor Lead', phoneNumber: '9100000009', department: 'weaving' });
    await User.deleteOne({ email: 'fl@t.co' });
    await User.create({ name: 'Floor Lead', email: 'fl@t.co', password: 'pass1234', role: 'production', department: 'production', employee: emp._id });
    const slip = await readSheet([
      row('M-1', { operator: 'Ravi Kumar', production: 1200, timer: '7:30:00' }),
      row('M-2', { operator: 'Kannan', production: 900 }),
    ]);

    const res = await send({ From: 'whatsapp:+919100000009', Body: `OK ${slip.confirmCode}`, NumMedia: '0', MessageSid: 'SMOK1' });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Plan created for the 1 machine/);
    expect(res.text).toMatch(/1 ready/);
    const plan = await ShiftPlan.findOne().lean();
    expect(plan.plan).toHaveLength(1);
    expect((await SlipIngest.findById(slip._id).lean()).status).toBe('ready');
  });
});

describe('matching a written name to an employee', () => {
  const { matchEmployee } = require('../../services/slipIngest')._internals;
  const people = [
    { _id: 'a', name: 'Ravi Kumar', department: 'weaving' },
    { _id: 'b', name: 'Ravi Shankar', department: 'weaving' },
    { _id: 'c', name: 'Lakshmi', department: 'weaving' },
    { _id: 'd', name: 'Lakshmi', department: 'packing' },
    { _id: 'e', name: 'Muthu Lakshmi', department: 'weaving' },
  ];
  it('exact, then initials, then a letter out — never a guess between two', () => {
    expect(matchEmployee('RAVI  KUMAR.', people)).toMatchObject({ employee: { _id: 'a' }, match: 'exact' });
    expect(matchEmployee('Ravi K', people)).toMatchObject({ employee: { _id: 'a' }, match: 'close' });
    expect(matchEmployee('Ravi', people)).toBeNull(); // two Ravis
    expect(matchEmployee('lakshmi', people)).toMatchObject({ employee: { _id: 'c' }, match: 'exact' });
    expect(matchEmployee('Lakshmy', people)).toMatchObject({ employee: { _id: 'c' }, match: 'close' });
    expect(matchEmployee('Zed', people)).toBeNull();
    expect(matchEmployee('', people)).toBeNull();
  });
});

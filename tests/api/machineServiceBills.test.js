'use strict';
// Taking a machine in for service:
//   • the service log can pull the machine off the floor in the same action
//   • service and spare bills attach to a log, and come back out again
//   • the file payload never rides along on a listing
//   • bad types / oversized files / cross-machine ids are refused

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Machine, MachineServiceBill, User, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

// A 1x1 PNG — small, and a genuinely valid image rather than random bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Machine = require('../../models/Machine');
  MachineServiceBill = require('../../models/MachineServiceBill');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMachine = (over = {}) =>
  Machine.create({ ID: 'M-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24, ...over });

const addLog = (body) =>
  request(app).post('/api/v2/machine/add-service-log').set('Cookie', adminCookie())
    .send({ type: 'Corrective', description: 'Replaced drive belt', ...body });

/** Creates a machine plus one service log and returns both ids. */
async function machineWithLog(over = {}) {
  const machine = await makeMachine(over);
  const res = await addLog({ machineId: String(machine._id) });
  return { machine, logId: String(res.body.log._id) };
}

const uploadBill = ({ machineId, logId, kind = 'service_bill', file = PNG, name = 'bill.png', type = 'image/png', fields = {} }) => {
  const req = request(app).post('/api/v2/machine/service-bill').set('Cookie', adminCookie())
    .field('machineId', String(machineId))
    .field('serviceLogId', String(logId))
    .field('kind', kind);
  for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
  return req.attach('file', file, { filename: name, contentType: type });
};

const listBills = (machineId, serviceLogId) =>
  request(app).get('/api/v2/machine/service-bills').set('Cookie', adminCookie())
    .query({ machineId: String(machineId), ...(serviceLogId ? { serviceLogId: String(serviceLogId) } : {}) });

describe('POST /machine/add-service-log — sending a machine for service', () => {
  test('leaves the status alone by default', async () => {
    const machine = await makeMachine();
    const res = await addLog({ machineId: String(machine._id) });

    expect(res.status).toBe(201);
    expect(res.body.statusChanged).toBe(false);
    expect((await Machine.findById(machine._id)).status).toBe('free');
  });

  test('takes the machine off the floor when asked, in the same save', async () => {
    const machine = await makeMachine();
    const res = await addLog({ machineId: String(machine._id), setMaintenance: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('maintenance');
    expect(res.body.statusChanged).toBe(true);

    const fresh = await Machine.findById(machine._id);
    expect(fresh.status).toBe('maintenance');
    // The log and the status move together — never one without the other.
    expect(fresh.serviceLogs).toHaveLength(1);
  });

  test('refuses to pull a machine that is mid-job, and records nothing', async () => {
    const machine = await makeMachine({ status: 'running' });
    const res = await addLog({ machineId: String(machine._id), setMaintenance: true });

    expect(res.status).toBe(409);
    const fresh = await Machine.findById(machine._id);
    expect(fresh.status).toBe('running');
    expect(fresh.serviceLogs).toHaveLength(0);
  });

  test('is idempotent against a machine already in maintenance', async () => {
    const machine = await makeMachine({ status: 'maintenance' });
    const res = await addLog({ machineId: String(machine._id), setMaintenance: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('maintenance');
    expect(res.body.statusChanged).toBe(false);
  });
});

describe('service & spare bills', () => {
  test('attaches a service bill and returns it without the file payload', async () => {
    const { machine, logId } = await machineWithLog();
    const res = await uploadBill({
      machineId: machine._id, logId,
      fields: { amount: 2500, vendor: 'Coimbatore Machine Works', billNo: 'INV-77' },
    });

    expect(res.status).toBe(201);
    expect(res.body.bill.kind).toBe('service_bill');
    expect(res.body.bill.amount).toBe(2500);
    expect(res.body.bill.vendor).toBe('Coimbatore Machine Works');
    expect(res.body.bill.contentType).toBe('image/png');
    expect(res.body.bill.size).toBe(PNG.length);
    // The blob must never ride along on a JSON response.
    expect(res.body.bill.data).toBeUndefined();
  });

  test('accepts a PDF spare bill with the part it paid for', async () => {
    const { machine, logId } = await machineWithLog();
    const res = await uploadBill({
      machineId: machine._id, logId, kind: 'spare_bill',
      file: PDF, name: 'spare.pdf', type: 'application/pdf',
      fields: { amount: 800, partName: 'Drive belt A-42' },
    });

    expect(res.status).toBe(201);
    expect(res.body.bill.kind).toBe('spare_bill');
    expect(res.body.bill.partName).toBe('Drive belt A-42');
  });

  test('lists a log’s bills with their total, still without payloads', async () => {
    const { machine, logId } = await machineWithLog();
    await uploadBill({ machineId: machine._id, logId, fields: { amount: 2500 } });
    await uploadBill({ machineId: machine._id, logId, kind: 'spare_bill', fields: { amount: 800 } });

    const res = await listBills(machine._id, logId);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.totalAmount).toBe(3300);
    expect(res.body.bills.every((b) => b.data === undefined)).toBe(true);
  });

  test('serves the original bytes back on download', async () => {
    const { machine, logId } = await machineWithLog();
    const up = await uploadBill({ machineId: machine._id, logId, file: PDF, name: 'spare.pdf', type: 'application/pdf' });

    const res = await request(app)
      .get(`/api/v2/machine/service-bill/${up.body.bill._id}/file`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('spare.pdf');
    expect(Buffer.compare(res.body, PDF)).toBe(0);
  });

  test('deletes a bill', async () => {
    const { machine, logId } = await machineWithLog();
    const up = await uploadBill({ machineId: machine._id, logId });

    const del = await request(app)
      .delete(`/api/v2/machine/service-bill/${up.body.bill._id}`)
      .set('Cookie', adminCookie());
    expect(del.status).toBe(200);

    expect((await listBills(machine._id, logId)).body.count).toBe(0);
  });

  test('rejects a file type that is neither a photo nor a PDF', async () => {
    const { machine, logId } = await machineWithLog();
    const res = await uploadBill({
      machineId: machine._id, logId,
      file: Buffer.from('MZ...'), name: 'tool.exe', type: 'application/x-msdownload',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported file type/i);
    expect(await MachineServiceBill.countDocuments()).toBe(0);
  });

  test('rejects an unknown bill kind', async () => {
    const { machine, logId } = await machineWithLog();
    const res = await uploadBill({ machineId: machine._id, logId, kind: 'lunch_receipt' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/kind must be one of/i);
  });

  test('rejects a file over the size cap as a 400, not a crash', async () => {
    const { machine, logId } = await machineWithLog();
    const tooBig = Buffer.alloc(MachineServiceBill.MAX_FILE_BYTES + 1024, 0x41);
    const res = await uploadBill({ machineId: machine._id, logId, file: tooBig });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/i);
  });

  test('refuses a log id that belongs to a different machine', async () => {
    const a = await machineWithLog();
    const b = await machineWithLog({ ID: 'M-02' });

    const res = await uploadBill({ machineId: a.machine._id, logId: b.logId });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Service log not found/i);
  });

  test('never lists another machine’s bills', async () => {
    const a = await machineWithLog();
    const b = await machineWithLog({ ID: 'M-02' });
    await uploadBill({ machineId: a.machine._id, logId: a.logId, fields: { amount: 100 } });
    await uploadBill({ machineId: b.machine._id, logId: b.logId, fields: { amount: 900 } });

    const res = await listBills(a.machine._id);
    expect(res.body.count).toBe(1);
    expect(res.body.totalAmount).toBe(100);
  });
});

describe('GET /machine/get-machine-detail — bill rollup', () => {
  test('reports each log’s bill count and total', async () => {
    const { machine, logId } = await machineWithLog();
    await uploadBill({ machineId: machine._id, logId, fields: { amount: 2500 } });
    await uploadBill({ machineId: machine._id, logId, kind: 'spare_bill', fields: { amount: 800 } });

    const res = await request(app).get('/api/v2/machine/get-machine-detail')
      .query({ id: String(machine._id) }).set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    const log = res.body.machine.serviceLogs.find((l) => String(l._id) === logId);
    expect(log.billCount).toBe(2);
    expect(log.billTotal).toBe(3300);
  });

  test('reports zeroes for a log with no bills', async () => {
    const { machine, logId } = await machineWithLog();

    const res = await request(app).get('/api/v2/machine/get-machine-detail')
      .query({ id: String(machine._id) }).set('Cookie', adminCookie());

    const log = res.body.machine.serviceLogs.find((l) => String(l._id) === logId);
    expect(log.billCount).toBe(0);
    expect(log.billTotal).toBe(0);
  });
});

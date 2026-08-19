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

  // Dio's MultipartFile labels every part application/octet-stream unless
  // the caller names a media type, and the class that names it moved
  // between Dio releases. A phone that cannot name its own PDF is not a
  // reason to lose the bill.
  test('falls back to the extension when the part is unlabelled', async () => {
    const { machine, logId } = await machineWithLog();
    const res = await uploadBill({
      machineId: machine._id, logId,
      file: Buffer.from('%PDF-1.4\n'), name: 'vendor-invoice.PDF',
      type: 'application/octet-stream',
    });

    expect(res.status).toBe(201);
    expect(res.body.bill.contentType).toBe('application/pdf');

    // The stored data URL must agree with the stored type, or the
    // download route sends a header contradicting its own payload.
    const stored = await MachineServiceBill.findById(res.body.bill._id).lean();
    expect(stored.data.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  test('does not rescue a part that names a type we do not take', async () => {
    const { machine, logId } = await machineWithLog();
    // A client asserting video/mp4 is telling us something; .pdf on the
    // end of the name would not make it a PDF.
    const res = await uploadBill({
      machineId: machine._id, logId,
      file: Buffer.from('....'), name: 'clip.pdf', type: 'video/mp4',
    });

    expect(res.status).toBe(400);
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
    // Names the machine it looked in, so "the log exists, I can see it"
    // and "it is not on THIS machine" stop being the same message.
    expect(res.body.message).toMatch(/Machine M-01 has no service log/);
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

// ══════════════════════════════════════════════════════════════════
//  WHEN THE BILL WILL NOT ATTACH, SAY WHICH ID WAS WRONG
//
//  "Machine not found" was the answer to four different mistakes: an
//  id that is not an id, the service log's id sent in the machineId
//  field, a machine somebody deleted, and a log that belongs to some
//  other machine. Same four words for all of them, on a phone, in a
//  mill, with no log to read.
//
//  That is not a cosmetic complaint. It is why a report of this
//  failure could not be reproduced from the message alone: the message
//  carried none of the information needed to tell the causes apart.
//  These pin that each one now names itself.
// ══════════════════════════════════════════════════════════════════
describe('POST /machine/service-bill — what it says when the ids are wrong', () => {
  test('a machineId that is not an id says so, rather than "not found"', async () => {
    // Sending the machine's CODE (M-01) instead of its database id is
    // the obvious mistake, and 404 "not found" actively misleads: the
    // machine exists.
    const { logId } = await machineWithLog();

    const res = await uploadBill({ machineId: 'M-01', logId });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/machineId "M-01" is not an id/);
    expect(res.body.message).toMatch(/not its code/);
  });

  test('names the id when no machine has it', async () => {
    const { logId } = await machineWithLog();
    const ghost = new mongoose.Types.ObjectId();

    const res = await uploadBill({ machineId: ghost, logId });

    expect(res.status).toBe(404);
    // The id itself, so the failing request can be matched to a record.
    expect(res.body.message).toContain(String(ghost));
    expect(res.body.message).toMatch(/deleted|wrong id/i);
  });

  test('spots the service log’s own id sent as the machineId', async () => {
    // The one mix-up this call shape invites: two ids, adjacent fields,
    // both ObjectIds, and swapping them looks exactly like a deleted
    // machine unless somebody goes looking.
    const { logId } = await machineWithLog();

    const res = await uploadBill({ machineId: logId, logId });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/that is a service log's id/);
    expect(res.body.message).toMatch(/on machine M-01/);
    expect(res.body.message).toMatch(/Send the machine's id as machineId/);
  });

  test('says how many logs the machine has when the log id misses', async () => {
    const { machine } = await machineWithLog();

    const res = await uploadBill({
      machineId: machine._id, logId: new mongoose.Types.ObjectId(),
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Machine M-01 has no service log/);
    expect(res.body.message).toMatch(/1 log\(s\)/);
  });

  test('accepts the bill when the file is sent before the fields', async () => {
    // The browser's FormData appends the file first, and multer parses
    // the stream in order — so with the wrong parser the metadata is
    // not on req.body yet when the handler runs, and every upload from
    // the web client fails on an id that was sent correctly. This is
    // the shape that actually goes over the wire.
    const { machine, logId } = await machineWithLog();

    const res = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', adminCookie())
      .attach('file', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' })
      .field('machineId', String(machine._id))
      .field('serviceLogId', logId)
      .field('kind', 'service_bill');

    expect(res.status).toBe(201);
  });
});

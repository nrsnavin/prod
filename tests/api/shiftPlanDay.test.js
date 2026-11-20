'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH DAY A SHIFT PLAN IS FOR
//
//  Found reading services/floorEntry.js and services/slipIngest.js line
//  by line. A plan's day is its day in India — that is how the loading
//  rules already read it (services/machineLoading.js). Four other places
//  read it off the server's own clock instead:
//
//    • a plan made from a moment (01:00 on the 21st in India is still
//      the 20th in UTC) was filed under the day before;
//    • the floor tablet, the slip reader and the day's lists looked a
//      plan up by the server's date — two copies of one lookup — so a
//      plan stored the old way (midnight in India) was found under the
//      day before, and its printed sheet carried that day's number;
//    • a floor sheet printed with no date before 05:30 was yesterday's;
//    • a slip captioned "DAY 01-01" in the first hours of New Year's
//      Day was taken as the year just ended.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin, floor, slips;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const pdf = (url) => get(url).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  floor = require('../../services/floorEntry');
  slips = require('../../services/slipIngest');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'pd@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
async function loom() {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: `91000000${String(n).padStart(2, '0')}` });
  const elastic = await M.Elastic.create({ name: `20mm pd-${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({ orderNo: 3000 + n, customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }] });
  const job = await M.JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [{ elastic: elastic._id, quantity: 100000 }] });
  const machine = await M.Machine.create({ ID: `PD-${n}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 8, status: 'running', orderRunning: job._id, elastics: [{ head: 0, elastic: elastic._id }] });
  const operator = await M.Employee.create({ name: `Ravi ${n}`, department: 'weaving' });
  return { machine, operator };
}
const plan = async (date, shiftType = 'DAY') => {
  const l = await loom();
  const res = await post('/shift/create-shift-plan', { date, shiftType, machines: [{ machine: String(l.machine._id), operator: String(l.operator._id) }] });
  return { res, ...l };
};
const dayOf = async (id) => (await M.ShiftPlan.findById(id).lean()).date.toISOString();

/** A plan as older versions stored it: midnight in India on its day, which is 18:30 the evening before in UTC. */
async function oldStylePlan(dateKey, shiftType = 'DAY') {
  const made = await plan(dateKey, shiftType);
  expect(made.res.status).toBe(201);
  const at = new Date(new Date(`${dateKey}T00:00:00.000Z`).getTime() - 5.5 * 3_600_000);
  await M.ShiftPlan.collection.updateOne({ _id: new mongoose.Types.ObjectId(made.res.body.shiftPlanId) }, { $set: { date: at } });
  await M.ShiftDetail.collection.updateMany({ shiftPlan: new mongoose.Types.ObjectId(made.res.body.shiftPlanId) }, { $set: { date: at } });
  return made.res.body.shiftPlanId;
}

describe('the day a new plan is for', () => {
  it('is the day in India of whatever it was sent as', async () => {
    // A date alone.
    const a = await plan('2026-10-23');
    expect(a.res.status).toBe(201);
    expect(await dayOf(a.res.body.shiftPlanId)).toBe('2026-10-23T00:00:00.000Z');
    // The phone's clock, with no zone: that day.
    const b = await plan('2026-10-22T00:00:00.000');
    expect(await dayOf(b.res.body.shiftPlanId)).toBe('2026-10-22T00:00:00.000Z');
    // A moment: 01:00 on the 21st in India, still the 20th in UTC.
    const c = await plan('2026-10-20T19:30:00.000Z');
    expect(c.res.status).toBe(201);
    expect(await dayOf(c.res.body.shiftPlanId)).toBe('2026-10-21T00:00:00.000Z');
    // And so a second plan "for the 21st" is refused, not made beside it.
    const again = await plan('2026-10-21');
    expect(again.res.status).toBe(409);
    // Not a date at all.
    expect((await plan('next tuesday')).res.status).toBe(400);
    expect((await plan('2026-02-30')).res.status).toBe(400);
  });
});

describe('a plan stored the old way (midnight in India)', () => {
  it('is found under its own day by the floor tablet and the slip reader', async () => {
    const id = await oldStylePlan('2026-10-21');
    expect(String((await floor.findPlan('2026-10-21', 'DAY'))?._id)).toBe(id);
    expect(await floor.findPlan('2026-10-20', 'DAY')).toBeNull();
    expect(String((await slips._internals.planFor('2026-10-21', 'DAY'))?._id)).toBe(id);
    expect(await slips._internals.planFor('2026-10-20', 'DAY')).toBeNull();
    // One stored as it is now, the next day: each under its own.
    const next = await plan('2026-10-22');
    expect(String((await floor.findPlan('2026-10-22', 'DAY'))?._id)).toBe(next.res.body.shiftPlanId);
    expect(String((await floor.findPlan('2026-10-21', 'DAY'))?._id)).toBe(id);
    expect(await floor.findPlan('2026-10-21', 'NIGHT')).toBeNull();
    expect(await floor.findPlan('2026-13-01', 'DAY')).toBeNull();
  });

  it('prints its own day on the production sheet', async () => {
    const id = await oldStylePlan('2026-10-21');
    const res = await pdf(`/shift/${id}/production-sheet.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/production-sheet-2026-10-21-DAY\.pdf/);
    const text = await pdfText(res.body);
    expect(text).toMatch(/SP-20261021-D/);
    expect(text).toMatch(/21-Oct-2026/);
    expect(text).not.toMatch(/SP-20261020-D/);
  });

  it('is listed on its own day, and counted on it', async () => {
    const id = await oldStylePlan('2026-10-21');
    await M.ShiftPlan.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { totalProduction: 4200 } });
    const on = (d) => get(`/shift/shiftPlanOnDate?date=${d}`).then((r) => (r.body.shift || r.body.shifts || []).map((s) => String(s._id)));
    expect(await on('21-10-2026')).toEqual([id]);
    expect(await on('20-10-2026')).toEqual([]);
    const range = (a, b) => get(`/shift/get-in-range?start=${a}&less=${b}`).then((r) => r.body.array);
    expect(await range('2026-10-21', '2026-10-21')).toEqual([{ date: '21-10-2026', production: 4200 }]);
    expect(await range('2026-10-19', '2026-10-20')).toEqual([]);
    // With one stored as it is now on the 22nd: both days, each once.
    const next = await plan('2026-10-22');
    await M.ShiftPlan.collection.updateOne({ _id: new mongoose.Types.ObjectId(next.res.body.shiftPlanId) }, { $set: { totalProduction: 100 } });
    expect(await range('2026-10-21', '2026-10-22')).toEqual([{ date: '21-10-2026', production: 4200 }, { date: '22-10-2026', production: 100 }]);
    expect(await range('2026-10-22', '2026-10-22')).toEqual([{ date: '22-10-2026', production: 100 }]);
    expect((await get('/shift/get-in-range?start=2026-02-30&less=2026-03-01')).status).toBe(400);
  });
});

describe('today, in the small hours', () => {
  it('a floor sheet printed with no date at 01:30 is today\'s, not yesterday\'s', async () => {
    await loom();
    jest.useFakeTimers({ now: new Date('2026-10-20T20:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    const res = await pdf('/shift/floor-sheet.pdf');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/FS-20261021-D/);
    expect(text).toMatch(/21-Oct-2026/);
  });

  it('a slip captioned with no year, in the first hours of New Year\'s Day, is this year\'s', () => {
    const at = (iso) => new Date(iso);
    // 01:30 on 1 January 2027 in India.
    expect(slips.parseDateShift('DAY 01-01', at('2026-12-31T20:00:00.000Z'))).toEqual({ dateKey: '2027-01-01', shift: 'DAY' });
    expect(slips.parseDateShift('NIGHT 31-12', at('2026-12-31T20:00:00.000Z'))).toEqual({ dateKey: '2026-12-31', shift: 'NIGHT' });
    // Any other day: this year, or last year when that day has not come yet.
    expect(slips.parseDateShift('DAY 06-10', at('2026-10-07T06:00:00.000Z'))).toEqual({ dateKey: '2026-10-06', shift: 'DAY' });
    expect(slips.parseDateShift('DAY 15-06', at('2027-01-02T06:00:00.000Z'))).toEqual({ dateKey: '2026-06-15', shift: 'DAY' });
    expect(slips.parseDateShift('N 06.10.2026', at('2027-01-02T06:00:00.000Z'))).toEqual({ dateKey: '2026-10-06', shift: 'NIGHT' });
    // A day that does not exist is no day.
    expect(slips.parseDateShift('DAY 31-04', at('2026-10-07T06:00:00.000Z'))).toEqual({ dateKey: null, shift: 'DAY' });
  });
});

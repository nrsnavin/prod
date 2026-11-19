'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN EMPLOYEE'S PAY RATE: WHO MAY SET IT, WHAT IT MAY BE, AND THE
//  RECORD OF EACH CHANGE
//
//  Found reading api/employee.js, api/payroll.js and api/audit.js line
//  by line.
//
//  1. The rate could be set through the employee edit by any login that
//     can open Employees — a floor supervisor's included, so a
//     supervisor could set any rate, their own too. The payroll route
//     for the same field has always been the admin's and accounts'.
//
//  2. The edit took any number: a negative rate, or 1e308. And the web
//     form sends the rate back as (rate × 12) ÷ 12, which is not always
//     the rate: ₹85.35 was stored as 85.34999999999998 by an edit that
//     only corrected a phone number.
//
//  3. Nothing kept a change of rate: who, whose, from what to what.
//
//  4. The audit feed took each document type's entries out by name, one
//     name per query in order. A query added without a name shifted the
//     rest, and the last — material groups — never reached the feed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, User, AccessEvent, MaterialGroup, Payroll, admin, accounts, supervisor;

const cookieOf = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  put:  (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookieOf(u)).send(body),
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookieOf(u)).send(body),
  get:  (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookieOf(u)),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); User = require('../../models/User');
  AccessEvent = require('../../models/AccessEvent'); MaterialGroup = require('../../models/MaterialGroup');
  Payroll = require('../../models/Payroll');
  admin      = await User.create({ name: 'Owner',      email: 'rate-admin@t.co', password: 'pass1234', role: 'admin',      department: 'admin' });
  accounts   = await User.create({ name: 'Accountant', email: 'rate-acc@t.co',   password: 'pass1234', role: 'accounts',   department: 'finance' });
  supervisor = await User.create({ name: 'Supervisor', email: 'rate-sup@t.co',   password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
const makeEmp = (over = {}) => Employee.create({ name: `Weaver ${++n}`, department: 'weaving', phoneNumber: `98000${String(n).padStart(5, '0')}`, hourlyRate: 85.35, ...over });
const rateOf = async (emp) => (await Employee.findById(emp._id).lean()).hourlyRate;
const edit = (user, emp, body) => as(user).put(`/employee/update?id=${emp._id}`, body);
const rateChanges = (emp) => AccessEvent.find({ code: 'PAY_RATE_CHANGED', 'subject.id': String(emp._id) }).sort({ at: 1 }).lean();

// ══════════════════════════════════════════════════════════════════
describe('who may change a pay rate through the employee edit', () => {
  it('not a floor supervisor', async () => {
    const emp = await makeEmp();
    const res = await edit(supervisor, emp, { hourlyRate: 250 });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Only the admin or accounts can change an employee's pay rate");
    expect(await rateOf(emp)).toBe(85.35);
    expect(await rateChanges(emp)).toEqual([]);
  });

  it('a supervisor can still correct the rest of the record — the form sends back the rate it loaded', async () => {
    const emp = await makeEmp();
    // As the web form sends it: the shift's pay, divided by 12 again.
    const asTheFormSendsIt = Number(String(85.35 * 12)) / 12;
    expect(asTheFormSendsIt).not.toBe(85.35);          // 85.34999999999998
    const res = await edit(supervisor, emp, { role: 'Senior weaver', hourlyRate: asTheFormSendsIt });
    expect(res.status).toBe(200);
    expect(res.body.employee.role).toBe('Senior weaver');
    // And the rate is what it was, to the last digit.
    expect(await rateOf(emp)).toBe(85.35);
    expect(await rateChanges(emp)).toEqual([]);
  });

  it('the admin and accounts can', async () => {
    const emp = await makeEmp();
    expect((await edit(accounts, emp, { hourlyRate: 90 })).status).toBe(200);
    expect(await rateOf(emp)).toBe(90);
    expect((await edit(admin, emp, { hourlyRate: '92.5' })).status).toBe(200);
    expect(await rateOf(emp)).toBe(92.5);
  });

  it('an edit that only resends the loaded rate changes nothing, for the admin too', async () => {
    const emp = await makeEmp();
    const res = await edit(admin, emp, { name: 'Renamed', hourlyRate: Number(String(85.35 * 12)) / 12 });
    expect(res.status).toBe(200);
    // Before: stored as 85.34999999999998 by an edit of the name.
    expect(await rateOf(emp)).toBe(85.35);
    expect(await rateChanges(emp)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what a pay rate may be', () => {
  it.each([['a negative', -50], ['words', 'abc'], ['1e308', 1e308], ['more than anybody is paid', 100001], ['true', true]])(
    'the edit refuses %s', async (_what, value) => {
      const emp = await makeEmp();
      const res = await edit(admin, emp, { hourlyRate: value });
      expect(res.status).toBe(400);
      expect(await rateOf(emp)).toBe(85.35);
    });

  it('a blank on the edit leaves the rate alone', async () => {
    const emp = await makeEmp();
    expect((await edit(admin, emp, { name: 'Renamed', hourlyRate: null })).status).toBe(200);
    expect((await edit(admin, emp, { hourlyRate: '' })).status).toBe(200);
    // Before: null was stored, and payroll then had "no rate set".
    expect(await rateOf(emp)).toBe(85.35);
  });

  it('a new employee with a rate that is not one is refused, not registered at ₹0', async () => {
    const res = await as(admin).post('/employee/create-employee', { name: 'New Hand', department: 'weaving', hourlyRate: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^The hourly rate /);
    expect(await Employee.countDocuments({ name: 'New Hand' })).toBe(0);

    const none = await as(admin).post('/employee/create-employee', { name: 'New Hand', department: 'weaving' });
    expect(none.status).toBe(201);
    expect(none.body.employee.hourlyRate).toBe(0);
    const some = await as(admin).post('/employee/create-employee', { name: 'Other Hand', department: 'weaving', hourlyRate: 80 });
    expect(some.body.employee.hourlyRate).toBe(80);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the record of a change of pay rate', () => {
  it('says who changed whose rate, from what to what — through either door', async () => {
    const emp = await makeEmp();
    await edit(accounts, emp, { hourlyRate: 90 });
    await as(admin).post(`/payroll/employees/${emp._id}/rate`, { hourlyRate: 95 });
    const kept = await rateChanges(emp);
    expect(kept.map((e) => [e.actor?.name, e.subject?.name, e.meta])).toEqual([
      ['Accountant', emp.name, { from: 85.35, to: 90 }],
      ['Owner',      emp.name, { from: 90,    to: 95 }],
    ]);
    expect(kept[0].label).toBe('Pay Rate Changed');
  });

  it('nothing is kept when the payroll route is given the rate it already has', async () => {
    const emp = await makeEmp();
    expect((await as(admin).post(`/payroll/employees/${emp._id}/rate`, { hourlyRate: 85.35 })).status).toBe(200);
    expect(await rateChanges(emp)).toEqual([]);
  });

  it('is on the audit page, as a change to the employee', async () => {
    const emp = await makeEmp();
    await edit(admin, emp, { hourlyRate: 120 });
    const res = await as(admin).get('/audit/recent');
    const row = res.body.entries.find((e) => e.code === 'PAY_RATE_CHANGED');
    expect(row).toMatchObject({ entityType: 'Employee', entityId: String(emp._id), entityNo: emp.name, label: 'Pay Rate Changed' });
    expect(row.actor.name).toBe('Owner');
  });

  it('is among the week\'s changes worth a look, with both rates', async () => {
    const emp = await makeEmp();
    await edit(admin, emp, { hourlyRate: 120 });
    const { data } = (await as(admin).get('/audit/watch?days=7')).body;
    const item = data.items.find((i) => i.kind === 'pay');
    expect(item).toMatchObject({ severity: 'check', title: `Pay rate changed: ${emp.name}`, detail: '₹85.35/h to ₹120/h', actor: 'Owner', entityType: 'Employee' });
    expect(data.counts.pay).toBe(1);
    // And in the Monday message to the owner.
    const auditWatch = require('../../services/auditWatch');
    const said = auditWatch.message(await auditWatch.watch({ days: 7 }));
    expect(said).toMatch(/1 pay rates changed/);
    expect(said).toContain(`Pay rate changed: ${emp.name} — Owner (₹85.35/h to ₹120/h)`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the payroll check', () => {
  it('does not call a rate "changed" for a difference no payslip could show', async () => {
    const { flagsFor } = require('../../services/payrollCheck');
    const slip = { netPay: 1000, presentShifts: 1, hourlyRate: 85.34999999999998 };
    const before = [{ netPay: 1000, hourlyRate: 85.35 }];
    // Before: "Hourly rate changed from ₹85 to ₹85".
    expect(flagsFor(slip, before).map((f) => f.code)).not.toContain('rate');
    expect(flagsFor({ ...slip, hourlyRate: 90 }, before).map((f) => f.code)).toContain('rate');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the audit feed', () => {
  it('lists a change to a material group', async () => {
    const { buildFingerprint, ACTION_CODES } = require('../../utils/fingerprint');
    const group = await MaterialGroup.create({ name: 'Warp yarn', code: 'WARP_YARN' });
    await MaterialGroup.updateOne({ _id: group._id }, { $push: { fingerprints: buildFingerprint(ACTION_CODES.MATERIAL_GROUP_CREATED, { entityId: group._id, actor: { id: String(admin._id), name: 'Owner', role: 'admin' } }) } });
    const res = await as(admin).get('/audit/recent');
    expect(res.status).toBe(200);
    // Before: never — the last query's rows were left out of the feed.
    expect(res.body.entries.find((e) => e.entityType === 'MaterialGroup')).toMatchObject({ entityNo: 'WARP_YARN', entityId: String(group._id) });
  });

  it('still lists every other kind it reads', async () => {
    const { buildFingerprint, ACTION_CODES } = require('../../utils/fingerprint');
    const stamp = (id) => buildFingerprint(ACTION_CODES.ORDER_UPDATED, { entityId: id, actor: { id: String(admin._id), name: 'Owner', role: 'admin' } });
    const made = {};
    for (const [model, numberField, value] of [
      ['DepositSlip', 'slipNo', 'DS-1'], ['Journal', 'journalNo', 'JV-1'], ['Quote', 'quoteNo', 'Q-1'], ['StockCount', 'countNo', 'SC-1'],
    ]) {
      const _id = new mongoose.Types.ObjectId();
      await mongoose.connection.collection(require(`../../models/${model}`).collection.collectionName)
        .insertOne({ _id, [numberField]: value, fingerprints: [stamp(_id)] });
      made[model] = value;
    }
    const res = await as(admin).get('/audit/recent');
    const byType = Object.fromEntries(res.body.entries.map((e) => [e.entityType, e.entityNo]));
    expect(byType).toMatchObject(made);
  });
});

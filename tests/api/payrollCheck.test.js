'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYROLL, CHECKED BEFORE THE MONEY GOES OUT
//
//  Each slip against the worker's own last three months, with the reason
//  in figures. Nothing is changed; what is flagged is looked at before
//  it is paid.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, prod, Payroll, Employee, svc;
const as = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const slip = (employee, year, month, over = {}) => ({
  employee, year, month, hourlyRate: 60, presentShifts: 24, halfDayShifts: 0, netPay: 15000,
  grossEarnings: 16000, totalDeductions: 1000, totalOvertimeMinutes: 300, unapprovedAbsents: 0, status: 'paid', ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Payroll = require('../../models/Payroll');
  Employee = require('../../models/Employee');
  svc = require('../../services/payrollCheck');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'pk@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prod = await User.create({ name: 'Sup', email: 'pk2@t.co', password: 'pass1234', role: 'production', department: 'production' });
  const [steady, jumpy, idle, newbie, overtime] = await Employee.create([
    { name: 'Steady' }, { name: 'Jumpy' }, { name: 'Idle' }, { name: 'Newbie' }, { name: 'Overtime' },
  ]);
  const months = [[2026, 8], [2026, 9], [2026, 10]];
  const past = [];
  for (const e of [steady, jumpy, idle, overtime]) for (const [y, m] of months) past.push(slip(e._id, y, m));
  await Payroll.insertMany([
    ...past,
    slip(steady._id, 2026, 11, { status: 'draft', netPay: 15400 }),
    slip(jumpy._id, 2026, 11, { status: 'draft', netPay: 22000, hourlyRate: 70 }),
    slip(idle._id, 2026, 11, { status: 'draft', presentShifts: 0, netPay: 4000 }),
    slip(newbie._id, 2026, 11, { status: 'draft' }),
    slip(overtime._id, 2026, 11, { status: 'draft', totalOvertimeMinutes: 40 * 60 }),
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const flagsOf = (rows, name) => (rows.find((r) => r.name === name)?.flags || []).map((f) => f.code);

describe('the month\'s payslips, checked', () => {
  let data;
  beforeAll(async () => {
    const res = await request(app).get('/api/v2/payroll/check?year=2026&month=11').set('Cookie', as(admin));
    expect(res.status).toBe(200);
    data = res.body.data;
  });

  it('leaves an ordinary month alone', () => {
    expect(flagsOf(data.rows, 'Steady')).toEqual([]);
  });

  it('flags a jump on the worker\'s own average, and the rate change behind it', () => {
    expect(flagsOf(data.rows, 'Jumpy')).toEqual(expect.arrayContaining(['jump', 'rate']));
    const jump = data.rows.find((r) => r.name === 'Jumpy').flags.find((f) => f.code === 'jump');
    expect(jump.reason).toMatch(/up 47% on the last 3 months' average of ₹15,000/);
  });

  it('puts pay with no shift worked first, as high', () => {
    expect(data.rows[0].name).toBe('Idle');
    expect(data.rows[0].flags[0]).toMatchObject({ code: 'no-work-pay', severity: 'high' });
  });

  it('flags overtime far above the usual', () => {
    expect(flagsOf(data.rows, 'Overtime')).toContain('overtime');
  });

  it('says when there is nothing to compare with', () => {
    expect(flagsOf(data.rows, 'Newbie')).toEqual(['first']);
  });

  it('counts by severity for the summary', () => {
    expect(data.summary).toMatchObject({ slips: 5, high: 1 });
  });
});

describe('who may see it', () => {
  it('is for admin and accounts', async () => {
    expect((await request(app).get('/api/v2/payroll/check?year=2026&month=11').set('Cookie', as(prod))).status).toBe(403);
  });

  it('asks for a month', async () => {
    expect((await request(app).get('/api/v2/payroll/check').set('Cookie', as(admin))).status).toBe(400);
  });
});

describe('the rules on their own', () => {
  it('flags negative pay as high', () => {
    expect(svc.flagsFor(slip(null, 2026, 11, { netPay: -500 }), [slip(null, 2026, 10)])[0]).toMatchObject({ code: 'negative', severity: 'high' });
  });

  it('does not call a small change a jump', () => {
    expect(svc.flagsFor(slip(null, 2026, 11, { netPay: 2400 }), [slip(null, 2026, 10, { netPay: 1600 })]).map((f) => f.code)).not.toContain('jump');
  });
});

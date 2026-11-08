'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CHANGES WORTH A SECOND LOOK
//
//  The audit trail holds every change; this picks out the ones that are
//  either mistakes or how money and stock go missing — and says who,
//  when and on which document.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, svc, admin, prod;
const now = new Date('2026-11-09T04:00:00Z'); // Monday 09:30 IST
const DAY = 86_400_000;
const ago = (d, h = 0) => new Date(now.getTime() - d * DAY - h * 3_600_000);
const fp = (code, at, actor = { name: 'Kumar', role: 'accounts' }, meta = {}) => ({ code, label: code, at, actor, meta, shortId: 'x', hash: 'x' });
const as = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  svc = require('../../services/auditWatch');
  const M = (n) => require(`../../models/${n}`);
  const User = M('User');
  admin = await User.create({ name: 'Owner', email: 'aw@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prod = await User.create({ name: 'Sup', email: 'aw2@t.co', password: 'pass1234', role: 'production', department: 'production' });
  await M('Invoice').collection.insertOne({ invoiceNumber: 'INV-101', invoiceDate: ago(3), createdAt: ago(3), totals: { grand: 50000 }, fingerprints: [fp('INVOICE_CREATED', ago(3)), fp('INVOICE_CANCELLED', ago(2), { name: 'Kumar' }, { auditReason: 'Wrong rate' })] });
  // 23:30 IST on Saturday = 18:00 UTC
  await M('Order').collection.insertOne({ orderNo: 9101, fingerprints: [fp('ORDER_DELETED', new Date('2026-11-07T18:00:00Z'), { name: 'Ravi' })] });
  await M('JobOrder').collection.insertOne({ jobOrderNo: 3101, fingerprints: [fp('SHIFT_PRODUCTION_EDITED', ago(1), { name: 'Sup' })] });
  // Entered this week, dated forty days back.
  await M('Payment').collection.insertOne({ voucherNo: 'PV-77', date: ago(40), amount: 120000, createdAt: ago(1), fingerprints: [fp('PAYMENT_POSTED', ago(1), { name: 'Kumar' })] });
  // Routine and last month: not this week's business.
  await M('Payment').collection.insertOne({ voucherNo: 'PV-78', date: ago(1), amount: 500, createdAt: ago(1), fingerprints: [fp('PAYMENT_POSTED', ago(1))] });
  await M('Invoice').collection.insertOne({ invoiceNumber: 'INV-90', invoiceDate: ago(20), createdAt: ago(20), fingerprints: [fp('INVOICE_CANCELLED', ago(20))] });
  await M('AccessEvent').create({ code: 'LOGIN_DELETED', label: 'Login Deleted', at: ago(2), actor: { name: 'Owner' }, subject: { name: 'Old Clerk', email: 'old@t.co' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the week\'s changes worth a look', () => {
  let w;
  beforeAll(async () => { w = await svc.watch({ days: 7, now }); });
  const kinds = () => w.items.map((i) => i.kind);

  it('names the cancelled invoice, who did it and why', () => {
    const c = w.items.find((i) => i.kind === 'cancelled');
    expect(c).toMatchObject({ actor: 'Kumar', entityNo: 'INV-101', detail: 'Reason: Wrong rate' });
  });

  it('finds the deletion, and that it was done late at night', () => {
    expect(kinds()).toContain('deleted');
    const late = w.items.find((i) => i.kind === 'late-night');
    expect(late.title).toMatch(/Ravi made 1 change between 10 pm and 5 am/);
  });

  it('finds verified production edited afterwards', () => {
    expect(w.items.find((i) => i.kind === 'edited')).toMatchObject({ actor: 'Sup', entityNo: 3101 });
  });

  it('finds a payment entered this week but dated forty days back', () => {
    const b = w.items.find((i) => i.kind === 'backdated');
    expect(b).toMatchObject({ entityNo: 'PV-77', severity: 'check' });
    expect(b.detail).toMatch(/₹1,20,000/);
  });

  it('finds the login removed', () => {
    expect(w.items.find((i) => i.kind === 'access').title).toMatch(/Old Clerk/);
  });

  it('leaves routine entries and last month\'s changes out', () => {
    expect(w.items.some((i) => i.entityNo === 'PV-78')).toBe(false);
    expect(w.items.some((i) => i.entityNo === 'INV-90')).toBe(false);
  });

  it('writes the owner a short summary', () => {
    const text = svc.message(w);
    expect(text).toMatch(/Changes worth a look/);
    expect(text).toMatch(/1 cancelled/);
    expect(text).toMatch(/INV-101 cancelled — Kumar/);
  });
});

describe('who may see it', () => {
  it('is on the audit page for the admin, not for production', async () => {
    expect((await request(app).get('/api/v2/audit/watch').set('Cookie', as(admin))).status).toBe(200);
    expect((await request(app).get('/api/v2/audit/watch').set('Cookie', as(prod))).status).toBe(403);
  });
});

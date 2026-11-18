'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GSTIN IS ONE SUPPLIER'S ONLY — and the form is told so in words
//
//  A second supplier with a GSTIN already on file was refused with the
//  database's own sentence ("E11000 duplicate key error collection: …
//  index: gstin_1 dup key: { gstin: … }"), which the web and the phone
//  both showed as it came.
//
//    • adding one, and changing one to another's GSTIN, say "A supplier
//      with this GSTIN is already on file."
//    • any other refusal still says what it said
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Supplier, owner;
const GSTIN = '33BQWPK4321M1ZF';
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const create = (body) => request(app).post('/api/v2/supplier/create-supplier').set('Cookie', cookie(owner)).send(body);
const edit = (body) => request(app).put('/api/v2/supplier/edit-supplier').set('Cookie', cookie(owner)).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Supplier = require('../../models/Supplier.js');
  await Supplier.init(); // the unique index on gstin
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { owner = await User.create({ name: 'Owner', email: 'owner@t.co', password: 'pass1234', role: 'admin', department: 'admin' }); });
afterEach(async () => { await Promise.all([User.deleteMany({}), Supplier.deleteMany({})]); });

describe('a GSTIN already on file', () => {
  it('a second supplier with it is refused in words', async () => {
    expect((await create({ name: 'Sri Kumar Yarn Traders', phoneNumber: '9000000002', gstin: GSTIN })).status).toBe(201);
    const res = await create({ name: 'Kumar Yarns', phoneNumber: '9000000003', gstin: GSTIN });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('A supplier with this GSTIN is already on file.');
    expect(await Supplier.countDocuments()).toBe(1);
  });

  it('changing a supplier to another\'s GSTIN is refused in the same words', async () => {
    await create({ name: 'Sri Kumar Yarn Traders', phoneNumber: '9000000002', gstin: GSTIN });
    const other = (await create({ name: 'Kumar Yarns', phoneNumber: '9000000003' })).body.supplier;
    const res = await edit({ _id: other._id, gstin: GSTIN });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('A supplier with this GSTIN is already on file.');
    expect((await Supplier.findById(other._id).lean()).gstin).toBeUndefined();
  });

  it('two suppliers with no GSTIN are both kept', async () => {
    expect((await create({ name: 'Local Cones', phoneNumber: '9000000004' })).status).toBe(201);
    expect((await create({ name: 'Local Tapes', phoneNumber: '9000000005', gstin: '' })).status).toBe(201);
  });

  it('any other refusal still says what it said', async () => {
    const res = await create({ name: 'No Contact' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('at least one of phoneNumber or email is required');
  });
});

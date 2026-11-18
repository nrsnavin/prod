'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE OWNER FROM BEFORE DEPARTMENTS, AND WHAT A PHONE LEARNS ON OPENING
//
//  A login made before departments existed has only a role. The Users
//  form (web and phone) opened such a login as "Production", so saving
//  anything on it — a corrected name — sent department "production" and
//  the owner stopped being an admin. The guard against demoting the last
//  admin looked only at the department, which they did not have, so it
//  let the last admin go.
//
//    • an admin by role alone counts as an admin: the last one cannot be
//      demoted, with or without a department
//    • nobody takes admin away from their own login (another admin can)
//    • another admin still can, and an ordinary edit still saves
//
//  And the phone app, signed in for months, asks GET /user/getuser each
//  time it opens. That answer now carries the effective feature list, so
//  a module given since (or taken away) reaches the phone's menu.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, features;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const put = (as, id, body) => request(app).put(`/api/v2/user/manage/${id}`).set('Cookie', cookie(as)).send(body);

/** A login as it was stored before departments existed. */
async function legacy(name, email, role, extra = {}) {
  const u = await User.create({ name, email, password: 'pass1234', role, ...extra });
  await User.collection.updateOne({ _id: u._id }, { $unset: { department: '' } });
  return User.findById(u._id);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  features = require('../../utils/features');
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await User.deleteMany({}); });

describe('PUT /user/manage/:id — an admin by role alone', () => {
  it('the last admin is not demoted by a form that opened them as Production', async () => {
    const owner = await legacy('Owner', 'owner@t.co', 'admin');
    // What the Users form sent: the name the admin corrected, and the
    // department it had shown.
    const res = await put(owner, owner._id, { name: 'Owner B', department: 'production', features: features.featuresForDepartment('production') });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cannot remove the last admin');
    const stored = await User.findById(owner._id).lean();
    expect(stored.role).toBe('admin');
    expect(stored.department).toBeUndefined();
    expect(stored.name).toBe('Owner'); // nothing half-applied
  });

  it('an admin does not take admin away from their own login', async () => {
    const owner = await legacy('Owner', 'owner@t.co', 'admin');
    const second = await User.create({ name: 'Second', email: 'second@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
    for (const self of [owner, second]) {
      const res = await put(self, self._id, { department: 'finance' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/your own login/);
      expect((await User.findById(self._id).lean()).role).toBe('admin');
    }
  });

  it('another admin can, and the role follows the department', async () => {
    const owner = await legacy('Owner', 'owner@t.co', 'admin');
    const second = await User.create({ name: 'Second', email: 'second@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
    const res = await put(second, owner._id, { department: 'finance', features: features.featuresForDepartment('finance') });
    expect(res.status).toBe(200);
    const stored = await User.findById(owner._id).lean();
    expect([stored.department, stored.role]).toEqual(['finance', 'accounts']);
  });

  it('CONTROL: saved as Admin, the old owner gets the department and keeps everything', async () => {
    const owner = await legacy('Owner', 'owner@t.co', 'admin', { features: [...features.FEATURE_KEYS] });
    const res = await put(owner, owner._id, { name: 'Owner B', department: 'admin', features: [...features.FEATURE_KEYS] });
    expect(res.status).toBe(200);
    const stored = await User.findById(owner._id).lean();
    expect([stored.name, stored.department, stored.role]).toEqual(['Owner B', 'admin', 'admin']);
    expect(stored.features.sort()).toEqual([...features.FEATURE_KEYS].sort());
  });

  it('CONTROL: an edit that does not touch the department is not stopped', async () => {
    const owner = await legacy('Owner', 'owner@t.co', 'admin');
    const res = await put(owner, owner._id, { name: 'Owner C' });
    expect(res.status).toBe(200);
    expect((await User.findById(owner._id).lean()).name).toBe('Owner C');
  });
});

describe('GET /user/getuser — what the phone learns each time it opens', () => {
  const open = (u) => request(app).get('/api/v2/user/getuser').set('X-Client', 'mobile').set('Cookie', cookie(u));

  it('carries the login\'s own feature list, as it stands now', async () => {
    const packer = await User.create({
      name: 'Selvam', email: 'selvam@t.co', password: 'pass1234', role: 'production', department: 'packing',
      features: ['/', '/settings', '/packing'],
    });
    expect((await open(packer)).body.features).toEqual(['/', '/settings', '/packing']);

    // The office gives them the dispatch queue; the phone is not signed in again.
    await User.updateOne({ _id: packer._id }, { $set: { features: ['/', '/settings', '/packing', '/dispatch'] } });
    const again = await open(packer);
    expect(again.status).toBe(200);
    expect(again.body.features).toEqual(['/', '/settings', '/packing', '/dispatch']);
    expect(typeof again.body.token).toBe('string'); // the renewal is as it was
  });

  it('a login with no list stored gets its department\'s, and a role-only one its role\'s', async () => {
    const marketing = await User.create({ name: 'Meena', email: 'meena@t.co', password: 'pass1234', role: 'marketing', department: 'marketing' });
    await User.collection.updateOne({ _id: marketing._id }, { $unset: { features: '' } });
    expect((await open(marketing)).body.features.sort()).toEqual(features.featuresForDepartment('marketing').sort());
    expect(features.featuresForDepartment('marketing')).toContain('/dispatch');

    const owner = await legacy('Owner', 'owner@t.co', 'admin');
    await User.collection.updateOne({ _id: owner._id }, { $unset: { features: '' } });
    expect((await open(owner)).body.features.sort()).toEqual([...features.FEATURE_KEYS].sort());
  });

  it('an explicitly empty list is sent as empty: granted nothing', async () => {
    const nobody = await User.create({ name: 'Nobody', email: 'nobody@t.co', password: 'pass1234', role: 'production', department: 'production', features: [] });
    expect((await open(nobody)).body.features).toEqual([]);
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ELASTIC GROUP'S LINES
//
//  Found reading api/elasticGroup.js line by line. A group is a saved
//  bundle of elastics the order form drops onto an order in one go.
//
//  1. ONE ELASTIC COULD BE ON A GROUP TWICE. Adding from the elastic
//     list's selection guards against it; creating or editing a group
//     did not. An order refuses the same elastic on two lines — so the
//     bundle filled the order form with a pair of lines the order then
//     would not save.
//
//  2. A GROUP DID NOT SAY WHICH OF ITS ELASTICS HAD BEEN RETIRED. An
//     archived elastic is out of every picker, but a group that named
//     it still put it on new orders.
//
//  3. A name that is not text was a server error, and a group could be
//     tied to a customer who does not exist.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const call = (method, url, body) => {
  const r = request(app)[method](`/api/v2/elastic-group${url}`).set('Cookie', cookie());
  return body === undefined ? r : r.send(body);
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Elastic', 'ElasticGroup', 'Customer']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'elastic-groups@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const elastic = (over = {}) => M.Elastic.create({ name: `20mm ${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, ...over });
const line = (e, defaultQuantity = 500) => ({ elastic: String(e._id), defaultQuantity });

describe('a group\'s lines', () => {
  it('cannot name one elastic twice when the group is made', async () => {
    const a = await elastic();
    const b = await elastic();
    const res = await call('post', '/', { name: 'Ravi usual', items: [line(a), line(b), line(a, 250)] });
    // Before: 201 — and an order filled from it had two lines for one elastic.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/items\[2\].*already on the list/);
    expect(await M.ElasticGroup.countDocuments({})).toBe(0);
  });

  it('nor when it is edited', async () => {
    const a = await elastic();
    const b = await elastic();
    const made = await call('post', '/', { name: 'Ravi usual', items: [line(a), line(b)] });
    expect(made.status).toBe(201);
    const res = await call('put', `/${made.body.group._id}`, { items: [line(a), line(a)] });
    expect(res.status).toBe(400);
    expect((await M.ElasticGroup.findById(made.body.group._id).lean()).items).toHaveLength(2);
  });

  it('are kept in the order given, with their quantities (unchanged)', async () => {
    const a = await elastic();
    const b = await elastic();
    const res = await call('post', '/', { name: 'Ravi usual', items: [line(b, 250), line(a, 'many')] });
    expect(res.status).toBe(201);
    expect(res.body.group.items.map((i) => [String(i.elastic._id), i.defaultQuantity])).toEqual([[String(b._id), 250], [String(a._id), 0]]);
  });

  it('say which of their elastics have been retired', async () => {
    const live = await elastic();
    const retired = await elastic({ archived: true });
    const group = await M.ElasticGroup.create({ name: 'Ravi usual', items: [line(live), line(retired)] });

    const listed = (await call('get', '/')).body.groups[0];
    // Before: nothing to tell them apart, and the order form added both.
    expect(listed.items.map((i) => !!i.elastic.archived)).toEqual([false, true]);
    const one = (await call('get', `/${group._id}`)).body.group;
    expect(one.items.map((i) => !!i.elastic.archived)).toEqual([false, true]);
  });
});

describe('a group', () => {
  it.each([
    ['a number', 42],
    ['a list', ['Ravi usual']],
    ['nothing but spaces', '   '],
  ])('needs a name that is text: %s is refused', async (_what, name) => {
    const a = await elastic();
    const res = await call('post', '/', { name, items: [line(a)] });
    // Before: a server error for the first two.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name/);
  });

  it('is renamed with text only', async () => {
    const a = await elastic();
    const made = await call('post', '/', { name: 'Ravi usual', items: [line(a)] });
    expect((await call('put', `/${made.body.group._id}`, { name: 42 })).status).toBe(400);
    expect((await call('put', `/${made.body.group._id}`, { name: '  Ravi weekly ' })).body.group.name).toBe('Ravi weekly');
  });

  it('is tied to a customer who exists, or to none', async () => {
    const a = await elastic();
    const stranger = String(new mongoose.Types.ObjectId());
    const res = await call('post', '/', { name: 'Ravi usual', customer: stranger, items: [line(a)] });
    // Before: saved against a customer nobody can open.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/customer that exists/i);

    const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000002' });
    const ok = await call('post', '/', { name: 'Ravi usual', customer: String(customer._id), items: [line(a)] });
    expect(ok.status).toBe(201);
    expect(ok.body.group.customer.name).toBe('Acme');
    const moved = await call('put', `/${ok.body.group._id}`, { customer: stranger });
    expect(moved.status).toBe(400);
    expect((await call('put', `/${ok.body.group._id}`, { customer: '' })).body.group.customer).toBeNull();
  });
});

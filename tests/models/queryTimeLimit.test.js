'use strict';
// ══════════════════════════════════════════════════════════════════
//  NO READ RUNS FOREVER — models/plugins/queryTimeLimit.js
//
//  Every read the server makes carries a time limit; writes never do;
//  a query that sets its own keeps it; a read that runs past the limit
//  is really stopped by the database, and answers 503 with a plain
//  message rather than a 500.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, Item, seen;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  require('../../app.js'); // registers the plugin, as the server does
  Item = mongoose.model('QtlItem', new mongoose.Schema({ n: Number }));
  await Item.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
  // Record the options each operation reaches the driver with.
  mongoose.set('debug', (coll, method, ...args) => {
    if (coll === Item.collection.collectionName) seen.push({ method, args });
  });
}, 120_000);

afterAll(async () => {
  mongoose.set('debug', false);
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  seen = [];
  delete process.env.DB_QUERY_MAX_MS;
});

const optionsOf = (method) => {
  const call = seen.find((s) => s.method === method);
  // find(filter, projection, options) · aggregate(pipeline, options) · countDocuments(filter, options)
  return call.args.find((a) => a && typeof a === 'object' && 'maxTimeMS' in a) || {};
};

describe('the limit', () => {
  it('is on every read by default: 30 s', async () => {
    await Item.find({});
    await Item.findOne({ n: 1 });
    await Item.countDocuments({});
    await Item.aggregate([{ $match: {} }]);
    for (const m of ['find', 'findOne', 'countDocuments', 'aggregate']) {
      expect(optionsOf(m).maxTimeMS).toBe(30_000);
    }
  });

  it('is never on a write', async () => {
    await Item.updateMany({}, { $inc: { n: 0 } });
    await Item.findOneAndUpdate({ n: 1 }, { $set: { n: 1 } });
    for (const s of seen) {
      expect(JSON.stringify(s.args)).not.toMatch(/maxTimeMS/);
    }
  });

  it('leaves a query that asks for its own alone', async () => {
    await Item.find({}).maxTimeMS(120_000);
    await Item.aggregate([{ $match: {} }]).option({ maxTimeMS: 90_000 });
    expect(optionsOf('find').maxTimeMS).toBe(120_000);
    expect(optionsOf('aggregate').maxTimeMS).toBe(90_000);
  });

  it('can be changed, or turned off', async () => {
    process.env.DB_QUERY_MAX_MS = '5000';
    await Item.find({});
    expect(optionsOf('find').maxTimeMS).toBe(5000);
    seen = [];
    process.env.DB_QUERY_MAX_MS = '0';
    await Item.find({});
    expect(optionsOf('find').maxTimeMS).toBeUndefined();
  });
});

describe('a read that runs past it', () => {
  it('is stopped by the database', async () => {
    process.env.DB_QUERY_MAX_MS = '50';
    // Server-side JavaScript that sleeps 300 ms per document.
    const err = await Item.find({ $where: 'sleep(300) || true' }).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(err.code === 50 || err.codeName === 'MaxTimeMSExpired').toBe(true);
  });

  it('answers 503 with a plain message', () => {
    const errorMiddleware = require('../../middleware/error.js');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const err = Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    errorMiddleware(err, { method: 'GET', originalUrl: '/x', headers: {} }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].message).toMatch(/took too long/);
  });
});

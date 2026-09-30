'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A RENDERER SEES ON THE OTHER SIDE OF THE THREAD
//
//  PDFs now render on worker threads, and the only thing that can make
//  a worker's output differ from the main thread's is the INPUT after
//  it crosses: the builder code is the same module either way.
//
//  The concrete case: the shift sheet passes each ShiftDetail's _id as
//  `sdId`, and prints it twice per row — in the QR code that the
//  scan-back upload matches rows by, and as the SD-XXXXXX short code.
//  Structured clone turns an ObjectId into a plain object, which prints
//  as "[object Object]". Without normalising, every QR code on every
//  sheet would have encoded the wrong id, and nothing would have failed
//  until somebody scanned one.
//
//  These tests go through a REAL worker thread, not a simulation of one.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { toCloneable } = require('../../utils/cloneable');
const { runJob, closePool } = require('../../utils/workerPool');
const { shortCode } = require('../../utils/shiftSheetPdf');

let mongo, YarnLot;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  YarnLot = require('../../models/YarnLot');
}, 180_000);

afterAll(async () => {
  await closePool();
  await mongoose.disconnect();
  await mongo.stop();
});

/** Send a value across the thread boundary and back, as renderPdf does. */
const across = (v) => runJob('pool.selfTest', ['echo', toCloneable(v)]).then((r) => r.value);

describe('an ObjectId', () => {
  it('really does break when cloned raw — the control', async () => {
    // Verified, not assumed: this is the failure the normaliser exists for.
    const id = new mongoose.Types.ObjectId();
    const raw = await runJob('pool.selfTest', ['echo', id]).then((r) => r.value);
    expect(`${raw}`).not.toBe(id.toHexString());
  });

  it('prints the same on the other side', async () => {
    const id = new mongoose.Types.ObjectId();
    expect(`${await across(id)}`).toBe(id.toHexString());
  });

  it('gives the shift sheet the same QR payload and short code', async () => {
    const id = new mongoose.Types.ObjectId();
    const row = { sdId: id, machine: 'M-07', job: 'J-1042' };
    const there = await across({ rows: [row] });
    const r = there.rows[0];
    expect(`SHIFTROW|${r.sdId}|M:${r.machine}|J:${r.job}`).toBe(`SHIFTROW|${id}|M:M-07|J:J-1042`);
    expect(shortCode(r.sdId)).toBe(shortCode(id));
  });
});

describe('Mongoose documents', () => {
  it('arrive as their fields, not their internals — lean', async () => {
    const lot = await YarnLot.create({
      rawMaterial: new mongoose.Types.ObjectId(), lotNo: 'D-4471', shade: 'Ecru',
      receivedQty: 100, consumedQty: 40, status: 'open', receivedDate: new Date('2026-03-01'),
    });
    const lean = await YarnLot.findById(lot._id).lean();
    const there = await across(lean);
    expect(there.lotNo).toBe('D-4471');
    expect(`${there._id}`).toBe(`${lot._id}`);
    expect(`${there.rawMaterial}`).toBe(`${lean.rawMaterial}`);
  });

  it('arrive as their fields, virtuals included — hydrated', async () => {
    // A hydrated document cloned raw arrives as $__ and _doc: every field
    // a renderer reads would be undefined. `balance` is a virtual.
    const lot = await YarnLot.create({
      rawMaterial: new mongoose.Types.ObjectId(), lotNo: 'D-9', shade: 'Navy',
      receivedQty: 100, consumedQty: 40, status: 'open', receivedDate: new Date('2026-03-01'),
    });
    const doc = await YarnLot.findById(lot._id);
    const there = await across(doc);
    expect(there.lotNo).toBe('D-9');
    expect(there.balance).toBe(doc.balance);
    expect(there.balance).toBe(60);
    expect(there.$__).toBeUndefined();
  });
});

describe('everything else a renderer is given', () => {
  it('keeps Dates as Dates', async () => {
    const d = new Date('2026-06-10T06:00:00Z');
    const there = await across({ d });
    // Realm-safe: a Date built by the worker's deserialiser is a Date,
    // but not an instance of the jest sandbox's Date constructor.
    expect(Object.prototype.toString.call(there.d)).toBe('[object Date]');
    expect(there.d.toISOString()).toBe(d.toISOString());
  });

  it('keeps Buffers — a logo, say — as bytes', async () => {
    const there = await across({ logo: Buffer.from([1, 2, 3]) });
    expect(Array.from(there.logo)).toEqual([1, 2, 3]);
  });

  it('prints Decimal128 the same', async () => {
    const dec = mongoose.Types.Decimal128.fromString('1234.50');
    expect(`${await across(dec)}`).toBe(dec.toString());
  });

  it('drops functions instead of failing to clone', async () => {
    // A function in the payload makes structured clone throw outright.
    const there = await across({ a: 1, fn: () => 1 });
    expect(there).toEqual({ a: 1 });
  });

  it('survives a cycle', () => {
    const a = { name: 'a' };
    a.self = a;
    const c = toCloneable(a);
    expect(c.self).toBe(c);
  });

  it('leaves plain data exactly as it was', async () => {
    const plain = { n: 1.5, s: 'x', b: true, z: null, list: [1, 'two', { three: 3 }], nested: { deep: { deeper: ['ok'] } } };
    expect(await across(plain)).toEqual(plain);
  });
});

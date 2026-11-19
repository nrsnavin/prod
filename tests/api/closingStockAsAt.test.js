'use strict';
// ══════════════════════════════════════════════════════════════════
//  CLOSING STOCK, AS AT A DAY
//
//  Found following the material archive rule into services/closingStock.js
//  (GET/POST /accounts/closing-stock — the journal that tells the books
//  what is on the shelf).
//
//  1. FINISHED GOODS WERE NEVER WORKED BACK TO THE DAY. Stock "as at" a
//     day is today's figure less everything that moved after it. For
//     elastic the movements were read off a list on the elastic itself —
//     a list nothing has written to since movements were given their own
//     records (models/StockMovement.js). So nothing was ever "after":
//     valued on 10 April as at 31 March, finished goods were simply what
//     stood on the shelf on 10 April. An elastic packed and sent since
//     was missing altogether.
//
//  2. STOCK WITH A RETIRED NAME WAS LEFT OUT. Archiving a material or an
//     elastic takes it out of the pickers; it does not take the goods
//     off the shelf. The valuation skipped anything archived, and its
//     stock left the books.
//
//  3. THE DAY ENDED AT HALF PAST FIVE THE NEXT MORNING. The cut was
//     midnight by the server's clock; yarn issued on the night shift at
//     2 a.m. on 1 April was counted as gone on 31 March.
//
//  4. A WRONG-WAY ROW WAS TAKEN AT ITS WORD. Order approvals were once
//     written to the material's list as a positive quantity though they
//     take stock out; the list's own reader corrects for that, and this
//     sum did not.
//
//  5. A LIST THAT HAD RUN OUT SAID NOTHING. A material keeps its last 500
//     movements. Past that the figure cannot be worked back to the day,
//     and the valuation gave one anyway, without a word.
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
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'RawMaterial', 'Elastic', 'Costing', 'StockMovement', 'Journal']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'closing-stock@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const DAY = '2026-09-30';
const valuation = async (asOf = DAY) => {
  const res = await get(`/accounts/closing-stock?asOf=${asOf}`);
  if (res.status >= 400) throw new Error(`valuation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const yarn = (over = {}) => M.RawMaterial.create({ name: 'Nylon 70D', category: 'warp', unit: 'kg', stock: 100, avgCost: 300, price: 320, ...over });
let seq = 0;
/** An elastic costed at ₹4 a metre. */
async function elastic(over = {}) {
  seq += 1;
  const e = await M.Elastic.create({ name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 0, ...over });
  const c = await M.Costing.create({ elastic: e._id, totalCost: 4, status: 'Final' });
  await M.Elastic.updateOne({ _id: e._id }, { costing: c._id });
  return e;
}
const moved = (e, type, applied, date) => M.StockMovement.create({
  elastic: e._id, type, requested: applied, applied, balance: 0, date: new Date(date),
});
const rowFor = (list, doc) => list.rows.find((r) => String(r.id) === String(doc._id));

// ══════════════════════════════════════════════════════════════════
describe('finished goods as at a day', () => {
  it('are today\'s stock less what was packed, and plus what was sent, since', async () => {
    const e = await elastic({ stock: 800 });
    await moved(e, 'PACKING_INWARD', 500, '2026-10-05T06:00:00Z');
    await moved(e, 'DC_OUT', -200, '2026-10-06T06:00:00Z');
    await moved(e, 'PACKING_INWARD', 300, '2026-09-20T06:00:00Z');   // before the day: already in 800

    const row = rowFor((await valuation()).finishedGoods, e);
    // 800 today, +300 net since the day: 500 on the day. Before: 800, ₹3,200.
    expect(row).toMatchObject({ quantity: 500, rate: 4, value: 2000 });
  });

  it('include an elastic that has all gone since', async () => {
    const e = await elastic({ stock: 0 });
    await moved(e, 'DC_OUT', -300, '2026-10-03T06:00:00Z');
    const v = await valuation();
    // Before: not on the list at all — nothing on the shelf today.
    expect(rowFor(v.finishedGoods, e)).toMatchObject({ quantity: 300, value: 1200 });
    expect(v.finishedGoods.total).toBe(1200);
  });

  it('leave out an elastic that only came in afterwards', async () => {
    const e = await elastic({ stock: 400 });
    await moved(e, 'PACKING_INWARD', 400, '2026-10-02T06:00:00Z');
    // Before: 400 m, ₹1,600 of goods that did not exist on the day.
    expect(rowFor((await valuation()).finishedGoods, e)).toBeUndefined();
  });

  it('a promise to a customer moves no goods', async () => {
    const e = await elastic({ stock: 800 });
    await M.StockMovement.create({ elastic: e._id, type: 'RESERVATION_HOLD', requested: 0, applied: 0, reservedRequested: 600, reservedApplied: 600, balance: 800, date: new Date('2026-10-04T06:00:00Z') });
    expect(rowFor((await valuation()).finishedGoods, e).quantity).toBe(800);
  });

  it('valued today are what is on the shelf (unchanged)', async () => {
    const e = await elastic({ stock: 800 });
    await moved(e, 'PACKING_INWARD', 500, '2026-10-05T06:00:00Z');
    const today = new Date().toISOString().slice(0, 10);
    expect(rowFor((await valuation(today)).finishedGoods, e).quantity).toBe(800);
  });
});

describe('stock under a retired name', () => {
  it('is still stock: an archived material is valued', async () => {
    const m = await yarn({ archived: true, archivedAt: new Date() });
    const v = await valuation();
    // Before: left out — 100 kg, ₹30,000, gone from the books.
    expect(rowFor(v.rawMaterials, m)).toMatchObject({ quantity: 100, value: 30000 });
    expect(v.rawMaterials.total).toBe(30000);
  });

  it('and so is an archived elastic', async () => {
    const e = await elastic({ stock: 250, archived: true });
    expect(rowFor((await valuation()).finishedGoods, e)).toMatchObject({ quantity: 250, value: 1000 });
  });

  it('a retired material with nothing on the shelf is not listed', async () => {
    const m = await yarn({ stock: 0, archived: true });
    expect(rowFor((await valuation()).rawMaterials, m)).toBeUndefined();
  });
});

describe('where the day ends', () => {
  it('is midnight in the factory: 2 a.m. the next morning is the next day', async () => {
    const m = await yarn({
      stock: 100,
      stockMovements: [
        // 02:00 on 1 October in India — the night shift drawing yarn.
        { date: new Date('2026-09-30T20:30:00Z'), type: 'JOB_CONSUMPTION', quantity: -20 },
        // 23:00 on 30 September in India — still the day.
        { date: new Date('2026-09-30T17:30:00Z'), type: 'JOB_CONSUMPTION', quantity: -5 },
      ],
    });
    // 100 now; the 20 drawn at 2 a.m. was still on the shelf on the day.
    // Before: 100 — the cut fell at 05:30 the next morning.
    expect(rowFor((await valuation()).rawMaterials, m).quantity).toBe(120);
  });

  it('the same for finished goods', async () => {
    const e = await elastic({ stock: 800 });
    await moved(e, 'DC_OUT', -100, '2026-09-30T20:30:00Z');    // 02:00 on 1 October
    await moved(e, 'DC_OUT', -50, '2026-09-30T17:30:00Z');     // 23:00 on 30 September
    expect(rowFor((await valuation()).finishedGoods, e).quantity).toBe(900);
  });
});

describe('a material\'s movements', () => {
  it('an approval written the wrong way round is still stock going out', async () => {
    // Written +40 in the years before the list kept signs; it took 40 out.
    const m = await yarn({ stock: 100, stockMovements: [{ date: new Date('2026-10-05T06:00:00Z'), type: 'ORDER_APPROVAL', quantity: 40 }] });
    // 100 now, 40 drawn since: 140 on the day. Before: 60.
    expect(rowFor((await valuation()).rawMaterials, m).quantity).toBe(140);
  });

  it('a receipt and a count correction read as written (unchanged)', async () => {
    const m = await yarn({
      stock: 100,
      stockMovements: [
        { date: new Date('2026-10-05T06:00:00Z'), type: 'PO_INWARD', quantity: 20 },
        { date: new Date('2026-10-06T06:00:00Z'), type: 'STOCK_ADJUST', quantity: -3 },
      ],
    });
    expect(rowFor((await valuation()).rawMaterials, m).quantity).toBe(83);
  });

  it('says so when there are more since the day than are kept', async () => {
    const m = await yarn({ name: 'Polyester 150D', stock: 100 });
    const rows = Array.from({ length: 500 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 2, 6, 0, i)), type: 'JOB_CONSUMPTION', quantity: -0.1 }));
    await M.RawMaterial.collection.updateOne({ _id: m._id }, { $set: { stockMovements: rows } });

    const v = await valuation();
    // Before: a figure, and no word that it could not be the day's.
    expect(v.warnings).toEqual([expect.stringMatching(/Polyester 150D.*last 500 movements.*2 Oct 2026/)]);
    expect(rowFor(v.rawMaterials, m).quantity).toBe(150);
  });

  it('says nothing when the list reaches back past the day', async () => {
    const m = await yarn({ name: 'Polyester 150D', stock: 100 });
    const rows = Array.from({ length: 500 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 2, 6, 0, i)), type: 'JOB_CONSUMPTION', quantity: -0.1 }));
    await M.RawMaterial.collection.updateOne({ _id: m._id }, { $set: { stockMovements: rows } });
    const v = await valuation();
    expect(v.warnings).toEqual([]);
    expect(rowFor(v.rawMaterials, m).quantity).toBe(100);
  });
});

describe('posting the closing stock', () => {
  it('posts what was valued: raw material and finished goods as at the day', async () => {
    await yarn({ archived: true });                                   // ₹30,000
    const e = await elastic({ stock: 800 });
    await moved(e, 'PACKING_INWARD', 300, '2026-10-05T06:00:00Z');    // 500 m on the day: ₹2,000

    const res = await post('/accounts/closing-stock', { asOf: DAY });
    expect(res.status).toBe(201);
    // Before: ₹3,200 — today's finished goods, and no yarn.
    expect(res.body.closing.total).toBe(32000);
    expect(res.body.closing.narration).toMatch(/raw material ₹30000\.00, finished goods ₹2000\.00/);
    expect(res.body.opening.total).toBe(32000);
  });
});

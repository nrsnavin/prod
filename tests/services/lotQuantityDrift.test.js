'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOT IS WEIGHED TO THE GRAM, NOT TO THE SIXTEENTH DECIMAL
//
//  A lot keeps two running totals, receivedQty and consumedQty, and
//  every move was a bare `$inc` guarded by an exact comparison. Kilos
//  with a decimal are not exact in binary, so the totals drift:
//
//      0.3 − 0.1            = 0.19999999999999998
//      10.1 + 20.2 − 20.2   = 10.099999999999998
//
//  and the guards then said no to things that were plainly true:
//
//    • drawing what is left of a lot — "has only 0.19999999999999998
//      left — cannot issue 0.2". About one such draw in four;
//    • putting a cancelled batch's yarn back in two lines — "Cannot
//      return more than was issued from this lot", so the batch could
//      not be cancelled at all;
//    • writing a lot down to nothing on a recount;
//
//  while a lot drawn to 0.00000000000000006 kg stayed "open" and kept
//  appearing in the picker with nothing in it.
//
//  Quantities are now kept and compared to three decimals (a gram).
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, YarnLot, RawMaterial, User, admin, lots;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  YarnLot = require('../../models/YarnLot');
  RawMaterial = require('../../models/RawMaterial');
  User = require('../../models/User');
  lots = require('../../services/yarnLotService');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
async function yarn(stock = 0) {
  n += 1;
  return RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'Yarn', stock, price: 300 });
}
const fresh = (lot) => YarnLot.findById(lot._id);

describe('drawing from a lot', () => {
  it('lets the rest of a lot be drawn', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-1', quantity: 0.3 });
    await lots.drawFromLot(lot._id, 0.1);
    // 0.3 − 0.1 is 0.19999999999999998 in binary: this was refused.
    await lots.drawFromLot(lot._id, 0.2);

    const after = await fresh(lot);
    expect(after.consumedQty).toBe(0.3);
    expect(after.balance).toBe(0);
    expect(after.status).toBe('exhausted');
  });

  it('marks a lot exhausted when nothing a scale could weigh is left', async () => {
    const y = await yarn();
    // Two deliveries: 0.1 + 0.2 is 0.30000000000000004.
    await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-2', quantity: 0.1 });
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-2', quantity: 0.2 });
    expect((await fresh(lot)).receivedQty).toBe(0.3);

    await lots.drawFromLot(lot._id, 0.3);
    const after = await fresh(lot);
    expect(after.balance).toBe(0);
    expect(after.status).toBe('exhausted');
  });

  it('still refuses more than the lot holds, and says how much that is', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-3', quantity: 30.3 });
    await lots.drawFromLot(lot._id, 10.1);
    await expect(lots.drawFromLot(lot._id, 20.201)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Lot D-3 has only 20.2 left — cannot issue 20.201',
    });
    expect((await fresh(lot)).consumedQty).toBe(10.1);
  });

  it('works on a lot whose totals had already drifted', async () => {
    const y = await yarn();
    const lot = await YarnLot.create({ rawMaterial: y._id, lotNo: 'D-4', receivedQty: 0.3, consumedQty: 0.1 });
    // As the old `$inc` left it.
    await YarnLot.updateOne({ _id: lot._id }, { $set: { receivedQty: 0.30000000000000004, consumedQty: 0.10000000000000003 } });
    await lots.drawFromLot(lot._id, 0.2);
    const after = await fresh(lot);
    expect(after.consumedQty).toBe(0.3);
    expect(after.status).toBe('exhausted');
  });
});

describe('putting yarn back', () => {
  it('takes back a batch drawn in two lines, in either order', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-5', quantity: 100 });
    await lots.drawFromLot(lot._id, 10.1);
    await lots.drawFromLot(lot._id, 20.2);
    expect((await fresh(lot)).consumedQty).toBe(30.3);

    await lots.returnToLot(lot._id, 20.2);
    // 30.299999999999997 − 20.2 is 10.099999999999998: this was refused.
    await lots.returnToLot(lot._id, 10.1);

    const after = await fresh(lot);
    expect(after.consumedQty).toBe(0);
    expect(after.balance).toBe(100);
  });

  it('never leaves less than nothing consumed', async () => {
    const y = await yarn();
    const lot = await YarnLot.create({ rawMaterial: y._id, lotNo: 'D-6', receivedQty: 50, consumedQty: 10.1 });
    await YarnLot.updateOne({ _id: lot._id }, { $set: { consumedQty: 10.099999999999998 } });
    await lots.returnToLot(lot._id, 10.1);
    const after = await fresh(lot);
    expect(after.consumedQty).toBe(0);
    // The schema's own floor: a later save of this lot must still pass.
    after.remarks = 'recounted';
    await expect(after.save()).resolves.toBeTruthy();
  });

  it('still refuses to put back more than was drawn', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-7', quantity: 100 });
    await lots.drawFromLot(lot._id, 10.1);
    await expect(lots.returnToLot(lot._id, 10.101)).rejects.toMatchObject({ statusCode: 409 });
    expect((await fresh(lot)).consumedQty).toBe(10.1);
  });

  it('reopens a lot that had been drawn to nothing', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-8', quantity: 0.3 });
    await lots.drawFromLot(lot._id, 0.3);
    expect((await fresh(lot)).status).toBe('exhausted');
    await lots.returnToLot(lot._id, 0.2);
    const after = await fresh(lot);
    expect(after.status).toBe('open');
    expect(after.balance).toBe(0.2);
  });
});

describe('what a lot says it holds', () => {
  it('is a figure a person can read', async () => {
    const y = await yarn();
    const lot = await YarnLot.create({ rawMaterial: y._id, lotNo: 'D-9', receivedQty: 30.3, consumedQty: 10.1 });
    // 30.3 − 10.1 is 20.200000000000003.
    expect(lot.balance).toBe(20.2);
    expect(lot.toJSON().balance).toBe(20.2);
  });

  it('writes its ledger rows to the gram', async () => {
    const y = await yarn();
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-10', quantity: 0.3 });
    await lots.drawFromLot(lot._id, 0.1);
    const withRows = await YarnLot.findById(lot._id).select('+movements');
    expect(withRows.movements.map((m) => [m.type, m.quantity, m.balance])).toEqual([
      ['INWARD', 0.3, 0.3],
      ['BATCH_ISSUE', -0.1, 0.2],
    ]);
  });
});

describe('the lot picker', () => {
  it('leaves out a lot whose remainder is only rounding', async () => {
    const y = await yarn();
    const lot = await YarnLot.create({ rawMaterial: y._id, lotNo: 'D-11', receivedQty: 0.3, consumedQty: 0.3 });
    await YarnLot.updateOne({ _id: lot._id }, { $set: { receivedQty: 0.30000000000000004 } });
    const kept = await YarnLot.create({ rawMaterial: y._id, lotNo: 'D-12', receivedQty: 5, consumedQty: 1 });

    const res = await request(app)
      .get(`/api/v2/yarn-lots/list?material=${y._id}&issuable=true`)
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.lots.map((l) => l.lotNo)).toEqual([kept.lotNo]);
  });
});

describe('correcting a lot on a recount', () => {
  it('lets a lot be written down to nothing', async () => {
    const y = await yarn(0.3);
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-13', quantity: 0.3 });
    await lots.drawFromLot(lot._id, 0.1);

    // 0.19999999999999998 − 0.2 is just below zero: this was refused.
    const res = await request(app)
      .post(`/api/v2/yarn-lots/${lot._id}/adjust`)
      .set('Cookie', cookie())
      .send({ delta: -0.2, reason: 'recount: none left' });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.status).toBe('exhausted');
    expect(res.body.materialStock).toBe(0.1);

    const after = await YarnLot.findById(lot._id).select('+movements');
    expect(after.consumedQty).toBe(0.3);
    expect(after.movements.at(-1)).toMatchObject({ type: 'ADJUST', quantity: -0.2, balance: 0 });

    // The material's own row: what moved is what was asked, so it is not
    // marked as a part-applied correction.
    const material = await RawMaterial.findById(y._id).select('+stockMovements');
    const row = (material.stockMovements || []).at(-1);
    expect(row.quantity).toBe(-0.2);
    expect(row.requested).toBeUndefined();
  });

  it('still refuses to take off more than the lot holds', async () => {
    const y = await yarn(1);
    const lot = await lots.creditLot({ rawMaterial: y._id, lotNo: 'D-14', quantity: 0.3 });
    const res = await request(app)
      .post(`/api/v2/yarn-lots/${lot._id}/adjust`)
      .set('Cookie', cookie())
      .send({ delta: -0.301, reason: 'recount' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Lot D-14 holds only 0.3 — cannot take 0.301 off it');
  });
});

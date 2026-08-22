'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE STOCK MOVEMENT LEDGER, OVER A DATE RANGE
//
//  A store keeper prints this to tally the rack against the system.
//  Four things make it worth printing:
//
//    1. Signs. A receipt adds and an issue subtracts. Getting this
//       backwards produces a document that looks perfectly plausible
//       and is exactly wrong.
//    2. Order. A running balance can only be accumulated in the
//       direction time ran, so the rows must be oldest-first no matter
//       what order the two collections came back in.
//    3. The window. "1 March to 31 March" includes both days. Passing
//       the raw dates through drops everything that moved on the 31st,
//       silently.
//    4. Honesty about reversals and corrections. A cancelled order's
//       issue was undone without a compensating receipt, and a stock
//       correction is not a purchase.
//
//  Most of what is asserted below is one of those four.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, svc, RawMaterial, MaterialInward, MaterialOutward;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  svc = require('../../services/materialLedger');
  RawMaterial = require('../../models/RawMaterial');
  MaterialInward = require('../../models/MaterialInward');
  MaterialOutward = require('../../models/MaterialOut.cjs');
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const d = (s) => new Date(`${s}T10:00:00.000Z`);

const makeMaterial = (over = {}) =>
  RawMaterial.create({
    name: 'Nylon 40D',
    category: 'Yarn',
    unit: 'kg',
    stock: 0,
    price: 100,
    ...over,
  });

const inward = (material, over = {}) =>
  MaterialInward.create({
    rawMaterial: material._id,
    quantity: 100,
    inwardDate: d('2025-03-10'),
    ...over,
  });

const outward = (material, over = {}) =>
  MaterialOutward.create({
    rawMaterial: material._id,
    quantity: 40,
    outwardDate: d('2025-03-12'),
    type: 'ORDER_APPROVAL',
    ...over,
  });

afterEach(async () => {
  await Promise.all([
    RawMaterial.deleteMany({}),
    MaterialInward.deleteMany({}),
    MaterialOutward.deleteMany({}),
  ]);
});

// ── composeRows: pure, and where the arithmetic actually lives ────
describe('composeRows', () => {
  const iw = (date, quantity, over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    inwardDate: d(date),
    quantity,
    ...over,
  });
  const ow = (date, quantity, over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    outwardDate: d(date),
    quantity,
    type: 'ORDER_APPROVAL',
    ...over,
  });

  it('adds a receipt to the balance', () => {
    const [row] = svc.composeRows([iw('2025-03-01', 100)], [], 0);
    expect(row.signedQuantity).toBe(100);
    expect(row.balance).toBe(100);
  });

  it('subtracts an issue from the balance', () => {
    const [row] = svc.composeRows([], [ow('2025-03-01', 40)], 100);
    expect(row.signedQuantity).toBe(-40);
    expect(row.balance).toBe(60);
  });

  it('subtracts an issue even when its quantity was stored positive', () => {
    // MaterialOutward stores an unsigned quantity — the direction is in
    // the collection it lives in, not the number. Reading it as written
    // makes every issue read as a receipt.
    const [row] = svc.composeRows([], [ow('2025-03-01', 40)], 100);
    expect(row.balance).toBeLessThan(100);
  });

  it('subtracts an issue that was stored negative too', () => {
    // Some historical adjustment rows carry a negative quantity. Taking
    // the sign from the row as well as from the collection would flip it
    // back to a credit.
    const [row] = svc.composeRows([], [ow('2025-03-01', -40)], 100);
    expect(row.balance).toBe(60);
  });

  it('runs the balance forward from the opening figure', () => {
    const rows = svc.composeRows([iw('2025-03-01', 100)], [ow('2025-03-02', 30)], 50);
    expect(rows.map((r) => r.balance)).toEqual([150, 120]);
  });

  it('puts the rows in date order regardless of input order', () => {
    const rows = svc.composeRows(
      [iw('2025-03-05', 10), iw('2025-03-01', 20)],
      [ow('2025-03-03', 5)],
      0
    );
    expect(rows.map((r) => r.quantity)).toEqual([20, 5, 10]);
  });

  it('accumulates rather than restating the opening balance on each row', () => {
    const rows = svc.composeRows(
      [iw('2025-03-01', 10), iw('2025-03-02', 10), iw('2025-03-03', 10)],
      [],
      0
    );
    expect(rows.map((r) => r.balance)).toEqual([10, 20, 30]);
  });

  it('never shows a negative balance for a same-instant receive and issue', () => {
    // Two rows written milliseconds apart by the same code path sort
    // equal. Ordering the issue first would print a balance the rack
    // never actually held.
    const rows = svc.composeRows([iw('2025-03-01', 50)], [ow('2025-03-01', 50)], 0);
    expect(rows[0].direction).toBe(1);
    expect(rows.every((r) => r.balance >= 0)).toBe(true);
  });

  it('keeps kilogram arithmetic off the float fringe', () => {
    const rows = svc.composeRows(
      [iw('2025-03-01', 0.1), iw('2025-03-02', 0.2)],
      [],
      0
    );
    expect(rows[1].balance).toBe(0.3);
  });

  it('labels a supplier receipt a goods receipt', () => {
    const [row] = svc.composeRows([iw('2025-03-01', 100)], [], 0);
    expect(row.label).toBe('Goods receipt');
    expect(row.type).toBe('RECEIPT');
  });

  it('does not call a stock correction a goods receipt', () => {
    const [row] = svc.composeRows(
      [iw('2025-03-01', 5, { remarks: 'Stock adjustment: recount' })],
      [],
      0
    );
    expect(row.label).toBe('Stock adjustment');
    expect(row.type).toBe('ADJUST_IN');
  });

  it('names the purchase order a receipt came against', () => {
    const poId = new mongoose.Types.ObjectId();
    const [row] = svc.composeRows(
      [iw('2025-03-01', 100, { purchaseOrder: { _id: poId, poNo: 'PO-77' } })],
      [],
      0
    );
    expect(row.reference).toContain('PO-77');
    expect(row.referenceKind).toBe('purchaseOrder');
    expect(row.referenceId).toBe(String(poId));
  });

  it('names the order an approval issued against', () => {
    const orderId = new mongoose.Types.ObjectId();
    const [row] = svc.composeRows(
      [],
      [ow('2025-03-01', 40, { order: { _id: orderId, orderNo: 1042 } })],
      100
    );
    expect(row.reference).toBe('Order #1042');
    expect(row.referenceKind).toBe('order');
  });

  it('names the job a consumption issued against', () => {
    const jobId = new mongoose.Types.ObjectId();
    const [row] = svc.composeRows(
      [],
      [ow('2025-03-01', 40, { type: 'JOB_CONSUMPTION', job: { _id: jobId, jobOrderNo: 55 } })],
      100
    );
    expect(row.reference).toBe('Job J-55');
    expect(row.referenceKind).toBe('job');
  });

  it('leaves the reference empty rather than inventing one', () => {
    const [row] = svc.composeRows([], [ow('2025-03-01', 40, { type: 'STOCK_ADJUST' })], 100);
    expect(row.reference).toBe('');
    expect(row.referenceId).toBeNull();
  });

  it('carries the dye lot through when the movement named one', () => {
    const [row] = svc.composeRows([], [ow('2025-03-01', 40, { lotNo: 'D-4471' })], 100);
    expect(row.lotNo).toBe('D-4471');
  });

  it('handles a row with no date without throwing', () => {
    const [row] = svc.composeRows([iw('2025-03-01', 10, { inwardDate: null })], [], 0);
    expect(row.balance).toBe(10);
  });

  it('returns nothing for a period with no movements', () => {
    expect(svc.composeRows([], [], 100)).toEqual([]);
  });
});

// ── parseRange ────────────────────────────────────────────────────
describe('parseRange', () => {
  it('widens `to` to the end of that day', () => {
    const { to } = svc.parseRange({ to: '2025-03-31' });
    expect(to.getHours()).toBe(23);
    expect(to.getMinutes()).toBe(59);
  });

  it('widens `from` to the start of that day', () => {
    const { from } = svc.parseRange({ from: '2025-03-01' });
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
  });

  it('accepts an open range', () => {
    expect(svc.parseRange({})).toEqual({ from: null, to: null });
  });

  it('accepts one open end', () => {
    const { from, to } = svc.parseRange({ from: '2025-03-01' });
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeNull();
  });

  it('refuses a backwards range rather than returning nothing', () => {
    // An empty ledger for a range the user got the wrong way round reads
    // as "nothing moved", which is a lie about the stock.
    expect(() => svc.parseRange({ from: '2025-03-31', to: '2025-03-01' })).toThrow(/after/i);
  });

  it('refuses text that is not a date', () => {
    expect(() => svc.parseRange({ from: 'last tuesday' })).toThrow(/not a date/i);
  });

  it('allows a single-day range', () => {
    const { from, to } = svc.parseRange({ from: '2025-03-15', to: '2025-03-15' });
    expect(from < to).toBe(true);
  });
});

// ── isAdjustmentInward ────────────────────────────────────────────
describe('telling a correction from a purchase', () => {
  it('reads the adjustment prefix', () => {
    expect(svc.isAdjustmentInward({ remarks: 'Stock adjustment: recount' })).toBe(true);
  });

  it('is not fooled by the words appearing mid-remark', () => {
    expect(svc.isAdjustmentInward({ remarks: 'Received after stock adjustment' })).toBe(false);
  });

  it('treats a blank remark as an ordinary receipt', () => {
    expect(svc.isAdjustmentInward({})).toBe(false);
  });
});

// ── netOf ─────────────────────────────────────────────────────────
describe('netOf', () => {
  it('is received minus issued', () => {
    expect(svc.netOf([{ quantity: 100 }], [{ quantity: 40 }])).toBe(60);
  });

  it('reads a negative stored quantity by magnitude', () => {
    expect(svc.netOf([], [{ quantity: -40 }])).toBe(-40);
  });

  it('is zero for nothing', () => {
    expect(svc.netOf([], [])).toBe(0);
  });
});

// ── materialLedger against the database ───────────────────────────
describe('materialLedger', () => {
  it('derives the opening balance by walking today\'s stock back', async () => {
    // Stock is 60. In the window: +100 and −40. So the period opened at
    // zero, and that is a fact about the stock rather than a stored one.
    const m = await makeMaterial({ stock: 60 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-10') });
    await outward(m, { quantity: 40, outwardDate: d('2025-03-12') });

    const led = await svc.materialLedger(m._id, svc.parseRange({
      from: '2025-03-01', to: '2025-03-31',
    }));
    expect(led.opening).toBe(0);
    expect(led.closing).toBe(60);
  });

  it('closes at the stock figure when the range runs past every movement', async () => {
    const m = await makeMaterial({ stock: 60 });
    await inward(m, { quantity: 100 });
    await outward(m, { quantity: 40 });

    const led = await svc.materialLedger(m._id, { from: null, to: null });
    expect(led.closing).toBe(led.stockNow);
  });

  it('excludes movements after the window and says so in the closing balance', async () => {
    const m = await makeMaterial({ stock: 160 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-10') });
    await inward(m, { quantity: 100, inwardDate: d('2025-04-10') });
    await outward(m, { quantity: 40, outwardDate: d('2025-03-12') });

    const led = await svc.materialLedger(m._id, svc.parseRange({
      from: '2025-03-01', to: '2025-03-31',
    }));
    expect(led.count).toBe(2);
    expect(led.closing).toBe(60);
    // The gap between the two is what the sheet warns about.
    expect(led.stockNow).toBe(160);
  });

  it('includes a movement dated on the last day of the range', async () => {
    // The whole point of widening `to` to end-of-day.
    const m = await makeMaterial({ stock: 100 });
    await inward(m, { quantity: 100, inwardDate: new Date('2025-03-31T18:30:00.000Z') });

    const led = await svc.materialLedger(m._id, svc.parseRange({
      from: '2025-03-01', to: '2025-03-31',
    }));
    expect(led.count).toBe(1);
  });

  it('skips a reversed issue rather than showing it and netting it off', async () => {
    // Cancelling an order marks the outward reversed and credits stock
    // back through receiveAtCost — no compensating inward is written. A
    // reversed row left in would double the balance error.
    const m = await makeMaterial({ stock: 100 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-10') });
    await outward(m, { quantity: 40, outwardDate: d('2025-03-12'), reversed: true });

    const led = await svc.materialLedger(m._id, { from: null, to: null });
    expect(led.count).toBe(1);
    expect(led.closing).toBe(100);
    expect(led.totals.issued).toBe(0);
  });

  it('counts a correction separately from a purchase', async () => {
    const m = await makeMaterial({ stock: 105 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-10') });
    await inward(m, { quantity: 5, inwardDate: d('2025-03-11'), remarks: 'Stock adjustment: recount' });

    const led = await svc.materialLedger(m._id, { from: null, to: null });
    expect(led.totals.received).toBe(100);
    expect(led.totals.adjustedIn).toBe(5);
  });

  it('reports the material so the sheet can be titled', async () => {
    const m = await makeMaterial({ name: 'Spandex 1120de', unit: 'kg' });
    const led = await svc.materialLedger(m._id, { from: null, to: null });
    expect(led.material.name).toBe('Spandex 1120de');
    expect(led.material.unit).toBe('kg');
  });

  it('returns an empty period without pretending stock moved', async () => {
    const m = await makeMaterial({ stock: 60 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-10') });

    const led = await svc.materialLedger(m._id, svc.parseRange({
      from: '2025-01-01', to: '2025-01-31',
    }));
    expect(led.rows).toEqual([]);
    expect(led.opening).toBe(led.closing);
    expect(led.totals.net).toBe(0);
  });

  it('refuses a material that does not exist', async () => {
    await expect(
      svc.materialLedger(new mongoose.Types.ObjectId(), { from: null, to: null })
    ).rejects.toThrow(/not found/i);
  });

  it('ends each row at the balance the next one opens from', async () => {
    // The property that makes the printed column followable with a
    // finger: every row's balance is the previous plus its own movement.
    const m = await makeMaterial({ stock: 130 });
    await inward(m, { quantity: 100, inwardDate: d('2025-03-01') });
    await outward(m, { quantity: 40, outwardDate: d('2025-03-02') });
    await inward(m, { quantity: 70, inwardDate: d('2025-03-03') });

    const led = await svc.materialLedger(m._id, { from: null, to: null });
    let running = led.opening;
    for (const r of led.rows) {
      running = Math.round((running + r.signedQuantity) * 1000) / 1000;
      expect(r.balance).toBe(running);
    }
    expect(running).toBe(led.closing);
  });
});

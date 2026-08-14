'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING QUANTITIES MUST NOT UNPRICE THE ORDER
//
//  Two routes own different halves of an order line:
//
//    POST /order/update-order        the quantities
//    PUT  /pnl/order/:id/rates       the selling rate
//
//  api/pnl.js says so out loud — "Deliberately NOT part of
//  /order/update-order: that route only edits [quantities]". But
//  update-order assigns `order.elasticOrdered = elasticOrdered`
//  wholesale from the request body, and the web edit sends only
//  { elastic, quantity }. `rate` then falls to its schema default of 0.
//
//  So changing a quantity silently wipes every agreed price on the
//  order, and the order P&L — whose revenue comes from exactly this
//  field — reports the order as unpriced. Nothing errors, and the
//  quantities the operator came to change are correct.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, Elastic, Customer, User, admin;
let customer, warp, weft;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  Order    = require('../../models/Order');
  Elastic  = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Sales', email: 'orderedit@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  const el = (n) => Elastic.create({
    name: `${n}-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  warp = await el('20mm');
  weft = await el('25mm');
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** An order priced the way the P&L page prices one. */
const pricedOrder = async () => {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1',
    date: new Date(), supplyDate: new Date(), status: 'Open',
    elasticOrdered: [
      { elastic: warp._id, quantity: 1000, rate: 12.5 },
      { elastic: weft._id, quantity: 2000, rate: 9 },
    ],
    pendingElastic: [
      { elastic: warp._id, quantity: 1000 },
      { elastic: weft._id, quantity: 2000 },
    ],
  });
  return order;
};

const edit = (order, body) =>
  request(app).post('/api/v2/order/update-order')
    .set('Cookie', cookie())
    .send({
      orderId: order._id,
      auditReason: 'customer revised the quantity',
      expectedVersion: order.__v,
      ...body,
    });

const linesOf = async (order) => {
  const fresh = await Order.findById(order._id).lean();
  return fresh.elasticOrdered;
};

// ══════════════════════════════════════════════════════════════════
describe('changing a quantity on a priced order', () => {
  it('changes the quantity', async () => {
    const order = await pricedOrder();
    const res = await edit(order, {
      elasticOrdered: [
        { elastic: String(warp._id), quantity: 1500 },
        { elastic: String(weft._id), quantity: 2000 },
      ],
    });

    expect(res.status).toBe(200);
    const lines = await linesOf(order);
    expect(lines.find((l) => String(l.elastic) === String(warp._id)).quantity).toBe(1500);
  });

  it('keeps the agreed price on every line', async () => {
    // The web edit sends { elastic, quantity } and nothing else —
    // exactly what OrderDetailPage builds.
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [
        { elastic: String(warp._id), quantity: 1500 },
        { elastic: String(weft._id), quantity: 2000 },
      ],
    });

    const lines = await linesOf(order);
    const rateFor = (e) => lines.find((l) => String(l.elastic) === String(e._id)).rate;
    expect(rateFor(warp)).toBe(12.5);
    expect(rateFor(weft)).toBe(9);
  });

  it('leaves the order priced, so the P&L still has revenue', async () => {
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1500 }],
    });

    const lines = await linesOf(order);
    const value = lines.reduce((s, l) => s + l.quantity * l.rate, 0);
    expect(value).toBe(1500 * 12.5);   // not 0
  });

  it('honours a rate the caller DOES send', async () => {
    // A client that manages both is not overridden by the carry-forward.
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1000, rate: 20 }],
    });

    expect((await linesOf(order))[0].rate).toBe(20);
  });

  it('accepts an explicit zero as "unprice this line"', async () => {
    // 0 is this system's own signal for "not priced yet". Carrying the
    // old rate forward over a deliberate 0 would make unpricing
    // impossible, which is a different bug in the same place.
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1000, rate: 0 }],
    });

    expect((await linesOf(order))[0].rate).toBe(0);
  });

  it('gives a newly added line no rate, because none was ever agreed', async () => {
    const order = await pricedOrder();
    const extra = await Elastic.create({
      name: `30mm-${seq++}`, weaveType: '8', spandexEnds: 40,
      yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    });
    await edit(order, {
      elasticOrdered: [
        { elastic: String(warp._id), quantity: 1000 },
        { elastic: String(extra._id), quantity: 500 },
      ],
    });

    const lines = await linesOf(order);
    expect(lines.find((l) => String(l.elastic) === String(extra._id)).rate).toBe(0);
  });

  it('drops the rate with the line, when a line is removed', async () => {
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1000 }],
    });

    const lines = await linesOf(order);
    expect(lines).toHaveLength(1);
    expect(lines[0].rate).toBe(12.5);
  });

  it('records the rates in the audit trail alongside the quantities', async () => {
    // "The price changed" has to be answerable months later. Recording
    // only quantities makes a wiped rate invisible in the history too.
    const order = await pricedOrder();
    await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1500 }],
    });

    const fresh = await Order.findById(order._id).lean();
    const fp = fresh.fingerprints.at(-1);
    const before = fp.meta.previousValues.elasticOrdered;
    expect(before[0]).toHaveProperty('rate', 12.5);
  });
});

// ══════════════════════════════════════════════════════════════════
//  WHAT AN ORDER IS ALLOWED TO BE
//
//  /create-order validated nothing at all. It read the body straight
//  into Order.create, so the failures landed as 500s — "our fault" for
//  what is a bad request — or as 201s for documents that make no sense.
//
//  Duplicate lines and a dangling customer are the two that cause real
//  damage: reservations and the production arrays are keyed by elastic,
//  so one elastic twice is two entries for one product; and an order
//  pointing at a customer that does not exist renders a blank name on
//  every screen that shows it.
// ══════════════════════════════════════════════════════════════════
describe('creating an order', () => {
  const create = (body) =>
    request(app).post('/api/v2/order/create-order')
      .set('Cookie', cookie())
      .send({
        customer: customer._id, po: 'PO-1',
        date: new Date(), supplyDate: new Date(),
        ...body,
      });

  it('accepts an ordinary one', async () => {
    const res = await create({ elasticOrdered: [{ elastic: String(warp._id), quantity: 1000 }] });
    expect(res.status).toBe(201);
  });

  it('refuses a body with no lines, as a bad request rather than a crash', async () => {
    const res = await create({});
    expect(res.status).toBe(400);
  });

  it('refuses an order for nothing', async () => {
    // 201 with zero lines produced an order that could be approved,
    // produce nothing, and sit in the system forever.
    const res = await create({ elasticOrdered: [] });
    expect(res.status).toBe(400);
  });

  it('refuses a negative quantity as a 400, not a 500', async () => {
    const res = await create({ elasticOrdered: [{ elastic: String(warp._id), quantity: -500 }] });
    expect(res.status).toBe(400);
  });

  it('refuses a line for zero', async () => {
    const res = await create({ elasticOrdered: [{ elastic: String(warp._id), quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it('refuses the same elastic on two lines', async () => {
    // Reservations, pendingElastic, producedElastic and packedElastic
    // are all keyed by elastic. Two lines for one product is two
    // entries for one key, and every reader picks one of them.
    const res = await create({
      elasticOrdered: [
        { elastic: String(warp._id), quantity: 1000 },
        { elastic: String(warp._id), quantity: 2000 },
      ],
    });
    expect(res.status).toBe(400);
    // Names both positions, so the operator can see which two lines
    // rather than being told a rule was broken somewhere.
    expect(res.body.message).toMatch(/Line 2.*already on line 1/);
  });

  it('refuses a customer that does not exist', async () => {
    const res = await create({
      customer: new mongoose.Types.ObjectId(),
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1000 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses no customer at all, as a bad request', async () => {
    const res = await create({
      customer: undefined,
      elasticOrdered: [{ elastic: String(warp._id), quantity: 1000 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses an elastic that does not exist', async () => {
    const res = await create({
      elasticOrdered: [{ elastic: new mongoose.Types.ObjectId(), quantity: 1000 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('the same rules on an edit', () => {
  it('refuses a duplicated elastic', async () => {
    const order = await pricedOrder();
    const res = await edit(order, {
      elasticOrdered: [
        { elastic: String(warp._id), quantity: 1000 },
        { elastic: String(warp._id), quantity: 500 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a negative quantity', async () => {
    const order = await pricedOrder();
    const res = await edit(order, {
      elasticOrdered: [{ elastic: String(warp._id), quantity: -1 }],
    });
    expect(res.status).toBe(400);
  });

  it('leaves the order untouched when it refuses', async () => {
    const order = await pricedOrder();
    await edit(order, { elasticOrdered: [{ elastic: String(warp._id), quantity: -1 }] });

    const lines = await linesOf(order);
    expect(lines).toHaveLength(2);
    expect(lines[0].rate).toBe(12.5);
  });
});

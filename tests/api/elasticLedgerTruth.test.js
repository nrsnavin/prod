'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE ELASTIC STOCK LEDGER IS SUPPOSED TO SAY
//
//  A manufacturing stock ledger answers two different questions and
//  must never confuse them:
//
//    ON HAND  — goods physically in the building. Moves only when
//               goods move: produced in, dispatched out, scrapped,
//               counted.
//    RESERVED — how much of that on-hand stock is already promised to
//               approved orders. A claim, not goods. Reserving creates
//               nothing and dispatching against a reservation does not
//               make goods leave by some other door.
//
//    AVAILABLE = ON HAND − RESERVED
//
//  Dispatch settles both at once: the goods leave (on hand down) and
//  the promise is kept (reserved down). Anything that moves only one
//  of them has lost track of either the goods or the promise.
//
//  Every row must state the balance of BOTH after it, or the ledger
//  cannot be read back to explain how today's figures came about —
//  which is the only reason to keep a ledger rather than a total.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Elastic, Customer, Order, User, StockMovement, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Elastic       = require('../../models/Elastic');
  Customer      = require('../../models/Customer');
  Order         = require('../../models/Order');
  User          = require('../../models/User');
  StockMovement = require('../../models/StockMovement');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** One elastic with `stock` metres on hand, and a customer to sell to. */
async function seed({ stock = 0 } = {}) {
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    stock, reservedStock: 0,
  });
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
  });
  return { elastic, customer };
}

/** An approved order for `qty` metres of `elastic`, which reserves it. */
async function approvedOrder(elastic, customer, qty) {
  const order = await Order.create({
    customer: customer._id, status: 'Open', po: 'ACME-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: qty }],
    rawMaterialRequired: [],
  });
  const res = await request(app).post('/api/v2/order/approve')
    .set('Cookie', adminCookie())
    .send({ orderId: String(order._id) });
  if (res.status >= 400) {
    throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return order;
}

const dispatch = async (elastic, customer, qty, order) => {
  const res = await request(app).post('/api/v2/dc/create')
    .set('Cookie', adminCookie())
    .send({
      type: 'elastic',
      customerName: customer.name,
      ...(order ? { orderId: String(order._id), orderNo: order.orderNo } : {}),
      items: [{ elastic: String(elastic._id), quantity: qty, rate: 12 }],
    });
  if (res.status >= 400) {
    throw new Error(`dc create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.dc;
};

/** The figures the stock page shows. */
const figures = async (elastic) => {
  const res = await request(app)
    .get(`/api/v2/elastic/${elastic._id}/stock`)
    .set('Cookie', adminCookie());
  if (res.status >= 400) throw new Error(`stock failed: ${res.status}`);
  return res.body;
};

// ── Dispatching against a reserved order ──────────────────────────────

describe('goods leaving on a delivery challan', () => {
  it('come off the shelf even when an order had reserved them', async () => {
    // The whole fault in one case. 1000 m produced, an order approved
    // for all of it, then all of it dispatched. The reservation was
    // released and the goods walked out of the door — but the stock
    // figure never moved, so the warehouse still shows 1000 m of an
    // elastic that is on a lorry.
    const s = await seed({ stock: 1000 });
    const order = await approvedOrder(s.elastic, s.customer, 1000);

    const held = await figures(s.elastic);
    expect(held).toMatchObject({ stock: 1000, reservedStock: 1000, available: 0 });

    await dispatch(s.elastic, s.customer, 1000, order);

    const after = await figures(s.elastic);
    expect(after.stock).toBe(0);
    expect(after.reservedStock).toBe(0);
    expect(after.available).toBe(0);
  });

  it('come off the shelf when nothing was reserved', async () => {
    // The path that always worked, kept working.
    const s = await seed({ stock: 1000 });
    await dispatch(s.elastic, s.customer, 400);

    const after = await figures(s.elastic);
    expect(after).toMatchObject({ stock: 600, reservedStock: 0, available: 600 });
  });

  it('takes the part-reserved case off the shelf in full', async () => {
    // 600 reserved of 1000 on hand; a 1000 m dispatch takes all of it.
    const s = await seed({ stock: 1000 });
    const order = await approvedOrder(s.elastic, s.customer, 600);

    await dispatch(s.elastic, s.customer, 1000, order);

    const after = await figures(s.elastic);
    expect(after).toMatchObject({ stock: 0, reservedStock: 0, available: 0 });
  });

  it('records one movement carrying the whole quantity', async () => {
    // Not two half-rows that have to be added up to find out what left
    // the building. What went out is one fact.
    const s = await seed({ stock: 1000 });
    const order = await approvedOrder(s.elastic, s.customer, 600);
    await dispatch(s.elastic, s.customer, 1000, order);

    const out = await StockMovement.find({ elastic: s.elastic._id, type: 'DC_OUT' }).lean();
    expect(out).toHaveLength(1);
    expect(out[0].applied).toBe(-1000);
    expect(out[0].balance).toBe(0);
  });
});

// ── Putting it back ───────────────────────────────────────────────────

describe('cancelling a delivery challan', () => {
  const cancel = (dc) =>
    request(app).patch('/api/v2/dc/update-status')
      .set('Cookie', adminCookie())
      .send({ id: String(dc._id), status: 'cancelled' });

  it('puts the goods back and re-reserves them for the order', async () => {
    const s = await seed({ stock: 1000 });
    const order = await approvedOrder(s.elastic, s.customer, 1000);
    const dc = await dispatch(s.elastic, s.customer, 1000, order);

    const res = await cancel(dc);
    expect(res.status).toBeLessThan(400);

    // Exactly where it started: goods back on the shelf, still promised.
    const after = await figures(s.elastic);
    expect(after).toMatchObject({ stock: 1000, reservedStock: 1000, available: 0 });
  });
});

// ── What the ledger has to be able to say ─────────────────────────────

describe('reading the ledger back', () => {
  it('states the reserved balance on every row, not only the stock one', async () => {
    // A ledger whose rows do not carry the reserved balance cannot
    // explain how today's reserved figure came about — and a row that
    // moved a reservation while reporting an unchanged balance reads
    // as though it did nothing at all.
    const s = await seed({ stock: 1000 });
    const order = await approvedOrder(s.elastic, s.customer, 400);

    const { movements } = await figures(s.elastic);
    const hold = movements.find((m) => m.type === 'RESERVATION_HOLD');
    expect(hold).toBeDefined();
    expect(hold.reservedApplied).toBe(400);
    expect(hold.reservedBalance).toBe(400);
    // And it did not pretend to move goods.
    expect(hold.applied).toBe(0);
    expect(hold.balance).toBe(1000);

    await dispatch(s.elastic, s.customer, 400, order);

    const { movements: after } = await figures(s.elastic);
    const out = after.find((m) => m.type === 'DC_OUT');
    // The dispatch settles both: goods gone, promise kept.
    expect(out.applied).toBe(-400);
    expect(out.balance).toBe(600);
    expect(out.reservedApplied).toBe(-400);
    expect(out.reservedBalance).toBe(0);
  });

  it('lets every row be read as on hand, reserved and available', async () => {
    const s = await seed({ stock: 0 });
    await request(app).post(`/api/v2/elastic/${s.elastic._id}/adjust-stock`)
      .set('Cookie', adminCookie())
      .send({ delta: 1000, reason: 'opening count', force: true });
    const order = await approvedOrder(s.elastic, s.customer, 600);
    await dispatch(s.elastic, s.customer, 250, order);

    const { movements } = await figures(s.elastic);
    // Newest first, so read it the other way to follow the story.
    const story = movements
      .slice()
      .reverse()
      .map((m) => [m.type, m.balance, m.reservedBalance, m.balance - m.reservedBalance]);

    expect(story).toEqual([
      ['MANUAL_ADJUST',     1000,   0, 1000],  // counted in
      ['RESERVATION_HOLD',  1000, 600,  400],  // 600 promised away
      ['DC_OUT',             750, 350,  400],  // 250 shipped against it
    ]);
  });

  it('explains an opening balance instead of conjuring it', async () => {
    // Stock that no movement accounts for is stock the ledger cannot
    // explain, and it shows up for ever after as unexplainable drift
    // on reconciliation — on the one figure a ledger exists to justify.
    // A BOM, because create also costs the elastic and costing reads it.
    const RawMaterial = require('../../models/RawMaterial');
    const yarn = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300,
    });
    const res = await request(app).post('/api/v2/elastic/create-elastic')
      .set('Cookie', adminCookie())
      .send({
        name: '30mm', weaveType: '8',
        spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
        warpYarn:        [{ id: String(yarn._id), weight: 1 }],
        warpSpandex:     { id: String(yarn._id), weight: 1 },
        spandexCovering: { id: String(yarn._id), weight: 1 },
        weftYarn:        { id: String(yarn._id), weight: 1 },
        stock: 750,
      });
    expect(res.status).toBeLessThan(400);

    const made = await Elastic.findById(res.body.elastic._id);
    expect(made.stock).toBe(750);

    const rows = await StockMovement.find({ elastic: made._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'MANUAL_ADJUST', applied: 750, balance: 750, reservedBalance: 0,
    });
    expect(rows[0].reason).toMatch(/opening stock/i);
  });

  it('reconciles both balances against the ledger', async () => {
    const s = await seed({ stock: 0 });
    await request(app).post(`/api/v2/elastic/${s.elastic._id}/adjust-stock`)
      .set('Cookie', adminCookie())
      .send({ delta: 500, reason: 'opening count', force: true });
    await approvedOrder(s.elastic, s.customer, 300);

    const res = await request(app).get('/api/v2/elastic/reconcile')
      .set('Cookie', adminCookie());
    expect(res.status).toBeLessThan(400);
    // Both figures are fully explained by the rows behind them.
    expect(res.body.drifts).toEqual([]);
  });

  it('keeps the running balances equal to the elastic itself', async () => {
    // The ledger and the figure on the card are two statements of the
    // same fact. If they ever disagree, one of them is lying and there
    // is no way to tell which.
    const s = await seed({ stock: 500 });
    const order = await approvedOrder(s.elastic, s.customer, 300);
    await dispatch(s.elastic, s.customer, 120, order);

    const live = await figures(s.elastic);
    const rows = await StockMovement.find({ elastic: s.elastic._id })
      .sort({ date: 1, _id: 1 }).lean();
    const last = rows[rows.length - 1];

    expect(last.balance).toBe(live.stock);
    expect(last.reservedBalance).toBe(live.reservedStock);
    // And the balances are the running sums of the applied columns.
    expect(rows.reduce((t, r) => t + r.applied, 0)).toBe(live.stock - 500);
    expect(rows.reduce((t, r) => t + (r.reservedApplied || 0), 0)).toBe(live.reservedStock);
  });
});

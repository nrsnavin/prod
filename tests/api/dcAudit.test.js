'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CHALLAN THAT SAYS DISPATCHED WHILE THE GOODS ARE ON THE SHELF
//
//  Cutting a DC takes goods off the shelf. Cancelling one puts them
//  back. `/update-status` checked only that the new status was one of
//  the four names and that it differed from the current one — so every
//  square of the grid was reachable, including two that break the
//  ledger:
//
//    cancelled → dispatched   The cancel already reversed the DC_OUT.
//                             Nothing re-applies it going the other
//                             way, so the challan reads "dispatched"
//                             while the warehouse counts the goods as
//                             in stock. Issued on paper, present in the
//                             ledger, and no error anywhere.
//
//    delivered → cancelled    Puts back goods the customer has taken
//                             and signed for. `/update` refuses to so
//                             much as EDIT a delivered challan — "the
//                             customer holds it as their receipt" — so
//                             the same document was protected at one
//                             door and wide open at the other.
//
//  The web has always drawn the right machine: draft → dispatched →
//  delivered, with cancel available only from the first two. It simply
//  was not the machine the server enforced, and the server is the one
//  that moves stock.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, DeliveryChallan, User, admin, dispatcher;

const cookie = (u = admin, role = 'admin') => [
  `token=${jwt.sign({ id: u._id, role }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order           = require('../../models/Order');
  Customer        = require('../../models/Customer');
  Elastic         = require('../../models/Elastic');
  DeliveryChallan = require('../../models/DeliveryChallan');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'dcaudit@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  dispatcher = await User.create({
    name: 'Dispatch', email: 'dcdispatch@t.co', password: 'pass1234',
    role: 'production', department: 'production',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (stock = 1000) =>
  Elastic.create({
    name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    stock, reservedStock: 0,
  });

const makeCustomer = () =>
  Customer.create({ name: `Acme ${seq++}`, contactName: 'R', phoneNumber: '9000000001' });

/** Cut an elastic challan through the real route. */
async function cutDc({ quantity = 100, elastic, orderId } = {}) {
  const el = elastic || (await makeElastic());
  await makeCustomer();
  const res = await request(app).post('/api/v2/dc/create')
    .set('Cookie', cookie())
    .send({
      type: 'elastic',
      customerName: 'Acme',
      ...(orderId ? { orderId } : {}),
      items: [{ elastic: el._id, elasticName: el.name, quantity, rate: 10 }],
    });
  return { res, elastic: el, dc: res.body.dc };
}

const setStatus = (id, status, who = cookie()) =>
  request(app).patch('/api/v2/dc/update-status')
    .set('Cookie', who).send({ id, status });

const stockOf = async (id) => (await Elastic.findById(id).lean()).stock;

// ══════════════════════════════════════════════════════════════════
describe('the challan status machine', () => {
  it('walks draft → dispatched → delivered', async () => {
    const { dc } = await cutDc();
    expect((await setStatus(dc._id, 'dispatched')).status).toBe(200);
    expect((await setStatus(dc._id, 'delivered')).status).toBe(200);
  });

  it('refuses to resurrect a cancelled challan', async () => {
    // The one that breaks the ledger: cancel returned the goods, and
    // nothing takes them out again on the way back to dispatched.
    const { dc } = await cutDc();
    await setStatus(dc._id, 'cancelled');

    const res = await setStatus(dc._id, 'dispatched');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DC_BAD_TRANSITION');
  });

  it('never lets a dispatched challan coexist with unmoved stock', async () => {
    // Said as the invariant rather than as a status check: if the
    // challan claims the goods left, the stock must be down by that
    // much. Cancel-then-uncancel used to satisfy the first and not the
    // second.
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });
    expect(await stockOf(el._id)).toBe(900);

    await setStatus(dc._id, 'cancelled');
    expect(await stockOf(el._id)).toBe(1000);

    await setStatus(dc._id, 'dispatched');   // refused now

    const fresh = await DeliveryChallan.findById(dc._id).lean();
    const claimsGone = ['dispatched', 'delivered'].includes(fresh.status);
    expect(claimsGone && (await stockOf(el._id)) === 1000).toBe(false);
  });

  it('refuses to cancel a delivered challan', async () => {
    // /update already refuses to EDIT one, for the same reason: the
    // customer holds it as their receipt.
    const { dc } = await cutDc();
    await setStatus(dc._id, 'dispatched');
    await setStatus(dc._id, 'delivered');

    const res = await setStatus(dc._id, 'cancelled');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/fresh challan/i);
  });

  it('does not return goods the customer has signed for', async () => {
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });
    await setStatus(dc._id, 'dispatched');
    await setStatus(dc._id, 'delivered');

    await setStatus(dc._id, 'cancelled');

    expect(await stockOf(el._id)).toBe(900);
  });

  it('refuses to send a delivered challan back to draft', async () => {
    const { dc } = await cutDc();
    await setStatus(dc._id, 'dispatched');
    await setStatus(dc._id, 'delivered');
    expect((await setStatus(dc._id, 'draft')).status).toBe(409);
  });

  it('refuses to deliver something never dispatched', async () => {
    const { dc } = await cutDc();
    expect((await setStatus(dc._id, 'delivered')).status).toBe(409);
  });

  it('still cancels from draft, returning the goods', async () => {
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });
    expect((await setStatus(dc._id, 'cancelled')).status).toBe(200);
    expect(await stockOf(el._id)).toBe(1000);
  });

  it('still cancels from dispatched, returning the goods', async () => {
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });
    await setStatus(dc._id, 'dispatched');
    expect((await setStatus(dc._id, 'cancelled')).status).toBe(200);
    expect(await stockOf(el._id)).toBe(1000);
  });

  it('names what the challan could have become', async () => {
    const { dc } = await cutDc();
    const res = await setStatus(dc._id, 'delivered');
    expect(res.body.details.allowed).toEqual(['dispatched', 'cancelled']);
  });
});

describe('who can reach the challan routes at all', () => {
  it('shuts out a role the mount does not admit', async () => {
    // app.js mounts this router behind gate('accounts') — that is
    // isAdmin('admin', 'accounts') — so the whole module is already
    // restricted, and no per-route role check inside it could narrow
    // that further. Pinned because the router's own header comment used
    // to claim gating was "left per-route", which reads as though the
    // routes were open.
    const { dc } = await cutDc();
    expect((await setStatus(dc._id, 'dispatched', cookie(dispatcher, 'production'))).status)
      .toBe(403);
  });
});

describe('the lines on a challan', () => {
  const create = (body) =>
    request(app).post('/api/v2/dc/create')
      .set('Cookie', cookie()).send(body);

  const edit = (id, body) =>
    request(app).put('/api/v2/dc/update')
      .set('Cookie', cookie()).send({ id, auditReason: 'correction', ...body });

  it('refuses an elastic line with no elastic on the way in', async () => {
    const res = await create({
      type: 'elastic', customerName: 'Acme',
      items: [{ elasticName: '20mm', quantity: 100, rate: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not say which elastic/i);
  });

  it('refuses one on the way in through an EDIT too', async () => {
    // /create closes this hole and explains at length why it matters.
    // /update built its items with `elastic: item.elastic || undefined`
    // and reopened it — so a challan that could not be cut with a
    // nameless line could be edited into one, and the goods it had
    // taken out stayed out with nothing pointing at them.
    const { dc } = await cutDc();
    const res = await edit(dc._id, {
      items: [{ elasticName: '20mm', quantity: 50, rate: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not say which elastic/i);
  });

  it('leaves the stock alone when it refuses the edit', async () => {
    // The reversal runs before the re-application, so a refusal that
    // arrived halfway would leave the goods returned and never
    // re-issued. Validation happens before anything moves.
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });

    await edit(dc._id, { items: [{ elasticName: '20mm', quantity: 50 }] });

    expect(await stockOf(el._id)).toBe(900);
  });

  it('refuses a negative quantity on the way in', async () => {
    // /update checked this and /create did not, so the sign that could
    // not be edited in could be created that way.
    const el = await makeElastic();
    const res = await create({
      type: 'elastic', customerName: 'Acme',
      items: [{ elastic: el._id, elasticName: el.name, quantity: -50, rate: 10 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a zero quantity on the way in', async () => {
    const el = await makeElastic();
    const res = await create({
      type: 'elastic', customerName: 'Acme',
      items: [{ elastic: el._id, elasticName: el.name, quantity: 0, rate: 10 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a negative rate', async () => {
    // It flows into amount, then totalAmount, then onto the printed
    // challan.
    const el = await makeElastic();
    const res = await create({
      type: 'elastic', customerName: 'Acme',
      items: [{ elastic: el._id, elasticName: el.name, quantity: 10, rate: -5 }],
    });
    expect(res.status).toBe(400);
  });

  it('still lets a machine-part line be free text', async () => {
    const res = await create({
      type: 'machine_part', customerName: 'Acme',
      items: [{ description: 'Gear box', unit: 'nos', quantity: 2, rate: 1500 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.dc.totalAmount).toBe(3000);
  });

  it('still cuts an ordinary elastic challan', async () => {
    const el = await makeElastic(1000);
    const res = await create({
      type: 'elastic', customerName: 'Acme',
      items: [{ elastic: el._id, elasticName: el.name, quantity: 100, rate: 10 }],
    });
    expect(res.status).toBe(201);
    expect(await stockOf(el._id)).toBe(900);
  });
});

describe('the order number on a challan', () => {
  it('is read off the order, not taken from the caller', async () => {
    // The two are the same fact, and the body could contradict the id.
    // /list searches on the snapshot, so a mistyped number made the
    // challan unfindable by the order it was actually cut against.
    const customer = await makeCustomer();
    const el = await makeElastic(1000);
    const order = await Order.create({
      customer: customer._id, po: 'PO-1',
      date: new Date(), supplyDate: new Date(), status: 'Approved',
      elasticOrdered: [{ elastic: el._id, quantity: 500, rate: 10 }],
    });

    const res = await request(app).post('/api/v2/dc/create')
      .set('Cookie', cookie())
      .send({
        type: 'elastic', customerName: 'Acme',
        orderId: order._id,
        orderNo: 99999,                       // a lie
        items: [{ elastic: el._id, elasticName: el.name, quantity: 100, rate: 10 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.dc.orderNo).toBe(order.orderNo);
    expect(res.body.dc.orderNo).not.toBe(99999);
  });

  it('refuses an order that does not exist', async () => {
    const el = await makeElastic();
    const res = await request(app).post('/api/v2/dc/create')
      .set('Cookie', cookie())
      .send({
        type: 'elastic', customerName: 'Acme',
        orderId: new mongoose.Types.ObjectId(),
        items: [{ elastic: el._id, elasticName: el.name, quantity: 10, rate: 10 }],
      });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ON-TIME DELIVERY, COUNTED IN DAYS
//
//  `Math.ceil((dispatched - due) / 86400000)` on two timestamps. The
//  due date is stored at midnight and the despatch carries the time of
//  day it was cut, so a lorry leaving at nine in the morning ON the
//  promised date scored ceil(0.4) = 1 day late.
//
//  Every same-day despatch — the ones that hit the date exactly — was
//  counted as a miss. The figure was worst for the customers served
//  most promptly, which is the wrong direction for a metric to lie in.
// ══════════════════════════════════════════════════════════════════
describe('the on-time delivery figure', () => {
  /** A challan dispatched `hours` into the day its order was due. */
  async function shipped({ dueDaysAgo = 5, hoursIntoDay = 9, status = 'dispatched' }) {
    const customer = await makeCustomer();
    const el = await makeElastic(1000);
    const due = new Date();
    due.setDate(due.getDate() - dueDaysAgo);
    due.setHours(0, 0, 0, 0);

    const order = await Order.create({
      customer: customer._id, po: 'PO-1',
      date: new Date(), supplyDate: due, status: 'Approved',
      elasticOrdered: [{ elastic: el._id, quantity: 500, rate: 10 }],
    });

    const dispatchDate = new Date(due);
    dispatchDate.setHours(hoursIntoDay, 0, 0, 0);

    const res = await request(app).post('/api/v2/dc/create')
      .set('Cookie', cookie())
      .send({
        type: 'elastic', customerName: 'Acme', orderId: order._id,
        dispatchDate: dispatchDate.toISOString(),
        items: [{ elastic: el._id, elasticName: el.name, quantity: 10, rate: 10 }],
      });
    if (status !== 'draft') await setStatus(res.body.dc._id, status);
    return res.body.dc;
  }

  const otd = () =>
    request(app).get('/api/v2/dc/otd-stats?days=90')
      .set('Cookie', cookie());

  it('counts a despatch on the due date as on time', async () => {
    await shipped({ dueDaysAgo: 5, hoursIntoDay: 9 });

    const res = await otd();
    expect(res.body.considered).toBe(1);
    expect(res.body.onTime).toBe(1);
    expect(res.body.lateCount).toBe(0);
    expect(res.body.otdPct).toBe(100);
  });

  it('counts one the next morning as one day late, not two', async () => {
    const customer = await makeCustomer();
    const el = await makeElastic(1000);
    const due = new Date();
    due.setDate(due.getDate() - 5);
    due.setHours(0, 0, 0, 0);
    const order = await Order.create({
      customer: customer._id, po: 'PO-2',
      date: new Date(), supplyDate: due, status: 'Approved',
      elasticOrdered: [{ elastic: el._id, quantity: 500, rate: 10 }],
    });
    const dispatchDate = new Date(due);
    dispatchDate.setDate(dispatchDate.getDate() + 1);
    dispatchDate.setHours(14, 0, 0, 0);

    const created = await request(app).post('/api/v2/dc/create')
      .set('Cookie', cookie())
      .send({
        type: 'elastic', customerName: 'Acme', orderId: order._id,
        dispatchDate: dispatchDate.toISOString(),
        items: [{ elastic: el._id, elasticName: el.name, quantity: 10, rate: 10 }],
      });
    await setStatus(created.body.dc._id, 'dispatched');

    const res = await otd();
    expect(res.body.lateCount).toBe(1);
    expect(res.body.late[0].lateDays).toBe(1);
  });

  it('leaves draft challans out of the figure entirely', async () => {
    // A draft has not been dispatched, and its dispatchDate is just the
    // moment it was keyed. Paperwork in a drawer was scoring on-time.
    await shipped({ dueDaysAgo: 5, hoursIntoDay: 9, status: 'draft' });

    const res = await otd();
    expect(res.body.considered).toBe(0);
    expect(res.body.otdPct).toBeNull();
  });

  it('counts a delivered challan', async () => {
    const dc = await shipped({ dueDaysAgo: 5, hoursIntoDay: 9 });
    await setStatus(dc._id, 'delivered');

    const res = await otd();
    expect(res.body.considered).toBe(1);
    expect(res.body.onTime).toBe(1);
  });
});

describe('listing challans', () => {
  it('survives page 0', async () => {
    const res = await request(app).get('/api/v2/dc/list?page=0')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it('rejects a status that is not one', async () => {
    // An unknown status matched nothing and answered with an empty
    // list, which reads exactly like a filter that legitimately found
    // no challans.
    const res = await request(app).get('/api/v2/dc/list?status=shipped')
      .set('Cookie', cookie());
    expect(res.status).toBe(400);
  });

  it('rejects a type that is not one', async () => {
    const res = await request(app).get('/api/v2/dc/list?type=widget')
      .set('Cookie', cookie());
    expect(res.status).toBe(400);
  });

  it('still lists by a real status', async () => {
    await cutDc();
    const res = await request(app).get('/api/v2/dc/list?status=draft')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.dcs).toHaveLength(1);
  });
});

describe('deleting a draft challan', () => {
  const remove = (id, who = cookie()) =>
    request(app).delete(`/api/v2/dc/delete?id=${id}`).set('Cookie', who);

  it('returns the goods', async () => {
    const el = await makeElastic(1000);
    const { dc } = await cutDc({ quantity: 100, elastic: el });
    expect((await remove(dc._id)).status).toBe(200);
    expect(await stockOf(el._id)).toBe(1000);
  });
});

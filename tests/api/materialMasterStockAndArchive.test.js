'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MATERIAL MASTER: STOCK THAT CHANGED WITH NO RECORD, AND ARCHIVING
//
//  Found reading api/rawMaterialMaster.js and api/rawMaterialStock.js
//  line by line.
//
//  1. THE EDIT FORM WROTE THE STOCK FIGURE. "stock" was one of the
//     fields an edit may set, and the web's form sends it with every
//     save — the figure it loaded. So:
//       • typing a new figure there changed the stock with no ledger
//         row, no receipt or issue, no reason and no name: the one way
//         to move stock that left nothing behind;
//       • and changing only the minimum, on a form opened before an
//         order was approved, put back the yarn the approval had drawn.
//         Stock movements do not move the record's version, so the
//         "somebody else changed this" check did not see them.
//     Stock is changed by a receipt, an issue or an adjustment — each of
//     which records itself. The edit no longer touches it, and says so
//     when it is asked to.
//
//  2. A DELETED ORDER HELD A MATERIAL (AND A CUSTOMER) FOR GOOD. "Open"
//     was written as "neither Completed nor Cancelled", and Deleted is
//     neither: one deleted order and the material could never be
//     archived, with a message telling the person to complete or cancel
//     an order they cannot open.
//
//  3. DELETE ARCHIVED WHAT ARCHIVE REFUSES. Deleting a material in use
//     archives it instead — without the check the archive button makes,
//     so a material an open order still needs could be retired through
//     the delete button, and dropped off the buying lists.
//
//  4. NOBODY'S NAME WAS ON A STOCK ADJUSTMENT. The adjustment history
//     is described as "who wrote what off, and why" and had no who.
//
//  5. THE OLDER RECEIPT ADDRESS TOOK ANY QUANTITY. Receiving on the
//     purchase order page holds a delivery to the order (10% over, then
//     a reason). /materials/material-inward did not.
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
  const r = request(app)[method](`/api/v2${url}`).set('Cookie', cookie());
  return body === undefined ? r : r.send(body);
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'Customer', 'Elastic', 'RawMaterial', 'Supplier', 'PurchaseOrder', 'MaterialInward']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'material-master@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
async function material({ stock = 100, minStock = 10 } = {}) {
  seq += 1;
  const supplier = await M.Supplier.create({ name: `Kumar Yarns ${seq}`, phoneNumber: '9000000001' });
  const yarn = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'warp', stock, minStock, price: 300, avgCost: 300, supplier: supplier._id });
  return { supplier, yarn };
}
const fresh = (s) => M.RawMaterial.findById(s.yarn._id).select('+stockMovements').lean();
const edit = (s, body) => call('put', '/materials/edit-raw-material', { _id: String(s.yarn._id), ...body });
const adjust = async (s, adjustment, reason = 'Count correction') => {
  const res = await call('post', '/materials/bulk-adjust-stock', { adjustments: [{ _id: String(s.yarn._id), adjustment, reason }] });
  if (res.status >= 400 || res.body.errors?.length) throw new Error(`adjust failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};
/** An order that names the material in its requirement. */
async function orderNeeding(s, status) {
  seq += 1;
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const elastic = await M.Elastic.create({ name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({
    customer: customer._id, status, po: `ACME-${seq}`, date: new Date('2026-05-01'), supplyDate: new Date('2026-07-15'),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    rawMaterialRequired: [{ rawMaterial: s.yarn._id, name: s.yarn.name, requiredWeight: 10 }],
  });
  return { customer, order };
}

// ══════════════════════════════════════════════════════════════════
describe('editing a material', () => {
  it('changes what the form is for, and leaves the stock alone', async () => {
    const s = await material({ stock: 100 });
    // What the web's form sends: every field, the stock it loaded among them.
    const res = await edit(s, { name: 'Nylon 70D', price: 320, minStock: 25, stock: 100, unit: 'kg' });
    expect(res.status).toBe(200);
    expect(await fresh(s)).toMatchObject({ name: 'Nylon 70D', price: 320, minStock: 25, stock: 100 });
  });

  it('does not put back yarn that was drawn while the form was open', async () => {
    const s = await material({ stock: 100, minStock: 10 });
    const opened = await fresh(s);                       // the form loads: stock 100
    await adjust(s, -40, 'Issued to the floor');         // meanwhile, 40 kg leave

    const res = await edit(s, { minStock: 25, stock: 100, expectedVersion: opened.__v });
    // Before: 200 — stock back at 100, the 40 kg in the books again with
    // nothing on the ledger to say how.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STOCK_NOT_EDITED_HERE');
    expect(res.body.message).toMatch(/holds 60 kg/);
    expect(res.body.message).toMatch(/form sent 100/);

    const now = await fresh(s);
    expect(now.stock).toBe(60);
    expect(now.minStock).toBe(10);                       // nothing of the edit was saved
    expect(now.stockMovements.map((m) => [m.type, m.quantity])).toEqual([['STOCK_ADJUST', -40]]);
  });

  it('refuses a new stock figure, and says where stock is changed', async () => {
    const s = await material({ stock: 100 });
    const res = await edit(s, { stock: 250 });
    // Before: 200 and 250 kg, from nowhere.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Adjust stock/);
    expect((await fresh(s)).stock).toBe(100);
  });

  it('a stock figure that is the same figure is not a change', async () => {
    const s = await material({ stock: 100.5 });
    for (const stock of [100.5, '100.5', 100.5001]) {
      expect((await edit(s, { minStock: 30, stock })).status).toBe(200);
    }
    expect(await fresh(s)).toMatchObject({ stock: 100.5, minStock: 30 });
  });

  it('an edit that says nothing of stock is an edit (the form, from now on)', async () => {
    const s = await material({ stock: 100 });
    await adjust(s, -40);
    const res = await edit(s, { minStock: 25, price: 310, priceReason: 'New rate from April' });
    expect(res.status).toBe(200);
    const now = await fresh(s);
    expect(now).toMatchObject({ stock: 60, minStock: 25, price: 310 });
    expect(now.priceHistory.at(-1)).toMatchObject({ price: 310, oldPrice: 300, reason: 'New rate from April' });
  });

  it('a supplier has to be one that exists', async () => {
    const s = await material();
    const res = await edit(s, { supplier: String(new mongoose.Types.ObjectId()) });
    // Before: saved, and the material had a supplier nobody could open.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/supplier that exists/i);
    expect(String((await fresh(s)).supplier)).toBe(String(s.supplier._id));

    const other = await M.Supplier.create({ name: 'Annamalai Yarns', phoneNumber: '9000000009' });
    expect((await edit(s, { supplier: String(other._id) })).status).toBe(200);
  });
});

describe('adding a material', () => {
  const add = (body) => call('post', '/materials/create-raw-material', body);

  it('keeps its opening stock to the gram, under a supplier that exists', async () => {
    const supplier = await M.Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
    const res = await add({ name: 'Polyester 150D', category: 'weft', supplier: String(supplier._id), stock: 12.34567, price: 180 });
    expect(res.status).toBe(201);
    // Before: 12.34567.
    expect(res.body.material.stock).toBe(12.346);
  });

  it('is refused under a supplier that does not exist', async () => {
    const res = await add({ name: 'Polyester 150D', category: 'weft', supplier: String(new mongoose.Types.ObjectId()) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/supplier that exists/i);
    expect(await M.RawMaterial.countDocuments({})).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('archiving a material', () => {
  const archive = (s) => call('patch', `/materials/${s.yarn._id}/archive`, { archived: true });
  const archiveMany = (list) => call('post', '/materials/bulk/archive', { ids: list.map((s) => String(s.yarn._id)), archived: true });

  it('a deleted order does not hold it back', async () => {
    const s = await material();
    await orderNeeding(s, 'Deleted');
    const res = await archive(s);
    // Before: 400 — "1 open order still requires it. Complete or cancel them first."
    expect(res.status).toBe(200);
    expect((await fresh(s)).archived).toBe(true);
  });

  it('nor from the list\'s selection', async () => {
    const s = await material();
    await orderNeeding(s, 'Deleted');
    const res = await archiveMany([s]);
    expect(res.body).toMatchObject({ done: 1, refused: 0 });
    expect((await fresh(s)).archived).toBe(true);
  });

  it.each(['Open', 'Approved', 'InProgress'])('an order that is %s still does', async (status) => {
    const s = await material();
    await orderNeeding(s, status);
    const res = await archive(s);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 open order still requires it/);
    expect((await archiveMany([s])).body).toMatchObject({ done: 0, refused: 1 });
    expect((await fresh(s)).archived).toBeFalsy();
  });

  it.each(['Completed', 'Cancelled'])('an order that is %s does not (unchanged)', async (status) => {
    const s = await material();
    await orderNeeding(s, status);
    expect((await archive(s)).status).toBe(200);
  });
});

describe('deleting a material that is in use', () => {
  const remove = (s) => call('delete', `/materials/delete-raw-material?id=${s.yarn._id}`);

  it('does not retire one an open order still needs', async () => {
    const s = await material();
    await orderNeeding(s, 'Approved');
    const res = await remove(s);
    // Before: 200, archived — past the check the archive button makes.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 open order still requires it/);
    const now = await fresh(s);
    expect(now).toBeTruthy();
    expect(now.archived).toBeFalsy();
  });

  it('archives one that only finished work names (unchanged)', async () => {
    const s = await material();
    await orderNeeding(s, 'Completed');
    const res = await remove(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ archived: true, deleted: false });
    expect((await fresh(s)).archived).toBe(true);
  });

  it('deletes one nothing has used (unchanged)', async () => {
    const s = await material();
    const res = await remove(s);
    expect(res.body).toMatchObject({ archived: false, deleted: true });
    expect(await fresh(s)).toBeNull();
  });
});

describe('archiving a customer', () => {
  const archive = (customer) => call('patch', `/customer/${customer._id}/archive`, { archived: true });

  it('a deleted order does not hold them back', async () => {
    const s = await material();
    const { customer } = await orderNeeding(s, 'Deleted');
    const res = await archive(customer);
    // Before: 400 — "1 order is still open".
    expect(res.status).toBe(200);
    expect((await M.Customer.findById(customer._id).lean()).archived).toBe(true);
  });

  it('an open order still does', async () => {
    const s = await material();
    const { customer } = await orderNeeding(s, 'InProgress');
    const res = await archive(customer);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 order is still open/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a stock adjustment', () => {
  it('carries the name of whoever made it', async () => {
    const s = await material({ stock: 100 });
    await adjust(s, -12.5, 'Damaged in the rain');

    const [row] = (await fresh(s)).stockMovements;
    // Before: a quantity, a reason, and nobody.
    expect(row).toMatchObject({ type: 'STOCK_ADJUST', quantity: -12.5, reason: 'Damaged in the rain', byName: 'Owner' });
    expect(String(row.by)).toBe(String(admin._id));

    const history = await call('get', '/materials/adjust-history');
    expect(history.status).toBe(200);
    expect(history.body.adjustments[0]).toMatchObject({ adjustment: -12.5, reason: 'Damaged in the rain', by: 'Owner' });
  });

  it('and so does its line on the material\'s ledger', async () => {
    const s = await material({ stock: 100 });
    await adjust(s, -12.5, 'Damaged in the rain');
    await adjust(s, 30, 'Found behind the rack');

    const ledger = await call('get', `/materials/ledger?id=${s.yarn._id}`);
    expect(ledger.status).toBe(200);
    // The issue and the receipt behind an adjustment have always carried
    // their author; the ledger never showed it.
    expect(ledger.body.rows.map((r) => [r.label, r.signedQuantity, r.by])).toEqual([
      ['Stock adjustment', -12.5, 'Owner'],
      ['Stock adjustment', 30, 'Owner'],
    ]);
  });

  it('an older row with no name reads as blank, not as a fault', async () => {
    const s = await material({ stock: 100 });
    await M.RawMaterial.collection.updateOne({ _id: s.yarn._id }, {
      $push: { stockMovements: { date: new Date(), type: 'STOCK_ADJUST', quantity: -5, balance: 95, reason: 'Old count' } },
    });
    const history = await call('get', '/materials/adjust-history');
    expect(history.body.adjustments[0]).toMatchObject({ adjustment: -5, by: '' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('receiving by the older address (/materials/material-inward)', () => {
  let poSeq = 7000;
  const scene = async () => {
    const s = await material({ stock: 0 });
    const po = await M.PurchaseOrder.create({
      poNo: (poSeq += 1), supplier: s.supplier._id, status: 'Open',
      items: [{ rawMaterial: s.yarn._id, quantity: 100, price: 300, receivedQuantity: 0 }],
    });
    return { ...s, po };
  };
  const receive = (s, quantity, extra = {}) => call('post', '/materials/material-inward', {
    rawMaterialId: String(s.yarn._id), purchaseOrderId: String(s.po._id), quantity, ...extra,
  });

  it('holds a delivery to what was ordered, as the purchase order page does', async () => {
    const s = await scene();
    const res = await receive(s, 150);
    // Before: 201 — 150 kg into stock against an order for 100, no questions.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/50 over/);
    expect(res.body.message).toMatch(/10% tolerance/);
    expect((await fresh(s)).stock).toBe(0);
    expect(await M.MaterialInward.countDocuments({})).toBe(0);
  });

  it('counts what has already come in', async () => {
    const s = await scene();
    expect((await receive(s, 90)).status).toBe(201);
    // 90 + 30 is 20 over the order, not 30 over what was pending.
    const res = await receive(s, 30);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/20 over/);
  });

  it('takes it with a reason, and keeps the reason on the receipt', async () => {
    const s = await scene();
    const res = await receive(s, 150, { excessReason: 'Full bags only — supplier would not split' });
    expect(res.status).toBe(201);
    expect((await fresh(s)).stock).toBe(150);
    expect(await M.MaterialInward.findOne({}).lean()).toMatchObject({
      quantity: 150, excessQuantity: 50, excessReason: 'Full bags only — supplier would not split',
    });
  });

  it('a little over needs no reason, and the receipt says how much', async () => {
    const s = await scene();
    const res = await receive(s, 108);
    expect(res.status).toBe(201);
    expect(await M.MaterialInward.findOne({}).lean()).toMatchObject({ quantity: 108, excessQuantity: 8 });
  });

  it('an ordinary receipt is as it was', async () => {
    const s = await scene();
    expect((await receive(s, 60)).status).toBe(201);
    expect((await fresh(s)).stock).toBe(60);
    expect((await M.PurchaseOrder.findById(s.po._id).lean()).status).toBe('Partial');
    expect((await M.MaterialInward.findOne({}).lean()).excessQuantity || 0).toBe(0);
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING A MACHINE AFTER IT IS REGISTERED
//
//  Until this route existed, the only correctable things about a
//  machine were its head count, its status and its head map. A typo in
//  the ID or a hook count entered as 12 when the loom has 24 was
//  permanent, because a machine anything references cannot be deleted
//  and re-registered.
//
//  A wrong hook count is not cosmetic — checkHookFit compares it
//  against every elastic's noOfHook before allowing an assignment. So
//  the tests split four ways:
//
//    • a PATCH only touches the fields it was given, and never fills
//      in the ones it was not;
//    • the two fields that decide things — ID and NoOfHooks — are
//      gated on the loom being free, and the two that are only labels
//      are not;
//    • renaming a machine to an ID somebody else holds is refused, and
//      renaming it to the ID it already has is NOT (the machine must
//      not find itself in the duplicate check);
//    • lowering the hook count under an already-threaded map is the
//      back door to the fit rule, and it asks the same question the
//      front door does.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Machine, Elastic, User, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Machine = require('../../models/Machine');
  Elastic = require('../../models/Elastic');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'details@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMachine = (over = {}) =>
  Machine.create({
    ID: 'LOOM-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24, status: 'free', ...over,
  });

const patch = (body) =>
  request(app).patch('/api/v2/machine/update-details')
    .set('Cookie', adminCookie()).send(body);

const reload = (id) => Machine.findById(id).lean();

// Fields the Elastic schema requires but this route never reads. Kept
// in one place so a schema change does not mean editing five fixtures.
const ELASTIC_REQ = { weight: 10, pick: 20, spandexEnds: 2 };

describe('PATCH /machine/update-details — what it will change', () => {
  it('changes the manufacturer without touching anything else', async () => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id), manufacturer: 'Jakob Müller' });

    expect(res.status).toBe(200);
    const after = await reload(m._id);
    expect(after.manufacturer).toBe('Jakob Müller');
    // The fields it was not given are the point of this test.
    expect(after.ID).toBe('LOOM-01');
    expect(after.NoOfHooks).toBe(24);
    expect(after.NoOfHead).toBe(8);
  });

  it('does not wipe the fields it was not given', async () => {
    // The failure mode this guards: a PATCH that reads every field off
    // the body and writes undefined for the absent ones.
    const m = await makeMachine({ DateOfPurchase: '2019-04-01' });
    await patch({ machineId: String(m._id), NoOfHooks: 36 });

    const after = await reload(m._id);
    expect(after.DateOfPurchase).toBe('2019-04-01');
    expect(after.manufacturer).toBe('Comez');
  });

  it('normalises a new ID the same way registration does', async () => {
    const m = await makeMachine();
    await patch({ machineId: String(m._id), ID: '  loom-09 ' });
    expect((await reload(m._id)).ID).toBe('LOOM-09');
  });

  it('lets the purchase date be cleared', async () => {
    // An unknown date recorded as a guess is worse than no date.
    const m = await makeMachine({ DateOfPurchase: '2019-04-01' });
    await patch({ machineId: String(m._id), DateOfPurchase: '' });
    expect((await reload(m._id)).DateOfPurchase).toBeNull();
  });

  it('reports what actually changed, from the stored values', async () => {
    const m = await makeMachine();
    const res = await patch({
      machineId: String(m._id), manufacturer: 'Jakob Müller', NoOfHooks: 36,
    });

    expect(res.body.changes).toEqual(
      expect.arrayContaining([
        { field: 'manufacturer', from: 'Comez', to: 'Jakob Müller' },
        { field: 'NoOfHooks', from: 24, to: 36 },
      ])
    );
  });

  it('does not report a field that was sent unchanged', async () => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id), manufacturer: 'Comez' });
    expect(res.body.changes).toEqual([]);
    expect(res.body.message).toMatch(/no changes/i);
  });
});

describe('PATCH /machine/update-details — what it will refuse', () => {
  it('rejects an empty body with something a caller can act on', async () => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing to update/i);
  });

  it('needs a machineId', async () => {
    const res = await patch({ manufacturer: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/machineId is required/i);
  });

  it('404s on a machine that is not there', async () => {
    const res = await patch({
      machineId: String(new mongoose.Types.ObjectId()), manufacturer: 'X',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a blank ID rather than storing one', async () => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id), ID: '   ' });
    expect(res.status).toBe(400);
    expect((await reload(m._id)).ID).toBe('LOOM-01');
  });

  it('refuses a blank manufacturer', async () => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id), manufacturer: '  ' });
    expect(res.status).toBe(400);
  });

  it.each([[0], [-4], [2.5], ['abc']])('refuses NoOfHooks = %p', async (bad) => {
    const m = await makeMachine();
    const res = await patch({ machineId: String(m._id), NoOfHooks: bad });
    expect(res.status).toBe(400);
    expect((await reload(m._id)).NoOfHooks).toBe(24);
  });
});

describe('renaming, and the machine finding itself', () => {
  it('refuses an ID another machine already holds', async () => {
    const a = await makeMachine({ ID: 'LOOM-01' });
    await makeMachine({ ID: 'LOOM-02' });

    const res = await patch({ machineId: String(a._id), ID: 'LOOM-02' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
    expect((await reload(a._id)).ID).toBe('LOOM-01');
  });

  it('does not treat the machine as a duplicate of itself', async () => {
    // Without an `_id: { $ne }` on the duplicate lookup, a machine's own
    // row matches its own unchanged ID and every save is refused.
    const m = await makeMachine({ ID: 'LOOM-01' });
    const res = await patch({
      machineId: String(m._id), ID: 'LOOM-01', manufacturer: 'Jakob Müller',
    });

    expect(res.status).toBe(200);
    expect((await reload(m._id)).manufacturer).toBe('Jakob Müller');
  });

  it('catches the case-only rename as the same machine', async () => {
    const m = await makeMachine({ ID: 'LOOM-01' });
    const res = await patch({ machineId: String(m._id), ID: 'loom-01' });
    expect(res.status).toBe(200);
  });
});

describe('the two fields that are gated on the loom being free', () => {
  it('will not rename a running loom', async () => {
    // ProductionPlan snapshots the ID as a human label, so a rename
    // under a live job leaves the plan naming a machine that is gone.
    const m = await makeMachine({ status: 'running' });
    const res = await patch({ machineId: String(m._id), ID: 'LOOM-99' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only be changed while the machine is free/i);
    expect(res.body.message).toMatch(/running/);
    expect((await reload(m._id)).ID).toBe('LOOM-01');
  });

  it('will not change the hook count of a running loom', async () => {
    const m = await makeMachine({ status: 'running' });
    const res = await patch({ machineId: String(m._id), NoOfHooks: 36 });
    expect(res.status).toBe(400);
    expect((await reload(m._id)).NoOfHooks).toBe(24);
  });

  it('names the field it is refusing, not just the machine', async () => {
    const m = await makeMachine({ status: 'maintenance' });
    const res = await patch({ machineId: String(m._id), NoOfHooks: 36 });
    expect(res.body.message).toMatch(/NoOfHooks/);
    expect(res.body.message).toMatch(/maintenance/);
  });

  it('still corrects the manufacturer of a running loom', async () => {
    // Labels are not gated. Nothing computes from them, and refusing a
    // typo fix because a job is on the loom would be arbitrary.
    const m = await makeMachine({ status: 'running' });
    const res = await patch({ machineId: String(m._id), manufacturer: 'Jakob Müller' });

    expect(res.status).toBe(200);
    expect((await reload(m._id)).manufacturer).toBe('Jakob Müller');
  });

  it('still corrects the purchase date of a machine in maintenance', async () => {
    const m = await makeMachine({ status: 'maintenance' });
    const res = await patch({ machineId: String(m._id), DateOfPurchase: '2018-01-01' });
    expect(res.status).toBe(200);
  });

  it('refuses the whole edit if any gated field is in it', async () => {
    // Half-applying an edit — the label lands, the hook count does not —
    // would leave the user unable to tell what state they are in.
    const m = await makeMachine({ status: 'running' });
    const res = await patch({
      machineId: String(m._id), manufacturer: 'Jakob Müller', NoOfHooks: 36,
    });

    expect(res.status).toBe(400);
    const after = await reload(m._id);
    expect(after.manufacturer).toBe('Comez');
    expect(after.NoOfHooks).toBe(24);
  });
});

describe('lowering the hooks is the back door to the fit rule', () => {
  /** A machine with a 24-hook elastic threaded on head 1. */
  async function threaded() {
    const elastic = await Elastic.create({ name: 'Wide 24H', noOfHook: 24, ...ELASTIC_REQ });
    const m = await makeMachine({
      NoOfHooks: 24,
      elastics: [{ head: 1, elastic: elastic._id }],
    });
    return { m, elastic };
  }

  it('asks before stranding an elastic already on the loom', async () => {
    const { m } = await threaded();
    const res = await patch({ machineId: String(m._id), NoOfHooks: 12 });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.errorCode).toBeDefined();
    expect(res.body.message).toMatch(/needs? more/i);
    expect((await reload(m._id)).NoOfHooks).toBe(24);
  });

  it('goes ahead once somebody says so on the record', async () => {
    const { m } = await threaded();
    const res = await patch({
      machineId: String(m._id), NoOfHooks: 12, confirmHooks: true,
    });

    expect(res.status).toBe(200);
    expect((await reload(m._id)).NoOfHooks).toBe(12);
  });

  it('does not ask when the hook count is going up', async () => {
    // More capacity cannot strand anything.
    const { m } = await threaded();
    const res = await patch({ machineId: String(m._id), NoOfHooks: 48 });
    expect(res.status).toBe(200);
  });

  it('does not ask when nothing threaded needs the hooks', async () => {
    const elastic = await Elastic.create({ name: 'Narrow 8H', noOfHook: 8, ...ELASTIC_REQ });
    const m = await makeMachine({
      NoOfHooks: 24, elastics: [{ head: 1, elastic: elastic._id }],
    });
    const res = await patch({ machineId: String(m._id), NoOfHooks: 12 });

    expect(res.status).toBe(200);
    expect((await reload(m._id)).NoOfHooks).toBe(12);
  });

  it('does not ask on a loom with nothing threaded', async () => {
    const m = await makeMachine({ NoOfHooks: 24, elastics: [] });
    const res = await patch({ machineId: String(m._id), NoOfHooks: 4 });
    expect(res.status).toBe(200);
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DEMO SEED IS THE ONLY THING IN THIS REPO THAT DELETES A MACHINE
//
//  There is no delete-machine route. No service does it. The single
//  place a Machine document can be removed is this script's wipe, and
//  it runs every time the script runs, because the script is
//  idempotent by re-seeding from scratch.
//
//  That matters because two of its deletes were not scoped at all:
//
//    ShiftPlan.deleteMany({})        // "small, demo-owned"
//    EtaRatePosterior.deleteMany({}) // "safe to rebuild"
//
//  Shift plans are a module of this app, entered by hand. Posteriors
//  are weeks of learned production rates. Both lines emptied the
//  collection in whatever database the script was pointed at, to
//  reseed two demo looms.
//
//  These tests are about what SURVIVES. A wipe that removes the demo
//  data is easy; a wipe that leaves everything else standing is the
//  property worth holding, and the only one that failed.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Machine, ShiftPlan, ShiftDetail, EtaRatePosterior, Elastic;
let wipePreviousSeed, assertSafeTarget, dbNameOf, DEMO_PREFIX;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  Machine          = require('../../models/Machine');
  ShiftPlan        = require('../../models/ShiftPlan');
  ShiftDetail      = require('../../models/ShiftDetail');
  EtaRatePosterior = require('../../models/EtaRatePosterior');
  Elastic          = require('../../models/Elastic');

  // Requiring the script must not run it. If the `require.main` guard
  // is ever removed this line connects to a real database and starts
  // deleting, so it is load-bearing rather than tidiness.
  ({ wipePreviousSeed, assertSafeTarget, dbNameOf, DEMO_PREFIX } =
    require('../../scripts/seedDemoCustomer.js'));
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

const machine = (ID) =>
  Machine.create({ ID, manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 });

const plan = (date, shift) => ShiftPlan.create({ date, shift, plan: [] });

/** A closed shift, demo-tagged or not, pointing at a plan and machine. */
const shift = (description, planDoc, machineDoc) =>
  ShiftDetail.create({
    date: planDoc.date, shift: planDoc.shift, status: 'closed', description,
    job: new mongoose.Types.ObjectId(), timer: '08:00:00', productionMeters: 300,
    employee: new mongoose.Types.ObjectId(), shiftPlan: planDoc._id,
    machine: machineDoc._id,
  });

describe('the demo wipe leaves the real data standing', () => {
  test('deletes only the demo machines', async () => {
    await machine(`${DEMO_PREFIX} M1`);
    const real = await machine('LOOM-07');

    await wipePreviousSeed();

    const left = await Machine.find().select('ID').lean();
    expect(left.map((m) => m.ID)).toEqual(['LOOM-07']);
    expect(await Machine.findById(real._id)).not.toBeNull();
  });

  test('keeps a shift plan that the demo never created', async () => {
    // This is the line that read `ShiftPlan.deleteMany({})`. A real
    // plan is somebody's rostering for a real day.
    const demoPlan = await plan(new Date('2026-08-01'), 'DAY');
    const realPlan = await plan(new Date('2026-08-02'), 'DAY');
    const demoMachine = await machine(`${DEMO_PREFIX} M1`);
    await shift(`${DEMO_PREFIX} replayed shift`, demoPlan, demoMachine);

    await wipePreviousSeed();

    const left = await ShiftPlan.find().select('_id').lean();
    expect(left.map((p) => String(p._id))).toEqual([String(realPlan._id)]);
  });

  test('still removes the plan the demo did create', async () => {
    // Scoping it must not turn into leaving demo litter behind — the
    // script is re-run, and ShiftPlan has a unique index on
    // (date, shift) that a leftover would collide with.
    const demoPlan = await plan(new Date('2026-08-01'), 'DAY');
    const demoMachine = await machine(`${DEMO_PREFIX} M1`);
    await shift(`${DEMO_PREFIX} replayed shift`, demoPlan, demoMachine);

    await wipePreviousSeed();

    expect(await ShiftPlan.findById(demoPlan._id)).toBeNull();
  });

  test('keeps the learned rate for a machine the demo never touched', async () => {
    // This is the line that read `EtaRatePosterior.deleteMany({})`.
    // Every one of these is weeks of closed shifts folded into a
    // posterior, and "safe to rebuild" means rebuilt from data the
    // same wipe is deleting.
    const elastic = new mongoose.Types.ObjectId();
    const demoMachine = await machine(`${DEMO_PREFIX} M1`);
    const realMachine = await machine('LOOM-07');

    await EtaRatePosterior.create({ elastic, machine: demoMachine._id });
    await EtaRatePosterior.create({ elastic, machine: realMachine._id });

    await wipePreviousSeed();

    const left = await EtaRatePosterior.find().select('machine').lean();
    expect(left).toHaveLength(1);
    expect(String(left[0].machine)).toBe(String(realMachine._id));
  });

  test('leaves a real shift record alone', async () => {
    const realPlan = await plan(new Date('2026-08-02'), 'DAY');
    const real = await machine('LOOM-07');
    const kept = await shift('Ran 20mm white', realPlan, real);

    await wipePreviousSeed();

    expect(await ShiftDetail.findById(kept._id)).not.toBeNull();
  });

  test('does not delete an elastic that only shares a name fragment', async () => {
    // The prefix is anchored. `__DEMO__` in the middle of a name is
    // somebody's product, not the seed's.
    await Elastic.create({
      name: `Cotton ${DEMO_PREFIX} blend`, width: 20, weight: 10,
      pick: 12, spandexEnds: 4, noOfHook: 6,
    });

    await wipePreviousSeed();

    expect(await Elastic.countDocuments()).toBe(1);
  });
});

describe('refusing to seed into a live database', () => {
  test('reads the database name off the URI', () => {
    expect(dbNameOf('mongodb://localhost:27017/elastic_erp')).toBe('elastic_erp');
    expect(dbNameOf('mongodb://localhost:27017/erp_dev?retryWrites=true')).toBe('erp_dev');
    expect(dbNameOf('mongodb+srv://u:p@cluster0.mongodb.net/erp_prod')).toBe('erp_prod');
  });

  test('lets a local database through without ceremony', () => {
    expect(() => assertSafeTarget('mongodb://localhost:27017/elastic_erp')).not.toThrow();
  });

  test('refuses a URI that looks live', () => {
    // The failure this guards is not exotic: it is a shell that
    // already has MONGODB_URI exported.
    expect(() => assertSafeTarget('mongodb+srv://u:p@c.mongodb.net/erp_prod'))
      .toThrow(/refusing to seed/i);
  });

  test('names the database in the refusal, so the fix is obvious', () => {
    expect(() => assertSafeTarget('mongodb://box/erp_production'))
      .toThrow(/erp_production/);
  });

  test('goes ahead when the name is confirmed back', () => {
    const uri = 'mongodb://box/erp_production';
    process.env.DEMO_SEED_CONFIRM = 'erp_production';
    try {
      expect(() => assertSafeTarget(uri)).not.toThrow();
    } finally {
      delete process.env.DEMO_SEED_CONFIRM;
    }
  });

  test('a confirmation for a DIFFERENT database does not count', () => {
    // Otherwise the variable, once set, waves through every database
    // for the rest of the session.
    process.env.DEMO_SEED_CONFIRM = 'erp_staging';
    try {
      expect(() => assertSafeTarget('mongodb://box/erp_production'))
        .toThrow(/refusing to seed/i);
    } finally {
      delete process.env.DEMO_SEED_CONFIRM;
    }
  });
});

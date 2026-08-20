'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIAL GROUPS
//
//  The list of categories a material can belong to used to live in
//  eight hardcoded places that disagreed with each other. This is that
//  list as data, and these are the three things that had to be true
//  before it could replace them:
//
//    1. `category` — which every existing reader uses, and which the
//       model still requires — never drifts from the group's name. A
//       rename moves both, in one request, members first.
//
//    2. A database that has never seen this feature keeps working. The
//       migration is what materialises the groups; the code must be
//       correct before it runs and after it runs twice.
//
//    3. The elastic recipe picker stops emptying itself. It matched
//       four literal strings by exact case, so editing "Rubber" to
//       "rubber" in the master silently offered no rubber at all.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, MaterialGroup, RawMaterial, Supplier, User, admin, supplier;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app           = require('../../app.js');
  MaterialGroup = require('../../models/MaterialGroup');
  RawMaterial   = require('../../models/RawMaterial');
  Supplier      = require('../../models/Supplier');
  User          = require('../../models/User');
  admin = await User.create({
    name: 'Stores', email: 'groups@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  supplier = await Supplier.create({ name: 'Yarn Co', phoneNumber: '9000000001' });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const api = '/api/v2/material-group';

const createGroup = (body) =>
  request(app).post(`${api}/create`).set('Cookie', cookie()).send(body);

const createMaterial = (body) =>
  request(app).post('/api/v2/materials/create-raw-material')
    .set('Cookie', cookie())
    .send({ name: 'M', supplier: supplier._id, ...body });

// ══════════════════════════════════════════════════════════════════
describe('creating a group', () => {
  it('derives a stable code from the name', async () => {
    const res = await createGroup({ name: 'Warp Yarn', kind: 'position' });
    expect(res.status).toBe(201);
    expect(res.body.group.code).toBe('WARP_YARN');
  });

  it('refuses a second group whose name differs only in case', async () => {
    await createGroup({ name: 'Rubber' });
    const res = await createGroup({ name: 'rubber' });

    // This is the exact split the feature exists to end — "warp" and
    // "Warp" as two groups would carry it forward forever.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already a group called "Rubber"/);
  });

  it('refuses an unknown kind rather than storing it', async () => {
    const res = await createGroup({ name: 'Dyes', kind: 'colour' });
    expect(res.status).toBe(400);
  });

  it('suffixes a code rather than failing when two names collide', async () => {
    await createGroup({ name: 'Warp Yarn' });
    const res = await createGroup({ name: 'Warp-Yarn!' });
    expect(res.status).toBe(201);
    expect(res.body.group.code).toBe('WARP_YARN_2');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a material carries both, independently', () => {
  it('stores the category in its canonical spelling', async () => {
    // "rubber" from the phone and "Rubber" from the web have to land
    // on ONE value, or the recipe picker's literal match finds one and
    // not the other — the split this whole area exists to end.
    const res = await createMaterial({ category: 'RUBBER' });
    expect(res.status).toBe(201);
    expect(res.body.material.category).toBe('Rubber');
  });

  it('refuses a category outside the fixed five, and names them', async () => {
    const res = await createMaterial({ category: 'Trim Tape' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a material category/i);
    expect(res.body.message).toMatch(/material groups instead/i);
  });

  it('takes a group and a category that have nothing to do with each other', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    const res = await createMaterial({ category: 'warp', group: g._id });

    expect(res.status).toBe(201);
    // The group does NOT overwrite the category any more. That was the
    // whole fusion: filing a material under "Trim Tape" used to set its
    // category to "Trim Tape", a value the engine cannot read.
    expect(res.body.material.category).toBe('warp');
    expect(String(res.body.material.group)).toBe(String(g._id));
  });

  it('CONTROL: a category alone leaves the group unset', async () => {
    // Without this, `group` could be defaulting to something and the
    // assertion above would pass for the wrong reason.
    const res = await createMaterial({ category: 'weft' });
    expect(res.status).toBe(201);
    expect(res.body.material.group ?? null).toBeNull();
  });

  it('refuses to be filed under an archived group', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    // Nothing is in it, so that deleted rather than archived it.
    const g2 = (await createGroup({ name: 'Zip Tape' })).body.group;
    await createMaterial({ name: 'Held', category: 'warp', group: g2._id });
    await request(app).delete(`${api}/${g2._id}`).set('Cookie', cookie());

    const res = await createMaterial({ name: 'New', category: 'warp', group: g2._id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/archived/i);
  });

  it('defaults the unit to kg, which used to always come back empty', async () => {
    const res = await createMaterial({ category: 'warp' });
    expect(res.body.material.unit).toBe('kg');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('editing a material', () => {
  const edit = (id, body) =>
    request(app).put('/api/v2/materials/edit-raw-material')
      .set('Cookie', cookie()).send({ _id: id, ...body });

  it('changing the category does not disturb the group', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    const m = (await createMaterial({ category: 'warp', group: g._id })).body.material;

    const res = await edit(m._id, { category: 'weft' });
    expect(res.status).toBe(200);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.category).toBe('weft');
    expect(String(after.group)).toBe(String(g._id));
  });

  it('changing the group does not disturb the category', async () => {
    const a = (await createGroup({ name: 'Trim Tape' })).body.group;
    const b = (await createGroup({ name: 'Zip Tape' })).body.group;
    const m = (await createMaterial({ category: 'Chemicals', group: a._id })).body.material;

    await edit(m._id, { group: b._id });

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.category).toBe('Chemicals');
    expect(String(after.group)).toBe(String(b._id));
  });

  it('refuses an unknown category on edit too', async () => {
    const m = (await createMaterial({ category: 'warp' })).body.material;
    const res = await edit(m._id, { category: 'Trim Tape' });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('renaming a group', () => {
  it('does NOT touch any member category', async () => {
    // This is the behaviour that was removed. It used to rewrite
    // category on every member, which is how a group rename could put
    // a value the engine cannot read into a field it branches on.
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'A', category: 'warp',   group: g._id });
    await createMaterial({ name: 'B', category: 'Rubber', group: g._id });

    await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Edge Tape' });

    const a = await RawMaterial.findOne({ name: 'A' }).lean();
    const b = await RawMaterial.findOne({ name: 'B' }).lean();
    expect(a.category).toBe('warp');
    expect(b.category).toBe('Rubber');
    // Still filed under it — the link is what membership means.
    expect(String(a.group)).toBe(String(g._id));
  });

  it('keeps the code, which is the handle that survives a rename', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Edge Tape' });
    expect(res.body.group.code).toBe('TRIM_TAPE');
  });

  it('refuses a rename onto another group', async () => {
    await createGroup({ name: 'Trim Tape' });
    const b = (await createGroup({ name: 'Zip Tape' })).body.group;

    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: b._id, name: 'trim tape' });
    expect(res.status).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a group colour', () => {
  it('round-trips to the clients that draw the chips', async () => {
    const g = (await createGroup({ name: 'Trim Tape', colour: '#3B82F6' })).body.group;
    expect(g.colour).toBe('#3B82F6');
  });

  it('is empty until somebody picks one', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    expect(g.colour).toBe('');
  });

  it('is cleared by sending an empty string', async () => {
    const g = (await createGroup({ name: 'Trim Tape', colour: '#3B82F6' })).body.group;
    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, colour: '' });
    expect(res.body.group.colour).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
//  MEMBERSHIP IS THE LINK, AND ONLY THE LINK
//
//  It used to be "linked OR category matches the group's name",
//  because category HELD the name. With the two separated that rule
//  is actively dangerous: a group called "Rubber" would claim every
//  rubber material in the mill without anybody filing one, and
//  deleting it would archive them.
// ══════════════════════════════════════════════════════════════════
describe('membership', () => {
  const countFor = async (name) => {
    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    return res.body.groups.find((g) => g.name === name)?.materialCount;
  };

  it('counts a material that was filed under it', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'A', category: 'warp', group: g._id });
    expect(await countFor('Trim Tape')).toBe(1);
  });

  it('does NOT count a material that merely shares the name as a category', async () => {
    // A group named after a category is legal and means nothing.
    const g = (await createGroup({ name: 'Rubber Tape' })).body.group;
    await RawMaterial.create({
      name: 'Loose', category: 'Rubber', supplier: supplier._id,
    });
    expect(await countFor('Rubber Tape')).toBe(0);
    expect(g).toBeTruthy();
  });

  it('deletes a group nothing was filed under, even with matching categories about', async () => {
    const g = (await createGroup({ name: 'Rubber Tape' })).body.group;
    await RawMaterial.create({
      name: 'Loose', category: 'Rubber', supplier: supplier._id,
    });

    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    // Removed outright: nothing was ever filed under it. Under the old
    // rule this archived instead, because it counted the category.
    expect(res.body.archived).toBe(false);
  });

  it('archives one that holds materials, rather than orphaning them', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'A', category: 'warp', group: g._id });

    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.body.archived).toBe(true);
  });

  it('the dialog count agrees with the rule that decides archive-vs-delete', async () => {
    // The dialog says what will happen using the count; the server acts
    // using its own rule. If they disagree the dialog is wrong.
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'A', category: 'warp', group: g._id });

    expect(await countFor('Trim Tape')).toBe(1);
    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.body.archived).toBe(true);
  });

  it('counts archived members for the decision, but not for the display', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'Live',    category: 'warp', group: g._id });
    await createMaterial({ name: 'Shelved', category: 'warp', group: g._id });
    await RawMaterial.updateOne({ name: 'Shelved' }, { $set: { archived: true } });

    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    const row = res.body.groups.find((x) => x.name === 'Trim Tape');
    expect(row.materialCount).toBe(1);
    expect(row.totalMaterialCount).toBe(2);
  });

  it('keeps an archived group out of the pickers but findable', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ category: 'warp', group: g._id });
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    const pickers = await request(app).get(api).set('Cookie', cookie());
    expect(pickers.body.groups).toHaveLength(0);

    const settings = await request(app).get(`${api}?includeArchived=1`).set('Cookie', cookie());
    expect(settings.body.groups).toHaveLength(1);
  });

  it('restores one archived by mistake', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ category: 'warp', group: g._id });
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    await request(app).post(`${api}/restore`).set('Cookie', cookie()).send({ id: g._id });
    const pickers = await request(app).get(api).set('Cookie', cookie());
    expect(pickers.body.groups).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the list', () => {
  it('sorts by sortOrder, then name', async () => {
    await createGroup({ name: 'Zip Tape',  sortOrder: 20 });
    await createGroup({ name: 'Trim Tape', sortOrder: 10 });
    await createGroup({ name: 'Adhesive',  sortOrder: 20 });

    const res = await request(app).get(api).set('Cookie', cookie());
    expect(res.body.groups.map((g) => g.name)).toEqual(
      ['Trim Tape', 'Adhesive', 'Zip Tape']
    );
  });

  it('filters by kind', async () => {
    await createGroup({ name: 'Selvedge', kind: 'position' });
    await createGroup({ name: 'Adhesive', kind: 'material' });

    const res = await request(app).get(`${api}?kind=position`).set('Cookie', cookie());
    expect(res.body.groups.map((g) => g.name)).toEqual(['Selvedge']);
  });

  it('counts members in one query, not one per group', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'A', category: 'warp', group: g._id });
    await createMaterial({ name: 'B', category: 'warp', group: g._id });
    await createGroup({ name: 'Zip Tape' });

    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    const byName = Object.fromEntries(res.body.groups.map((x) => [x.name, x.materialCount]));
    expect(byName).toEqual({ 'Trim Tape': 2, 'Zip Tape': 0 });
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE FIXED VOCABULARY, SERVED FROM ONE PLACE
// ══════════════════════════════════════════════════════════════════
describe('GET /materials/categories', () => {
  const cats = () =>
    request(app).get('/api/v2/materials/categories').set('Cookie', cookie());

  it('serves the five, in display order', async () => {
    const res = await cats();
    expect(res.body.categories).toEqual(
      ['warp', 'weft', 'covering', 'Rubber', 'Chemicals']
    );
  });

  it('serves the positions separately, for the recipe pickers', async () => {
    const res = await cats();
    expect(res.body.positions).toEqual(['warp', 'weft', 'covering']);
  });

  it('does not change when groups are added', async () => {
    // The point of separating them: the mill can add as many groups as
    // it likes and the vocabulary the engine reads stays fixed.
    await createGroup({ name: 'Trim Tape' });
    await createGroup({ name: 'Zip Tape' });
    const res = await cats();
    expect(res.body.categories).toHaveLength(5);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE ELASTIC RECIPE PICKER
//
//  Reads `category`, and now reads a field nothing else can write
//  arbitrary values into. That is the win: before, adding a group
//  called "Trim Tape" and filing a yarn under it removed that yarn
//  from the picker, because its category stopped being "warp".
// ══════════════════════════════════════════════════════════════════
describe('the elastic recipe picker', () => {
  const pick = () =>
    request(app).get('/api/v2/materials/materialForNewElastic').set('Cookie', cookie());

  it('buckets by category', async () => {
    await RawMaterial.create({ name: 'W1', category: 'warp',     supplier: supplier._id });
    await RawMaterial.create({ name: 'R1', category: 'Rubber',   supplier: supplier._id });
    await RawMaterial.create({ name: 'C1', category: 'covering', supplier: supplier._id });

    const res = await pick();
    expect(res.body.warp.map((m) => m.name)).toEqual(['W1']);
    expect(res.body.rubber.map((m) => m.name)).toEqual(['R1']);
    expect(res.body.covering.map((m) => m.name)).toEqual(['C1']);
  });

  it('survives the casing change that used to empty it', async () => {
    // The old code was find({ category: "Rubber" }) — an exact literal,
    // so a material saved as "rubber" vanished from the picker. The
    // write path now canonicalises, so both spellings land on one.
    const res0 = await createMaterial({ name: 'R1', category: 'rubber' });
    expect(res0.body.material.category).toBe('Rubber');

    const res = await pick();
    expect(res.body.rubber.map((m) => m.name)).toEqual(['R1']);
  });

  it('is unaffected by which group a material is filed under', async () => {
    const g = (await createGroup({ name: 'Trim Tape' })).body.group;
    await createMaterial({ name: 'W1', category: 'warp', group: g._id });

    const res = await pick();
    expect(res.body.warp.map((m) => m.name)).toEqual(['W1']);
  });

  it('leaves archived materials out of the pickers', async () => {
    await RawMaterial.create({
      name: 'Retired', category: 'warp', supplier: supplier._id, archived: true,
    });
    const res = await pick();
    expect(res.body.warp).toHaveLength(0);
  });
});

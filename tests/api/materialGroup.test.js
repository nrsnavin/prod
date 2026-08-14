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
describe('a material filed under a group', () => {
  it('carries the group AND the name, so old readers still work', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    const res = await createMaterial({ group: g._id });

    expect(res.status).toBe(201);
    expect(String(res.body.material.group)).toBe(g._id);
    // Every existing reader — the MRP sheet, the forecast, stock-count
    // scope, the mobile chips — reads this string and nothing else.
    expect(res.body.material.category).toBe('Warp');
  });

  it('is filed by name too, matched case-insensitively', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    const res = await createMaterial({ category: 'rubber' });

    // Stored under the GROUP's spelling, not the caller's — this is
    // what stops mobile and web writing two variants of one group.
    expect(res.body.material.category).toBe('Rubber');
    expect(String(res.body.material.group)).toBe(g._id);
  });

  it('accepts a category naming no group, and leaves it unlinked', async () => {
    // Categories have been free text for years. Refusing an unknown one
    // would break every client that has not been updated.
    const res = await createMaterial({ category: 'Chemicals' });
    expect(res.status).toBe(201);
    expect(res.body.material.category).toBe('Chemicals');
    expect(res.body.material.group).toBeNull();
  });

  it('refuses to be filed under an archived group', async () => {
    const g = (await createGroup({ name: 'Old Yarn' })).body.group;
    // It needs a member, or the delete removes it outright rather than
    // archiving it — and a group that is gone is a different refusal.
    await createMaterial({ name: 'Existing', group: g._id });
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    const res = await createMaterial({ name: 'New one', group: g._id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/archived/);
  });

  it('inherits the group defaults, and its own figure still wins', async () => {
    const g = (await createGroup({
      name: 'Chemicals', defaultUnit: 'ltr', defaultMinStock: 25,
    })).body.group;

    const inherited = await createMaterial({ group: g._id });
    expect(inherited.body.material.unit).toBe('ltr');
    expect(inherited.body.material.minStock).toBe(25);

    const own = await createMaterial({ group: g._id, unit: 'kg', minStock: 5 });
    expect(own.body.material.unit).toBe('kg');
    expect(own.body.material.minStock).toBe(5);
  });

  it('defaults the unit to kg, which used to always come back empty', async () => {
    // api/rawMaterial.js read `m.unit || ""` long before the field
    // existed, so every unit it returned was the empty string.
    const res = await createMaterial({ category: 'Warp' });
    expect(res.body.material.unit).toBe('kg');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('renaming a group', () => {
  it('rewrites the category on every member', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    await createMaterial({ name: 'Spandex 40', group: g._id });
    await createMaterial({ name: 'Spandex 70', group: g._id });

    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie())
      .send({ id: g._id, name: 'Spandex' });

    expect(res.status).toBe(200);
    expect(res.body.materialsRenamed).toBe(2);

    const members = await RawMaterial.find({ group: g._id }).lean();
    expect(members.map((m) => m.category)).toEqual(['Spandex', 'Spandex']);
  });

  it('picks up members that only ever had the name, never the link', async () => {
    // Rows predating the migration. The rename has to find them or
    // they are stranded under a name no group has.
    await RawMaterial.create({
      name: 'Legacy yarn', category: 'Rubber', supplier: supplier._id,
    });
    const g = (await createGroup({ name: 'Rubber' })).body.group;

    await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Spandex' });

    const legacy = await RawMaterial.findOne({ name: 'Legacy yarn' }).lean();
    expect(legacy.category).toBe('Spandex');
    expect(String(legacy.group)).toBe(g._id);
  });

  it('keeps the code, which is the handle that survives a rename', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Spandex' });

    expect(res.body.group.code).toBe('RUBBER');
  });

  it('refuses a rename onto another group, before touching any member', async () => {
    const a = (await createGroup({ name: 'Warp' })).body.group;
    await createGroup({ name: 'Weft' });
    await createMaterial({ group: a._id });

    const res = await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: a._id, name: 'weft' });

    expect(res.status).toBe(409);
    const member = await RawMaterial.findOne({ group: a._id }).lean();
    expect(member.category).toBe('Warp');   // untouched
  });
});

// ══════════════════════════════════════════════════════════════════
describe('deleting a group', () => {
  it('deletes one nothing has ever used', async () => {
    const g = (await createGroup({ name: 'Typo' })).body.group;
    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    expect(res.body.archived).toBe(false);
    expect(await MaterialGroup.countDocuments()).toBe(0);
  });

  it('archives one that holds materials, rather than orphaning them', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ group: g._id });

    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.body.archived).toBe(true);
    expect(res.body.materials).toBe(1);

    // The material still reads correctly — that is the whole point.
    const m = await RawMaterial.findOne({ group: g._id }).lean();
    expect(m.category).toBe('Warp');
  });

  it('keeps an archived group out of the pickers but findable', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ group: g._id });
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    const pickers = await request(app).get(api).set('Cookie', cookie());
    expect(pickers.body.groups).toHaveLength(0);

    const settings = await request(app).get(`${api}?includeArchived=1`).set('Cookie', cookie());
    expect(settings.body.groups).toHaveLength(1);
  });

  it('restores one archived by mistake', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ group: g._id });
    await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());

    await request(app).post(`${api}/restore`).set('Cookie', cookie()).send({ id: g._id });
    const pickers = await request(app).get(api).set('Cookie', cookie());
    expect(pickers.body.groups).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the list', () => {
  it('sorts by sortOrder, then name', async () => {
    await createGroup({ name: 'Weft',     sortOrder: 20 });
    await createGroup({ name: 'Warp',     sortOrder: 10 });
    await createGroup({ name: 'Covering', sortOrder: 20 });

    const res = await request(app).get(api).set('Cookie', cookie());
    expect(res.body.groups.map((g) => g.name)).toEqual(['Warp', 'Covering', 'Weft']);
  });

  it('filters to the positions, which is what a recipe picker wants', async () => {
    await createGroup({ name: 'Warp',      kind: 'position' });
    await createGroup({ name: 'Chemicals', kind: 'material' });

    const res = await request(app).get(`${api}?kind=position`).set('Cookie', cookie());
    expect(res.body.groups.map((g) => g.name)).toEqual(['Warp']);
  });

  it('counts members in one query, not one per group', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ name: 'A', group: g._id });
    await createMaterial({ name: 'B', group: g._id });
    await createGroup({ name: 'Weft' });

    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    const byName = Object.fromEntries(res.body.groups.map((x) => [x.name, x.materialCount]));
    expect(byName).toEqual({ Warp: 2, Weft: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('filtering the material list', () => {
  it('finds rows written under any spelling of the group name', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    await createMaterial({ name: 'Linked', group: g._id });
    await RawMaterial.create({ name: 'Legacy', category: 'rubber', supplier: supplier._id });

    const res = await request(app)
      .get(`/api/v2/materials/get-raw-materials?group=${g._id}`)
      .set('Cookie', cookie());

    expect(res.body.materials.map((m) => m.name).sort()).toEqual(['Legacy', 'Linked']);
  });

  it('matches a category chip case-insensitively', async () => {
    await RawMaterial.create({ name: 'Legacy', category: 'rubber', supplier: supplier._id });
    const res = await request(app)
      .get('/api/v2/materials/get-raw-materials?category=Rubber')
      .set('Cookie', cookie());

    expect(res.body.materials).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  The picker that used to empty itself.
// ══════════════════════════════════════════════════════════════════
describe('the elastic recipe picker', () => {
  const pick = () =>
    request(app).get('/api/v2/materials/materialForNewElastic').set('Cookie', cookie());

  it('still works on a database with no groups at all', async () => {
    // The fallback: nothing has been seeded, so it matches the literal
    // keywords exactly as the endpoint always did.
    await RawMaterial.create({ name: 'W1', category: 'warp',     supplier: supplier._id });
    await RawMaterial.create({ name: 'R1', category: 'Rubber',   supplier: supplier._id });
    await RawMaterial.create({ name: 'C1', category: 'covering', supplier: supplier._id });

    const res = await pick();
    expect(res.body.warp.map((m) => m.name)).toEqual(['W1']);
    expect(res.body.rubber.map((m) => m.name)).toEqual(['R1']);
    expect(res.body.covering.map((m) => m.name)).toEqual(['C1']);
  });

  it('survives the casing change that used to empty it', async () => {
    // The old code was find({ category: "Rubber" }) — an exact literal.
    // A material stored as "rubber" matched nothing, and the elastic
    // form offered no rubber with no error of any kind.
    await RawMaterial.create({ name: 'R1', category: 'rubber', supplier: supplier._id });

    const res = await pick();
    expect(res.body.rubber.map((m) => m.name)).toEqual(['R1']);
  });

  it('follows a group through a rename', async () => {
    const g = (await createGroup({ name: 'Warp', kind: 'position' })).body.group;
    await createMaterial({ name: 'W1', group: g._id });

    await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Warp Yarn' });

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

// ══════════════════════════════════════════════════════════════════
//  COUNTING MEMBERS — three rules where there should be one
//
//  Three places decide "what is in this group", and they did not agree:
//
//    memberCount()      link OR category, name matched EXACTLY
//    ?withCounts        $group by category — link ignored entirely
//    rename's updateMany link OR category, name matched EXACTLY
//
//  Every material this app writes now carries the group's own spelling,
//  so the three agree on new data. They disagree on data that predates
//  the migration, or that an un-updated client wrote — which is exactly
//  the data the group screen exists to tidy up.
//
//  It matters because the count drives what the confirm dialog SAYS
//  will happen. A group reading "0 materials" offers to delete outright;
//  the server then archives it instead, because its own rule found
//  members. The dialog was telling the truth about a different query.
// ══════════════════════════════════════════════════════════════════
describe('what counts as being in a group', () => {
  const countFor = async (name) => {
    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    return res.body.groups.find((g) => g.name === name)?.materialCount;
  };

  it('counts a member linked by id whose category is spelled differently', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    await createMaterial({ name: 'Legacy', group: g._id });
    // A client that has not been updated rewrites the name only.
    await RawMaterial.updateOne({ name: 'Legacy' }, { $set: { category: 'rubber' } });

    expect(await countFor('Rubber')).toBe(1);
  });

  it('counts a member that carries the name only, in another case', async () => {
    await createGroup({ name: 'Rubber' });
    await RawMaterial.create({ name: 'Old', category: 'rubber', supplier: supplier._id });

    expect(await countFor('Rubber')).toBe(1);
  });

  it('agrees with the rule that decides archive-vs-delete', async () => {
    // The dialog says what will happen using the count; the server acts
    // using its own rule. If they disagree the dialog is wrong.
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    await RawMaterial.create({ name: 'Old', category: 'rubber', supplier: supplier._id });

    expect(await countFor('Rubber')).toBe(1);
    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.body.archived).toBe(true);
  });

  it('renames a member that carries the name in another case', async () => {
    const g = (await createGroup({ name: 'Rubber' })).body.group;
    await RawMaterial.create({ name: 'Old', category: 'rubber', supplier: supplier._id });

    await request(app).put(`${api}/update`)
      .set('Cookie', cookie()).send({ id: g._id, name: 'Spandex' });

    const m = await RawMaterial.findOne({ name: 'Old' }).lean();
    expect(m.category).toBe('Spandex');
  });
});

describe('a group whose only members are archived', () => {
  it('is archived rather than deleted, so the link survives', async () => {
    // An archived material still names its group. Deleting the group
    // outright leaves it pointing at nothing, and restoring the material
    // later brings back a row filed under a group that no longer exists.
    const g = (await createGroup({ name: 'Retired Yarn' })).body.group;
    await createMaterial({ name: 'Shelved', group: g._id });
    await RawMaterial.updateOne({ name: 'Shelved' }, { $set: { archived: true } });

    const res = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    expect(res.body.archived).toBe(true);
    expect(await MaterialGroup.countDocuments()).toBe(1);
  });
});

describe('the two counts the settings screen needs', () => {
  it('shows live members, and reports archived ones separately', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ name: 'Live', group: g._id });
    await createMaterial({ name: 'Shelved', group: g._id });
    await RawMaterial.updateOne({ name: 'Shelved' }, { $set: { archived: true } });

    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    const row = res.body.groups[0];
    expect(row.materialCount).toBe(1);       // what the table shows
    expect(row.totalMaterialCount).toBe(2);  // what the delete dialog needs
  });

  it('lets the dialog predict archive-vs-delete for an archived-only group', async () => {
    // Reading only the live count, the dialog said "removed outright"
    // and the server archived it. Same lie, one layer up.
    const g = (await createGroup({ name: 'Retired' })).body.group;
    await createMaterial({ name: 'Shelved', group: g._id });
    await RawMaterial.updateOne({ name: 'Shelved' }, { $set: { archived: true } });

    const list = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    const row = list.body.groups[0];
    expect(row.materialCount).toBe(0);
    expect(row.totalMaterialCount).toBe(1);

    const del = await request(app).delete(`${api}/${g._id}`).set('Cookie', cookie());
    // The dialog's prediction (total > 0 → archive) matches what happened.
    expect(row.totalMaterialCount > 0).toBe(del.body.archived);
    expect(del.body.message).toMatch(/archived and still filed under it/);
  });

  it('does not double-count a material that is both linked and named', async () => {
    const g = (await createGroup({ name: 'Warp' })).body.group;
    await createMaterial({ name: 'Both', group: g._id });   // link AND category='Warp'

    const res = await request(app).get(`${api}?withCounts=1`).set('Cookie', cookie());
    expect(res.body.groups[0].materialCount).toBe(1);
  });
});

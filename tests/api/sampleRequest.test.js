'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAMPLE REQUESTS
//
//  The point of this feature is that a sample's history survives the
//  people who made it. So the things asserted hardest here are not the
//  happy path but the ones that would quietly destroy the record: an
//  update editing what was said earlier, an entry landing after an
//  admin closed the request, a close with no reason, or a non-admin
//  reaching the close at all.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M = {}, admin, sales, production;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Customer', 'SampleRequest', 'SamplePhoto', 'Counter']) {
    M[n] = require(`../../models/${n}.js`);
  }

  admin = await M.User.create({
    name: 'Owner', email: 'sample-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  sales = await M.User.create({
    name: 'Sales Desk', email: 'sample-sales@t.co', password: 'pass1234',
    role: 'accounts', department: 'finance',
  });
  production = await M.User.create({
    name: 'Floor Lead', email: 'sample-prod@t.co', password: 'pass1234',
    role: 'production', department: 'production',
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await M.SampleRequest.deleteMany({});
  await M.SamplePhoto.deleteMany({});
  await M.Counter.deleteMany({});
});

const raise = (as = sales, body = {}) =>
  request(app).post('/api/v2/sample').set('Cookie', cookie(as)).send({
    title: 'Navy 25mm woven for Zenith',
    details: '25mm, navy, 120% elongation, matt finish. Match last year’s shade.',
    customerName: 'Zenith Apparel',
    quantity: 50,
    ...body,
  });

// ── Raising ──────────────────────────────────────────────────────
describe('raising a sample request', () => {
  it('numbers it, opens it, and opens the log with the raising itself', async () => {
    const res = await raise();
    expect(res.status).toBe(201);
    expect(res.body.sample.sampleNo).toBe(1);
    expect(res.body.sample.status).toBe('open');
    expect(res.body.sample.raisedByName).toBe('Sales Desk');

    // Entry one is the raising, so no later entry is a reply to nothing.
    expect(res.body.sample.log).toHaveLength(1);
    expect(res.body.sample.log[0]).toMatchObject({
      kind: 'created', status: 'open', byName: 'Sales Desk',
    });
  });

  it('hands out distinct numbers to concurrent requests', async () => {
    const results = await Promise.all([raise(), raise(), raise(), raise()]);
    const nos = results.map((r) => r.body.sample.sampleNo).sort((a, b) => a - b);
    expect(nos).toEqual([1, 2, 3, 4]);
  });

  it('refuses a request with no title or no details', async () => {
    expect((await raise(sales, { title: '   ' })).status).toBe(400);
    expect((await raise(sales, { details: '' })).status).toBe(400);
  });

  it('snapshots the customer name from the customer record', async () => {
    const customer = await M.Customer.create({
      name: 'Zenith Apparel Pvt Ltd', contactName: 'Meera', phoneNumber: '9000000001',
    });
    const res = await raise(sales, { customerId: customer._id, customerName: 'typo ltd' });
    expect(res.status).toBe(201);
    expect(res.body.sample.customerName).toBe('Zenith Apparel Pvt Ltd');
  });

  it('404s on a customer id that is not there, rather than inventing one', async () => {
    const res = await raise(sales, { customerId: new mongoose.Types.ObjectId() });
    expect(res.status).toBe(404);
  });

  it('rejects a quantity that is not a number, and one with a slipped decimal', async () => {
    expect((await raise(sales, { quantity: 'lots' })).status).toBe(400);
    expect((await raise(sales, { quantity: -5 })).status).toBe(400);
    expect((await raise(sales, { quantity: 5e9 })).status).toBe(400);
  });

  it('takes a sample for nobody in particular — a fair piece has no customer', async () => {
    const res = await raise(sales, { customerName: '', customerId: undefined });
    expect(res.status).toBe(201);
    expect(res.body.sample.customerName).toBe('');
  });
});

// ── The log ──────────────────────────────────────────────────────
describe('the log', () => {
  it('appends an update without touching what was written before', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    const first = body.sample.log[0];

    const res = await request(app)
      .post(`/api/v2/sample/${id}/log`)
      .set('Cookie', cookie(production))
      .send({ note: 'Warped 60 m on loom 4. Shade is a touch light.' });

    expect(res.status).toBe(201);
    expect(res.body.sample.log).toHaveLength(2);
    // The earlier entry is byte-for-byte what it was.
    expect(res.body.sample.log[0]).toMatchObject({
      kind: first.kind, note: first.note, byName: first.byName,
    });
    expect(res.body.sample.log[1]).toMatchObject({
      kind: 'update',
      note: 'Warped 60 m on loom 4. Shade is a touch light.',
      byName: 'Floor Lead',
    });
  });

  it('keeps the entries oldest-first — the log is a story, not a feed', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    for (const note of ['First trial run', 'Second trial run', 'Sent for approval']) {
      await request(app).post(`/api/v2/sample/${id}/log`).set('Cookie', cookie(production)).send({ note });
    }
    const res = await request(app).get(`/api/v2/sample/${id}`).set('Cookie', cookie(sales));
    expect(res.body.sample.log.map((e) => e.note)).toEqual([
      '', 'First trial run', 'Second trial run', 'Sent for approval',
    ]);
  });

  it('refuses an empty update rather than storing a blank line', async () => {
    const { body } = await raise();
    const res = await request(app)
      .post(`/api/v2/sample/${body.sample._id}/log`)
      .set('Cookie', cookie(production))
      .send({ note: '   ' });
    expect(res.status).toBe(400);
  });

  it('offers no route that edits or deletes an entry once written', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    const entryId = body.sample.log[0]._id;
    const put = await request(app)
      .put(`/api/v2/sample/${id}/log/${entryId}`)
      .set('Cookie', cookie(admin))
      .send({ note: 'rewritten' });
    const del = await request(app)
      .delete(`/api/v2/sample/${id}/log/${entryId}`)
      .set('Cookie', cookie(admin));
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it('404s for a sample that does not exist, and for a malformed id', async () => {
    const gone = await request(app)
      .post(`/api/v2/sample/${new mongoose.Types.ObjectId()}/log`)
      .set('Cookie', cookie(sales)).send({ note: 'anything' });
    const junk = await request(app)
      .post('/api/v2/sample/not-an-id/log')
      .set('Cookie', cookie(sales)).send({ note: 'anything' });
    expect(gone.status).toBe(404);
    expect(junk.status).toBe(404);
  });
});

// ── Completing and closing ───────────────────────────────────────
describe('an admin ending a sample', () => {
  const setStatus = (id, as, body) =>
    request(app).put(`/api/v2/sample/${id}/status`).set('Cookie', cookie(as)).send(body);

  it('marks it completed, records who and when, and logs the change', async () => {
    const { body } = await raise();
    const res = await setStatus(body.sample._id, admin, {
      status: 'completed', note: 'Approved by the customer, 50 m dispatched.',
    });

    expect(res.status).toBe(200);
    expect(res.body.sample.status).toBe('completed');
    expect(res.body.sample.closedAt).toBeTruthy();
    const last = res.body.sample.log.at(-1);
    expect(last).toMatchObject({
      kind: 'status', status: 'completed', fromStatus: 'open', byName: 'Owner',
      note: 'Approved by the customer, 50 m dispatched.',
    });
  });

  it('closes a request that went nowhere, which is a different thing from completing it', async () => {
    const { body } = await raise();
    const res = await setStatus(body.sample._id, admin, {
      status: 'closed', note: 'Customer went elsewhere.',
    });
    expect(res.status).toBe(200);
    expect(res.body.sample.status).toBe('closed');
  });

  it('will not end a sample without a reason', async () => {
    const { body } = await raise();
    const res = await setStatus(body.sample._id, admin, { status: 'completed' });
    expect(res.status).toBe(400);
    // And it really did not change.
    const after = await M.SampleRequest.findById(body.sample._id).lean();
    expect(after.status).toBe('open');
  });

  it('lets a non-terminal move through without a reason — starting work is not a decision to justify', async () => {
    const { body } = await raise();
    const res = await setStatus(body.sample._id, admin, { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.sample.status).toBe('in_progress');
    expect(res.body.sample.closedAt).toBeNull();
  });

  it('refuses a status nobody defined', async () => {
    const { body } = await raise();
    expect((await setStatus(body.sample._id, admin, { status: 'nearly' })).status).toBe(400);
  });

  it('refuses to set the status it is already at', async () => {
    const { body } = await raise();
    expect((await setStatus(body.sample._id, admin, { status: 'open' })).status).toBe(409);
  });

  // The whole reason this is an admin action.
  it('is closed to everyone who is not an admin', async () => {
    const { body } = await raise();
    for (const user of [sales, production]) {
      const res = await setStatus(body.sample._id, user, {
        status: 'completed', note: 'Marking this done myself.',
      });
      expect(res.status).toBe(403);
    }
    const after = await M.SampleRequest.findById(body.sample._id).lean();
    expect(after.status).toBe('open');
  });

  it('refuses an update once the sample is closed, naming who can undo that', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    await setStatus(id, admin, { status: 'closed', note: 'Customer went elsewhere.' });

    const res = await request(app)
      .post(`/api/v2/sample/${id}/log`)
      .set('Cookie', cookie(production))
      .send({ note: 'One more trial, just in case.' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/closed/i);
    expect(res.body.message).toMatch(/admin/i);
  });

  it('reopens a closed sample, with the reopening itself in the log', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    await setStatus(id, admin, { status: 'completed', note: 'Approved and sent.' });

    const noReason = await setStatus(id, admin, { status: 'in_progress' });
    expect(noReason.status).toBe(400);

    const res = await setStatus(id, admin, {
      status: 'in_progress', note: 'Customer came back asking for a wider version.',
    });
    expect(res.status).toBe(200);
    expect(res.body.sample.status).toBe('in_progress');
    expect(res.body.sample.closedAt).toBeNull();
    expect(res.body.sample.log.at(-1)).toMatchObject({
      kind: 'status', fromStatus: 'completed', status: 'in_progress',
    });
    // And it takes updates again.
    const again = await request(app)
      .post(`/api/v2/sample/${id}/log`)
      .set('Cookie', cookie(production)).send({ note: 'Re-warped at 32mm.' });
    expect(again.status).toBe(201);
  });
});

// ── The list ─────────────────────────────────────────────────────
describe('the list', () => {
  const seed = async () => {
    const a = (await raise(sales, { title: 'Navy 25mm for Zenith', customerName: 'Zenith' })).body.sample;
    const b = (await raise(sales, { title: 'Ecru 40mm for Harlow', customerName: 'Harlow' })).body.sample;
    const c = (await raise(sales, { title: 'Black 12mm for Zenith', customerName: 'Zenith' })).body.sample;
    await request(app).put(`/api/v2/sample/${b._id}/status`).set('Cookie', cookie(admin))
      .send({ status: 'completed', note: 'Approved and sent.' });
    return { a, b, c };
  };

  it('lists newest first with the last thing that happened on each row', async () => {
    const { c } = await seed();
    await request(app).post(`/api/v2/sample/${c._id}/log`).set('Cookie', cookie(production))
      .send({ note: 'On loom 2 tonight.' });

    const res = await request(app).get('/api/v2/sample').set('Cookie', cookie(sales));
    expect(res.status).toBe(200);
    expect(res.body.samples.map((s) => s.sampleNo)).toEqual([3, 2, 1]);
    expect(res.body.samples[0].lastEntry).toMatchObject({
      kind: 'update', note: 'On loom 2 tonight.', byName: 'Floor Lead',
    });
    expect(res.body.samples[0].logCount).toBe(2);
  });

  it('filters to the live ones, and to one status', async () => {
    await seed();
    const active = await request(app).get('/api/v2/sample?status=active').set('Cookie', cookie(sales));
    expect(active.body.samples.map((s) => s.sampleNo).sort()).toEqual([1, 3]);

    const done = await request(app).get('/api/v2/sample?status=completed').set('Cookie', cookie(sales));
    expect(done.body.samples.map((s) => s.sampleNo)).toEqual([2]);
  });

  it('searches title, customer and sample number', async () => {
    await seed();
    const byCustomer = await request(app).get('/api/v2/sample?q=zenith').set('Cookie', cookie(sales));
    expect(byCustomer.body.samples.map((s) => s.sampleNo).sort()).toEqual([1, 3]);

    const byNumber = await request(app).get('/api/v2/sample?q=2').set('Cookie', cookie(sales));
    expect(byNumber.body.samples.map((s) => s.sampleNo)).toContain(2);
  });

  // A regex metacharacter in the box must be a literal, not a pattern.
  it('treats a search term as text, not as a regular expression', async () => {
    await seed();
    const res = await request(app).get('/api/v2/sample?q=' + encodeURIComponent('Zen.th'))
      .set('Cookie', cookie(sales));
    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(0);
  });

  it('counts the tabs over every request, not over the filtered page', async () => {
    await seed();
    const res = await request(app).get('/api/v2/sample?q=zenith').set('Cookie', cookie(sales));
    expect(res.body.samples).toHaveLength(2);
    // The completed one is filtered out of the rows but still counted.
    expect(res.body.counts).toMatchObject({ open: 2, completed: 1 });
  });

  it('pages, and caps a client asking for everything', async () => {
    await seed();
    const paged = await request(app).get('/api/v2/sample?limit=2&page=2').set('Cookie', cookie(sales));
    expect(paged.body.samples).toHaveLength(1);
    expect(paged.body.total).toBe(3);
    expect(paged.body.pages).toBe(2);

    const greedy = await request(app).get('/api/v2/sample?limit=100000').set('Cookie', cookie(sales));
    expect(greedy.body.limit).toBe(100);
  });
});

// ── Photos ───────────────────────────────────────────────────────
describe('photos', () => {
  // A 1×1 PNG — real bytes, so the content type and the round trip are
  // being tested rather than a string that happens to be called a photo.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const attach = (id, as = production, opts = {}) =>
    request(app)
      .post(`/api/v2/sample/${id}/photo`)
      .set('Cookie', cookie(as))
      .field('caption', opts.caption ?? 'Trial off loom 4')
      .attach('photo', opts.buffer ?? PNG, {
        filename: opts.filename ?? 'trial.png',
        contentType: opts.contentType ?? 'image/png',
      });

  it('attaches a photo and writes it into the log', async () => {
    const { body } = await raise();
    const res = await attach(body.sample._id);

    expect(res.status).toBe(201);
    expect(res.body.photo).toMatchObject({
      caption: 'Trial off loom 4', contentType: 'image/png',
      uploadedByName: 'Floor Lead', removed: false,
    });
    expect(res.body.photo.size).toBe(PNG.length);

    const entry = res.body.sample.log.at(-1);
    expect(entry).toMatchObject({ kind: 'photo', note: 'Trial off loom 4', byName: 'Floor Lead' });
    expect(String(entry.photo)).toBe(String(res.body.photo._id));
    expect(res.body.sample.photos).toHaveLength(1);
  });

  it('serves the bytes back exactly as they went in', async () => {
    const { body } = await raise();
    const photoId = (await attach(body.sample._id)).body.photo._id;

    const file = await request(app)
      .get(`/api/v2/sample/photo/${photoId}/file`)
      .set('Cookie', cookie(sales));

    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.compare(file.body, PNG)).toBe(0);
  });

  it('never puts the bytes in a JSON response', async () => {
    const { body } = await raise();
    await attach(body.sample._id);
    const detail = await request(app)
      .get(`/api/v2/sample/${body.sample._id}`).set('Cookie', cookie(sales));
    expect(JSON.stringify(detail.body)).not.toContain('base64');
    const list = await request(app).get('/api/v2/sample').set('Cookie', cookie(sales));
    expect(JSON.stringify(list.body)).not.toContain('base64');
  });

  // Dio's MultipartFile labels every part application/octet-stream
  // unless the caller passes a media type, and which class that is moved
  // between Dio releases. Refusing the mobile app's JPEG over a header it
  // cannot easily set would be the API's problem, not the phone's.
  it('takes an unlabelled part, resolving the type from its extension', async () => {
    const { body } = await raise();
    const res = await request(app)
      .post(`/api/v2/sample/${body.sample._id}/photo`)
      .set('Cookie', cookie(production))
      .attach('photo', PNG, {
        filename: 'trial.png',
        contentType: 'application/octet-stream',
      });

    expect(res.status).toBe(201);
    expect(res.body.photo.contentType).toBe('image/png');
    // …and it is served back under the resolved type, not the sent one.
    const file = await request(app)
      .get(`/api/v2/sample/photo/${res.body.photo._id}/file`)
      .set('Cookie', cookie(sales));
    expect(file.headers['content-type']).toMatch(/image\/png/);
  });

  it('still refuses an unlabelled part whose extension is not a photo', async () => {
    const { body } = await raise();
    const res = await request(app)
      .post(`/api/v2/sample/${body.sample._id}/photo`)
      .set('Cookie', cookie(production))
      .attach('photo', Buffer.from('%PDF-1.4'), {
        filename: 'quote.pdf',
        contentType: 'application/octet-stream',
      });
    expect(res.status).toBe(400);
    expect(await M.SamplePhoto.countDocuments({})).toBe(0);
  });

  it('refuses a file that is not a photo', async () => {
    const { body } = await raise();
    const res = await attach(body.sample._id, production, {
      buffer: Buffer.from('%PDF-1.4 not a photo'),
      filename: 'quote.pdf',
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(400);
    expect(await M.SamplePhoto.countDocuments({})).toBe(0);
  });

  it('refuses a request with no file at all', async () => {
    const { body } = await raise();
    const res = await request(app)
      .post(`/api/v2/sample/${body.sample._id}/photo`)
      .set('Cookie', cookie(production))
      .field('caption', 'forgot the photo');
    expect(res.status).toBe(400);
  });

  it('refuses a photo on a closed sample, and stores no orphan bytes', async () => {
    const { body } = await raise();
    const id = body.sample._id;
    await request(app).put(`/api/v2/sample/${id}/status`).set('Cookie', cookie(admin))
      .send({ status: 'completed', note: 'Approved and sent.' });

    const res = await attach(id);
    expect(res.status).toBe(409);
    expect(await M.SamplePhoto.countDocuments({ sample: id })).toBe(0);
  });

  it('counts the photos on the list row', async () => {
    const { body } = await raise();
    await attach(body.sample._id);
    await attach(body.sample._id, production, { caption: 'Shade card' });
    const list = await request(app).get('/api/v2/sample').set('Cookie', cookie(sales));
    expect(list.body.samples[0].photoCount).toBe(2);
  });

  describe('taking one down', () => {
    // The web client sends a DELETE reason as a query param and the mobile
    // one in the body, so both are exercised here.
    const remove = (photoId, as, body = {}) =>
      request(app).delete(`/api/v2/sample/photo/${photoId}`).set('Cookie', cookie(as)).send(body);

    const removeViaQuery = (photoId, as, reason) =>
      request(app)
        .delete(`/api/v2/sample/photo/${photoId}?reason=${encodeURIComponent(reason)}`)
        .set('Cookie', cookie(as));

    it('is an admin action, and needs a reason', async () => {
      const { body } = await raise();
      const photoId = (await attach(body.sample._id)).body.photo._id;

      expect((await remove(photoId, production, { reason: 'Wrong sample.' })).status).toBe(403);
      expect((await remove(photoId, admin)).status).toBe(400);
      // Still there and still served.
      expect((await request(app).get(`/api/v2/sample/photo/${photoId}/file`)
        .set('Cookie', cookie(sales))).status).toBe(200);
    });

    it('tombstones it — the bytes go, the fact that it was there does not', async () => {
      const { body } = await raise();
      const photoId = (await attach(body.sample._id)).body.photo._id;

      const res = await remove(photoId, admin, { reason: 'Photo of the wrong sample.' });
      expect(res.status).toBe(200);

      // The log still carries the upload, plus the removal.
      const kinds = res.body.sample.log.map((e) => e.kind);
      expect(kinds).toEqual(['created', 'photo', 'photo_removed']);
      expect(res.body.sample.log.at(-1)).toMatchObject({
        note: 'Photo of the wrong sample.', byName: 'Owner',
      });

      // The photo is still listed, marked removed, with the reason.
      expect(res.body.sample.photos).toHaveLength(1);
      expect(res.body.sample.photos[0]).toMatchObject({
        removed: true, removalReason: 'Photo of the wrong sample.',
      });

      // And the bytes really are gone.
      const stored = await M.SamplePhoto.findById(photoId).lean();
      expect(stored.data).toBe('');
      const file = await request(app)
        .get(`/api/v2/sample/photo/${photoId}/file`).set('Cookie', cookie(sales));
      expect(file.status).toBe(410);
    });

    it('takes the reason from the query string too, which is how the web client sends it', async () => {
      const { body } = await raise();
      const photoId = (await attach(body.sample._id)).body.photo._id;
      const res = await removeViaQuery(photoId, admin, 'Photo of the wrong sample.');
      expect(res.status).toBe(200);
      expect(res.body.sample.photos[0]).toMatchObject({
        removed: true, removalReason: 'Photo of the wrong sample.',
      });
    });

    it('will not remove the same photo twice', async () => {
      const { body } = await raise();
      const photoId = (await attach(body.sample._id)).body.photo._id;
      await remove(photoId, admin, { reason: 'Wrong sample.' });
      expect((await remove(photoId, admin, { reason: 'Wrong sample.' })).status).toBe(409);
    });

    it('drops the count on the list row back', async () => {
      const { body } = await raise();
      const photoId = (await attach(body.sample._id)).body.photo._id;
      await attach(body.sample._id, production, { caption: 'Shade card' });
      await remove(photoId, admin, { reason: 'Wrong sample.' });
      const list = await request(app).get('/api/v2/sample').set('Cookie', cookie(sales));
      expect(list.body.samples[0].photoCount).toBe(1);
    });
  });
});

// ── Access ───────────────────────────────────────────────────────
describe('access', () => {
  it('turns away a request with no login', async () => {
    const res = await request(app).get('/api/v2/sample');
    expect([401, 403]).toContain(res.status);
  });

  it('is out of reach of a user whose feature list omits it', async () => {
    const barred = await M.User.create({
      name: 'Packer', email: 'sample-packer@t.co', password: 'pass1234',
      role: 'production', department: 'production', features: ['/jobs'],
    });
    const res = await request(app).get('/api/v2/sample').set('Cookie', cookie(barred));
    expect(res.status).toBe(403);
  });

  it('is reachable by a user whose feature list includes it', async () => {
    const allowed = await M.User.create({
      name: 'Sampler', email: 'sample-ok@t.co', password: 'pass1234',
      role: 'production', department: 'production', features: ['/samples'],
    });
    const res = await request(app).get('/api/v2/sample').set('Cookie', cookie(allowed));
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ONE CUSTOMER'S SAMPLES
//
//  The customer page shows a brief of what has been asked for. Two
//  things have to hold for that brief to be worth showing:
//
//    * it matches on the LINK, never the typed name — a prospect
//      later added to the master keeps the name they were typed with
//      and no link, and claiming those would put another company's
//      enquiries on this company's page
//    * the tab counts follow the customer — a search narrows which of
//      a set you see, but a customer filter changes WHICH SET, and
//      "3 open" beside a customer with none is worse than no number
// ══════════════════════════════════════════════════════════════════
describe("a customer's own samples", () => {
  let zenith, harlow;

  // Customer requires a contact and a phone; the names are what these
  // tests are about, the rest is ballast.
  const mkCustomer = (name) => M.Customer.create({
    name, contactName: 'Buyer', phoneNumber: '9000000000',
  });

  beforeEach(async () => {
    await M.Customer.deleteMany({});
    zenith = await mkCustomer('Zenith Apparel');
    harlow = await mkCustomer('Harlow Garments');
  });

  const listFor = (id) =>
    request(app).get(`/api/v2/sample?customerId=${id}`).set('Cookie', cookie(sales));

  it('returns only the samples linked to that customer', async () => {
    await raise(sales, { customerId: zenith._id, title: 'Zenith navy' });
    await raise(sales, { customerId: zenith._id, title: 'Zenith black' });
    await raise(sales, { customerId: harlow._id, title: 'Harlow ecru' });

    const res = await listFor(zenith._id);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.samples.map((s) => s.title).sort())
      .toEqual(['Zenith black', 'Zenith navy']);
  });

  it('does NOT claim a sample that merely names the customer', async () => {
    // The regression that matters. This one was typed for a prospect
    // before they existed in the master: same name, no link.
    await raise(sales, { customerName: 'Zenith Apparel', title: 'Typed, unlinked' });
    await raise(sales, { customerId: zenith._id, title: 'Linked' });

    const res = await listFor(zenith._id);
    expect(res.body.total).toBe(1);
    expect(res.body.samples[0].title).toBe('Linked');
  });

  it('does not sweep up a customer whose name merely resembles theirs', async () => {
    const zen = await mkCustomer('Zenith Apparel International');
    await raise(sales, { customerId: zen._id, title: 'The other Zenith' });
    await raise(sales, { customerId: zenith._id, title: 'This Zenith' });

    const res = await listFor(zenith._id);
    expect(res.body.total).toBe(1);
    expect(res.body.samples[0].title).toBe('This Zenith');
  });

  it('counts the tabs for THAT customer, not the whole mill', async () => {
    const a = await raise(sales, { customerId: zenith._id });
    await raise(sales, { customerId: harlow._id });
    await raise(sales, { customerId: harlow._id });

    // Move Zenith's one along so the counts are not all in one bucket.
    await request(app)
      .put(`/api/v2/sample/${a.body.sample._id}/status`)
      .set('Cookie', cookie(admin))
      .send({ status: 'in_progress', note: 'On the loom' });

    const res = await listFor(zenith._id);
    expect(res.body.counts.in_progress).toBe(1);
    // Harlow's two must not appear here.
    expect(res.body.counts.open).toBe(0);
  });

  it('CONTROL: with no customerId the counts are the whole mill', async () => {
    // Without this, counts scoped to nothing would look identical to
    // counts scoped correctly, and the assertion above would pass on
    // an implementation that always filtered by the first customer.
    await raise(sales, { customerId: zenith._id });
    await raise(sales, { customerId: harlow._id });

    const res = await request(app).get('/api/v2/sample').set('Cookie', cookie(sales));
    expect(res.body.counts.open).toBe(2);
  });

  it('refuses an unparseable customerId rather than ignoring it', async () => {
    // A filter that silently stops filtering is how one customer's
    // page ends up showing another customer's enquiries.
    await raise(sales, { customerId: zenith._id });
    const res = await listFor('not-an-id');
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/customerId/i);
  });

  it('returns nothing for a real id with no samples', async () => {
    await raise(sales, { customerId: zenith._id });
    const res = await listFor(new mongoose.Types.ObjectId());
    expect(res.body.total).toBe(0);
    expect(res.body.samples).toEqual([]);
  });

  it('still honours the status filter alongside the customer', async () => {
    const a = await raise(sales, { customerId: zenith._id, title: 'Moved on' });
    await raise(sales, { customerId: zenith._id, title: 'Still open' });
    await request(app)
      .put(`/api/v2/sample/${a.body.sample._id}/status`)
      .set('Cookie', cookie(admin))
      .send({ status: 'in_progress', note: 'On the loom' });

    const res = await request(app)
      .get(`/api/v2/sample?customerId=${zenith._id}&status=open`)
      .set('Cookie', cookie(sales));
    expect(res.body.total).toBe(1);
    expect(res.body.samples[0].title).toBe('Still open');
  });
});

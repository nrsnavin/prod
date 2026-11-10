'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAVE ONLY IF IT IS STILL TRUE (utils/conditionalSave.js)
//
//  saveIf(doc, filter) writes only while the stored document still
//  matches, and says false otherwise. A save that also pushes onto an
//  array (a fingerprint, a history line) reports the same miss as a
//  VersionError rather than "not found"; that used to escape saveIf, so
//  the caller's own answer was lost to the general conflict message.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { saveIf, changedMeanwhile } = require('../../utils/conditionalSave');

let mongo, Thing;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Thing = mongoose.model('ConditionalSaveThing', new mongoose.Schema({
    status: { type: String, default: 'pending' },
    note: { type: String, default: '' },
    history: { type: [String], default: [] },
  }));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => Thing.deleteMany({}));

it('saves while the stored document still matches', async () => {
  const t = await Thing.create({});
  t.status = 'rejected';
  expect(await saveIf(t, { status: 'pending' })).toBe(true);
  expect((await Thing.findById(t._id).lean()).status).toBe('rejected');
});

it('says false, and writes nothing, when it was changed meanwhile', async () => {
  const t = await Thing.create({});
  await Thing.updateOne({ _id: t._id }, { $set: { status: 'approved' } });
  t.status = 'rejected';
  t.note = 'too late';
  expect(await saveIf(t, { status: 'pending' })).toBe(false);
  expect(await Thing.findById(t._id).lean()).toMatchObject({ status: 'approved', note: '' });
});

it('the same when the save also pushes onto an array', async () => {
  const t = await Thing.create({});
  await Thing.updateOne({ _id: t._id }, { $set: { status: 'approved' } });
  t.status = 'rejected';
  t.history.push('rejected by Asha');
  expect(await saveIf(t, { status: 'pending' })).toBe(false);
  expect(await Thing.findById(t._id).lean()).toMatchObject({ status: 'approved', history: [] });
});

it('leaves the document as it found it: a later plain save is not conditional', async () => {
  const t = await Thing.create({});
  t.note = 'first';
  await saveIf(t, { status: 'pending' });
  await Thing.updateOne({ _id: t._id }, { $set: { status: 'approved' } });
  t.note = 'second';
  await t.save(); // no filter left behind from the saveIf above
  expect((await Thing.findById(t._id).lean()).note).toBe('second');
});

it('passes on a failure that is not a miss', async () => {
  const t = await Thing.create({});
  t.status = 'rejected';
  jest.spyOn(t, 'save').mockRejectedValueOnce(new Error('disk full'));
  await expect(saveIf(t, { status: 'pending' })).rejects.toThrow('disk full');
});

it('the refusal is a 409 that says what happened', () => {
  expect(changedMeanwhile('Count C-12', 'posted or cancelled')).toMatchObject({
    statusCode: 409, code: 'CHANGED_MEANWHILE',
    message: expect.stringMatching(/^Count C-12 was posted or cancelled by someone else just now/),
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE USER MODEL DOES WITH A PASSWORD
//
//  Two things held here that the hashing module cannot see:
//
//    • The pre-save hook used to fall through on the unmodified path
//      and hash the existing hash. Saving the same loaded document
//      twice stored a hash of a hash, and that person could never log
//      in again. Nothing logged it.
//
//    • A legacy bcrypt account upgrades itself on its next login —
//      in the database, without writing anything else on the document.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { closePool } = require('../../utils/workerPool');

let mongo, User, CustomerUser;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  User = require('../../models/User');
  CustomerUser = require('../../models/CustomerUser');
}, 180_000);

afterAll(async () => {
  await closePool();
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await mongoose.connection.collection('users').deleteMany({});
  await mongoose.connection.collection('customerusers').deleteMany({});
});

const stored = async (id, col = 'users') =>
  (await mongoose.connection.collection(col).findOne({ _id: id })).password;

const newUser = () =>
  User.create({ name: 'Asha', email: 'asha@mill.test', password: 'pass1234', role: 'admin', department: 'admin' });

describe('saving a user', () => {
  it('stores a hash, not the password', async () => {
    const u = await newUser();
    const h = await stored(u._id);
    expect(h).not.toBe('pass1234');
    expect(h).toMatch(/^scrypt\$/);
  });

  it('leaves the hash alone when something else changes', async () => {
    const u = await newUser();
    const before = await stored(u._id);
    const d = await User.findById(u._id).select('+password');
    d.name = 'Asha R';
    await d.save();
    expect(await stored(u._id)).toBe(before);
  });

  it('can save the same loaded document twice and still log in', async () => {
    // The fall-through bug. Confirmed against the old hook before it was
    // fixed: the second save changed the stored hash and the login failed.
    const u = await newUser();
    const before = await stored(u._id);
    const d = await User.findById(u._id).select('+password');
    d.name = 'one';
    await d.save();
    d.name = 'two';
    await d.save();
    expect(await stored(u._id)).toBe(before);
    const fresh = await User.findById(u._id).select('+password');
    expect(await fresh.comparePassword('pass1234')).toBe(true);
  });

  it('re-hashes when the password itself is changed', async () => {
    const u = await newUser();
    const d = await User.findById(u._id).select('+password');
    d.password = 'newpass99';
    await d.save();
    const fresh = await User.findById(u._id).select('+password');
    expect(await fresh.comparePassword('newpass99')).toBe(true);
    expect(await fresh.comparePassword('pass1234')).toBe(false);
  });
});

describe('an account still on bcrypt', () => {
  async function legacyUser() {
    const u = await newUser();
    // Write the old kind of hash straight in, as years of accounts have.
    await mongoose.connection.collection('users').updateOne(
      { _id: u._id },
      { $set: { password: bcrypt.hashSync('pass1234', 4) } }
    );
    return u;
  }

  it('logs in', async () => {
    const u = await legacyUser();
    const d = await User.findById(u._id).select('+password');
    expect(await d.comparePassword('pass1234')).toBe(true);
  });

  it('is upgraded to scrypt by that login', async () => {
    const u = await legacyUser();
    const d = await User.findById(u._id).select('+password');
    await d.comparePassword('pass1234');
    expect(await stored(u._id)).toMatch(/^scrypt\$/);
    // And the upgraded hash is the same password.
    const again = await User.findById(u._id).select('+password');
    expect(await again.comparePassword('pass1234')).toBe(true);
  });

  it('is NOT upgraded by a wrong password', async () => {
    const u = await legacyUser();
    const before = await stored(u._id);
    const d = await User.findById(u._id).select('+password');
    expect(await d.comparePassword('guess')).toBe(false);
    expect(await stored(u._id)).toBe(before);
  });

  it('upgrades without writing anything else that was changed on the document', async () => {
    // The upgrade is a direct update. A save() here would have written
    // the unsaved edit below as a side effect of logging in.
    const u = await legacyUser();
    const d = await User.findById(u._id).select('+password');
    d.name = 'NOT SAVED';
    await d.comparePassword('pass1234');
    const raw = await mongoose.connection.collection('users').findOne({ _id: u._id });
    expect(raw.name).toBe('Asha');
  });
});

describe('portal accounts', () => {
  it('hash, verify and upgrade the same way', async () => {
    const customer = new mongoose.Types.ObjectId();
    const c = await CustomerUser.create({
      name: 'Buyer', email: 'buyer@client.test', password: 'pass1234', customer,
    });
    expect(await stored(c._id, 'customerusers')).toMatch(/^scrypt\$/);

    await mongoose.connection.collection('customerusers').updateOne(
      { _id: c._id },
      { $set: { password: bcrypt.hashSync('pass1234', 4) } }
    );
    const d = await CustomerUser.findById(c._id).select('+password');
    expect(await d.comparePassword('pass1234')).toBe(true);
    expect(await stored(c._id, 'customerusers')).toMatch(/^scrypt\$/);
  });
});

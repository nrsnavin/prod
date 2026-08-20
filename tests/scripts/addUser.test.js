'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADD A USER
//
//  Reached for when somebody cannot get in, which means it is run under
//  pressure and its output is believed. The two things it must never do
//  are write to a database other than the one it names, and report a
//  success that did not happen.
//
//  It used to default to a hardcoded `test`. That produced the second
//  of those failures in its purest form: the script printed "Created",
//  and the account could never sign in — db/tenants.js pins `User` and
//  `CustomerUser` to the PRIMARY database, so the app never looks
//  anywhere else for a login. The default is now the database
//  MONGO_URL names, which is the only one that works.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'add-user.js');

let mongo, uri;

// Both streams, because that is what somebody running this in a
// terminal sees. Warnings go to stderr, and a test that reads only
// stdout will happily pass while the warning it is about has been
// deleted.
const run = (args) => {
  const r = spawnSync('node', [SCRIPT, ...args], {
    env: { ...process.env, MONGO_URL: uri },
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    const err = new Error(`add-user exited ${r.status}:\n${out}`);
    err.status = r.status;
    err.output = out;          // what the operator saw, both streams
    throw err;
  }
  return out;
};

const runExpectingFailure = (args) => {
  try {
    run(args);
    throw new Error('expected the script to refuse, but it succeeded');
  } catch (err) {
    if (!err.status) throw err;
    return err.output;
  }
};

/** Read the users collection of a named database, bypassing the script. */
const usersIn = (dbName) =>
  mongoose.connection.useDb(dbName, { useCache: true }).db.collection('users');

beforeEach(async () => {
  mongo = await MongoMemoryServer.create();
  uri = `${mongo.getUri()}connected_db`;
  await mongoose.connect(uri);
}, 120_000);

afterEach(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('adding a user', () => {
  it('takes a name and an email and nothing else', async () => {
    const out = run(['Navin', 'rsnavin1@gmail.com']);
    expect(out).toMatch(/✅ Created rsnavin1@gmail.com/);

    const user = await usersIn('connected_db').findOne({ email: 'rsnavin1@gmail.com' });
    expect(user).toMatchObject({
      name: 'Navin', email: 'rsnavin1@gmail.com', role: 'admin', department: 'admin',
    });
  }, 60_000);

  // Sign-in reads users from the primary and nowhere else, so this is
  // the only default that produces an account somebody can use.
  it('writes to the database MONGO_URL names', async () => {
    run(['Navin', 'rsnavin1@gmail.com']);
    expect(await usersIn('connected_db').countDocuments()).toBe(1);
    expect(await usersIn('test').countDocuments()).toBe(0);
  }, 60_000);

  it('warns when --db sends the account somewhere sign-in cannot see', async () => {
    // Still allowed — it is somebody's deliberate choice — but the one
    // consequence that matters is stated rather than discovered later.
    const out = run(['Navin', 'rsnavin1@gmail.com', '--db', 'test']);
    expect(out).toMatch(/will not be able to log in/i);
    expect(out).toMatch(/connected_db/);
  }, 60_000);

  it('says nothing extra when --db names the primary anyway', async () => {
    const out = run(['Navin', 'rsnavin1@gmail.com', '--db', 'connected_db']);
    expect(out).not.toMatch(/will not be able to log in/i);
  }, 60_000);

  it('writes somewhere else when told to', async () => {
    run(['Navin', 'rsnavin1@gmail.com', '--db', 'baluElastics']);
    expect(await usersIn('baluElastics').countDocuments()).toBe(1);
    expect(await usersIn('test').countDocuments()).toBe(0);
  }, 60_000);

  it('names the database it wrote to, so it can be checked', async () => {
    const out = run(['Navin', 'rsnavin1@gmail.com', '--db', 'baluElastics']);
    expect(out).toMatch(/writing to database: baluElastics/);
    expect(out).toMatch(/database   baluElastics/);
  }, 60_000);

  it('grants the full feature list, so nothing is missing from the sidebar', async () => {
    run(['Navin', 'rsnavin1@gmail.com']);
    const user = await usersIn('connected_db').findOne({});
    const { FEATURE_KEYS } = require('../../utils/features');
    expect(user.features).toHaveLength(FEATURE_KEYS.length);
    expect(user.features).toEqual(expect.arrayContaining(['/samples', '/order-pnl', '/orders']));
  }, 60_000);

  it('takes a narrower department when one is given', async () => {
    run(['Meera', 'meera@balu.com', '--department', 'finance']);
    const user = await usersIn('connected_db').findOne({});
    // finance maps to the accounts role — see utils/roles.js.
    expect(user).toMatchObject({ department: 'finance', role: 'accounts' });
    expect(user.features).toContain('/orders');
    expect(user.features).not.toContain('/warping');
  }, 60_000);

  // Sign-in is by emailed OTP, so a password is never typed. A shared
  // default would be a back door; a random one that is thrown away is not.
  it('sets a random password nobody knows, and does not print it', async () => {
    const out = run(['Navin', 'rsnavin1@gmail.com']);
    expect(out).not.toMatch(/password   \S/);
    const user = await usersIn('connected_db').findOne({}, { projection: { password: 1 } });
    expect(user.password).toMatch(/^\$2[aby]\$/);   // bcrypt, not plain text
  }, 60_000);

  it('prints the password only when asked, for the mobile app', async () => {
    const out = run(['Navin', 'rsnavin1@gmail.com', '--show-password']);
    expect(out).toMatch(/password   \S{20,}/);
  }, 60_000);

  it('gives two users different passwords', async () => {
    const a = run(['A', 'a@t.co', '--show-password']);
    const b = run(['B', 'b@t.co', '--show-password']);
    const grab = (s) => s.match(/password   (\S+)/)[1];
    expect(grab(a)).not.toBe(grab(b));
  }, 60_000);
});

describe('refusing', () => {
  it('will not silently overwrite an existing account', async () => {
    run(['Navin', 'rsnavin1@gmail.com']);
    const out = runExpectingFailure(['Someone Else', 'rsnavin1@gmail.com']);
    expect(out).toMatch(/already exists/);
    expect(out).toMatch(/--update/);

    const user = await usersIn('connected_db').findOne({});
    expect(user.name).toBe('Navin');   // untouched
  }, 60_000);

  it('overwrites when --update says so', async () => {
    run(['Navin', 'rsnavin1@gmail.com', '--department', 'finance']);
    run(['Navin R', 'rsnavin1@gmail.com', '--update']);
    const user = await usersIn('connected_db').findOne({});
    expect(user).toMatchObject({ name: 'Navin R', department: 'admin', role: 'admin' });
    expect(await usersIn('connected_db').countDocuments()).toBe(1);
  }, 60_000);

  // An exact-match lookup would miss a mixed-case legacy row and then
  // fail on the unique index with a driver error instead of a sentence.
  it('finds an existing account whatever case it was stored in', async () => {
    await usersIn('connected_db').insertOne({
      name: 'Old', email: 'RSNavin1@Gmail.com', password: 'x', role: 'admin',
    });
    const out = runExpectingFailure(['Navin', 'rsnavin1@gmail.com']);
    expect(out).toMatch(/already exists/);
  }, 60_000);

  it('refuses a malformed email and an unknown department', async () => {
    expect(runExpectingFailure(['Navin', 'not-an-email'])).toMatch(/does not look like an email/);
    expect(runExpectingFailure(['Navin', 'a@t.co', '--department', 'weaving']))
      .toMatch(/--department must be one of/);
    expect(await usersIn('connected_db').countDocuments()).toBe(0);
  }, 60_000);

  it('prints usage when the name or the email is missing', async () => {
    expect(runExpectingFailure(['Navin'])).toMatch(/Usage: node scripts\/add-user\.js/);
    expect(runExpectingFailure([])).toMatch(/Usage: node scripts\/add-user\.js/);
  }, 60_000);
});

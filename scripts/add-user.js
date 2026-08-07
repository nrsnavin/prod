'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADD A USER — name and email, nothing else
//
//  Usage (from the repo root on the server):
//
//    node scripts/add-user.js "Navin" rsnavin1@gmail.com
//
//    node scripts/add-user.js "Meera" meera@balu.com --department finance
//    node scripts/add-user.js "Navin" rsnavin1@gmail.com --db baluElastics
//    node scripts/add-user.js "Navin" rsnavin1@gmail.com --update
//
//  Writes to the `test` database by default, whatever MONGO_URL points
//  at — this exists to seed logins into the sandbox, and defaulting to
//  "wherever the app happens to be connected" is how you create an
//  account in the wrong one and spend an afternoon on it. --db picks
//  another.
//
//  NO PASSWORD IS ASKED FOR. The web app signs in by emailed OTP, so a
//  password is never typed; the schema requires one, so a long random
//  string is generated and thrown away. Nobody can sign in with it, and
//  there is no shared default to leak. `--show-password` prints it for
//  the mobile app, which still posts to /login-user.
//
//  The account is created as an admin with the full feature list unless
//  --department says otherwise, because the reason to reach for this
//  script is that somebody cannot get in.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const crypto = require('crypto');
const mongoose = require('mongoose');

const { DEPARTMENTS, roleForDepartment } = require('../utils/roles');
const { featuresForDepartment, sanitizeFeatures } = require('../utils/features');

const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
};

const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      // Skip this flag's value too, when it takes one.
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
})();

const [nameArg, emailArg] = positional;
const DB = flagValue('--db') || 'test';
const DEPARTMENT = flagValue('--department') || 'admin';
const UPDATE = argv.includes('--update');
const SHOW_PASSWORD = argv.includes('--show-password');

const bail = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

const USAGE =
  'Usage: node scripts/add-user.js "Full Name" email@company.com\n' +
  '         [--db <database>] [--department admin|production|packing|finance]\n' +
  '         [--update] [--show-password]';

async function main() {
  if (!nameArg || !emailArg) bail(USAGE);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg)) {
    bail(`"${emailArg}" does not look like an email address.`);
  }
  if (!DEPARTMENTS.includes(DEPARTMENT)) {
    bail(`--department must be one of: ${DEPARTMENTS.join(', ')}`);
  }
  if (!process.env.MONGO_URL) bail('MONGO_URL is not set (config/.env). Aborting.');

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URL, {});

  // The connection may be pointed anywhere; useDb puts this write in the
  // database that was asked for, over the same client.
  const connection = mongoose.connection.name === DB
    ? mongoose.connection
    : mongoose.connection.useDb(DB, { useCache: true });

  console.log(`\nConnected to cluster; writing to database: ${connection.name}`);

  const User = connection.model('User', require('../models/User').schema);

  const email = emailArg.trim().toLowerCase();
  const name = nameArg.trim();

  // Case-insensitive: accounts created through the legacy sign-up path
  // may be stored mixed-case, and an exact match would miss them and
  // then fail on the unique index instead.
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await User.findOne({ email: { $regex: `^${escaped}$`, $options: 'i' } });

  if (existing && !UPDATE) {
    console.error(
      `\n${email} already exists in "${connection.name}" ` +
      `(${existing.name}, ${existing.department || existing.role}).\n` +
      'Re-run with --update to reset it to the settings above.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const role = roleForDepartment(DEPARTMENT);
  const features = sanitizeFeatures(featuresForDepartment(DEPARTMENT));
  // Long and random. It is never typed — sign-in is by emailed OTP — so
  // there is nothing to remember and no shared default to leak.
  const password = crypto.randomBytes(18).toString('base64url');

  if (existing) {
    existing.name = name;
    existing.role = role;
    existing.department = DEPARTMENT;
    existing.features = features;
    existing.password = password;   // re-hashed by the pre-save hook
    await existing.save();
    console.log(`\n✅ Updated ${email}`);
  } else {
    await User.create({ name, email, password, role, department: DEPARTMENT, features });
    console.log(`\n✅ Created ${email}`);
  }

  console.log(`   name       ${name}`);
  console.log(`   department ${DEPARTMENT}  (role: ${role})`);
  console.log(`   features   ${features.length} granted`);
  console.log(`   database   ${connection.name}`);

  if (SHOW_PASSWORD) {
    console.log(`\n   password   ${password}`);
    console.log('   (for the mobile app; the web app signs in by emailed OTP)');
  } else {
    console.log('\nSign in on the web app with this email — it sends a one-time code.');
    console.log('A random password was set and discarded; pass --show-password to see it.');
  }

  console.log('');
  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });

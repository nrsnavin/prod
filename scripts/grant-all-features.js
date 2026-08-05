'use strict';
// ══════════════════════════════════════════════════════════════
//  GRANT ALL FEATURE ACCESS
//
//  Usage (from the repo root on the server):
//
//    node scripts/grant-all-features.js rsnavin1@gmail.com
//
//    # also promote the account to the admin department first, so
//    # "everything" really is every module rather than everything the
//    # current department can reach:
//    node scripts/grant-all-features.js rsnavin1@gmail.com --admin
//
//  Grants every feature the account's department can reach. Features are
//  a SUBSET of what the role gate allows, so storing keys outside that
//  scope would be theatre — the gate refuses them anyway. For an
//  admin-department account the scope IS the whole catalog.
//
//  Related: an account with NO features field defers to the role gate and
//  already reaches everything (see middleware/auth.js). This writes an
//  explicit full list instead, which is what the Users screen shows and
//  what survives a later edit there.
// ══════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');

const { featuresForDepartment, sanitizeFeatures } = require('../utils/features');
const { roleForDepartment } = require('../utils/roles');

const [emailArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PROMOTE = process.argv.includes('--admin');

async function main() {
  if (!emailArg) {
    console.error('Usage: node scripts/grant-all-features.js email@company.com [--admin]');
    process.exit(1);
  }
  if (!process.env.MONGO_URL) {
    console.error('MONGO_URL is not set (config/.env). Aborting.');
    process.exit(1);
  }

  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGO_URL, {});
  console.log(`Connected to database: ${mongoose.connection.name}`);

  const User = require('../models/User');
  const normalized = emailArg.trim().toLowerCase();

  // Case-insensitive lookup: accounts created through the legacy /sign-up
  // path may be stored with mixed-case emails, and an exact match on the
  // lowercased input would silently never find them.
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const user = await User.findOne({ email: { $regex: `^${escaped}$`, $options: 'i' } });

  if (!user) {
    console.error(`No user found with email ${normalized}. Nothing changed.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Found: ${user.name} <${user.email}>`);
  console.log(`  department : ${user.department || '(none)'}`);
  console.log(`  role       : ${user.role}`);
  console.log(`  features   : ${Array.isArray(user.features)
    ? (user.features.length ? `${user.features.length} granted` : 'NONE (explicitly empty — currently blocked everywhere)')
    : 'not configured (defers to the role gate)'}`);

  if (PROMOTE && user.department !== 'admin') {
    user.department = 'admin';
    user.role = roleForDepartment('admin');
    console.log(`  → promoting to the admin department (role: ${user.role})`);
  }

  const scope = user.department || user.role;
  const granted = sanitizeFeatures(featuresForDepartment(scope));

  if (granted.length === 0) {
    console.error(
      `Refusing: "${scope}" resolves to no features. Pass --admin to promote the ` +
      `account to the admin department first.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  user.features = granted;
  await user.save();

  console.log(`\n✅ Granted ${granted.length} feature(s) to ${user.email}:`);
  for (const k of granted) console.log(`   ${k}`);
  if (!PROMOTE && user.department !== 'admin') {
    console.log(
      `\nNote: this is everything the "${scope}" department can reach, not the whole ` +
      `catalog. Re-run with --admin to grant every module.`
    );
  }
  console.log('\nThe user must sign out and back in for the web app to pick up the new set.');

  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });

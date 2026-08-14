'use strict';
// ══════════════════════════════════════════════════════════════════
//  SET A PASSWORD ON AN EXISTING ACCOUNT
//
//  Usage (from the repo root on the server):
//
//    node scripts/set-password.js rsnavin1@gmail.com --password 'navin27'
//
//    node scripts/set-password.js a@x.com b@x.com --password 'navin27'
//    node scripts/set-password.js a@x.com --password 'navin27' --db baluElastics
//
//  ── Why this exists ──────────────────────────────────────────────
//  The web app signs in by emailed OTP, so scripts/add-user.js never
//  asks for a password: it generates a long random one and throws it
//  away. That is right until the mail server is down, at which point
//  nobody can sign in at all and there is no password to fall back on
//  because none was ever chosen.
//
//  This sets one on an account that already exists. It does NOT create
//  accounts — a typo in an email address should be an error, not a new
//  admin user nobody knows about. Use add-user.js for that.
//
//  ── Which database ───────────────────────────────────────────────
//  Defaults to the database MONGO_URL points at, i.e. the live one the
//  app is using. add-user.js defaults to `test` instead, because its
//  job is seeding a sandbox; this one's job is getting a locked-out
//  person back into production, so it goes where the app is unless
//  --db says otherwise. It prints the database name before writing —
//  read that line before trusting the result.
//
//  ── The password is not echoed ───────────────────────────────────
//  It is already in your shell history from the command you typed;
//  printing it again would put it in any log that captures stdout, on
//  a machine where those logs are read by more people than know the
//  password. The script verifies the hash itself and reports that.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
};

const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
})();

const PASSWORD = flagValue('--password');
const DB = flagValue('--db');

const bail = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

const USAGE =
  'Usage: node scripts/set-password.js <email> [<email> ...] --password <password>\n' +
  '         [--db <database>]';

async function main() {
  if (positional.length === 0) bail(USAGE);
  if (!PASSWORD) bail(`A password is required.\n\n${USAGE}`);

  // The schema's own floor. Enforced here so the failure is one clear
  // message rather than a mongoose ValidationError per account, halfway
  // through a list.
  if (PASSWORD.length < 4) {
    bail('Password must be at least 4 characters (models/User.js minLength).');
  }

  const emails = positional.map((e) => e.trim().toLowerCase());
  for (const e of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      bail(`"${e}" does not look like an email address.`);
    }
  }

  if (!process.env.MONGO_URL) bail('MONGO_URL is not set (config/.env). Aborting.');

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URL, {});

  const connection = !DB || mongoose.connection.name === DB
    ? mongoose.connection
    : mongoose.connection.useDb(DB, { useCache: true });

  console.log(`\nConnected to cluster; writing to database: ${connection.name}`);

  const User = connection.model('User', require('../models/User').schema);

  let failures = 0;

  for (const email of emails) {
    // Case-insensitive: accounts made through the legacy sign-up path
    // may be stored mixed-case, and an exact match would report "no
    // such account" for one that is sitting right there.
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({
      email: { $regex: `^${escaped}$`, $options: 'i' },
    }).select('+password');

    if (!user) {
      console.error(
        `  ✗ ${email} — no such account in "${connection.name}". ` +
        `Create it with scripts/add-user.js, or check --db.`
      );
      failures += 1;
      continue;
    }

    // Assigned, then saved: models/User.js hashes in a pre-save hook, so
    // writing the field directly with updateOne would store the password
    // in the clear.
    user.password = PASSWORD;
    await user.save({ validateBeforeSave: false });

    // Read it back and check it, rather than trusting that the save did
    // what it looked like it did. The whole reason to run this script is
    // that somebody cannot get in; "probably worked" is not worth much
    // to them.
    const fresh = await User.findById(user._id).select('+password');
    const ok = await bcrypt.compare(PASSWORD, fresh.password || '');

    if (ok) {
      console.log(`  ✓ ${fresh.email} (${fresh.name}, ${fresh.role}) — password set and verified`);
    } else {
      console.error(`  ✗ ${fresh.email} — saved, but the password does not verify. Do not rely on it.`);
      failures += 1;
    }
  }

  await mongoose.disconnect();

  if (failures > 0) {
    console.error(`\n${failures} of ${emails.length} failed.\n`);
    process.exit(1);
  }

  console.log(
    `\nDone. Sign in at the web app: enter the email, and when the code ` +
    `does not arrive use "Sign in with your password".\n`
  );
}

main().catch((err) => {
  console.error('\nFailed:', err.message, '\n');
  process.exit(1);
});

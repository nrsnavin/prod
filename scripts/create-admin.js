'use strict';
// ══════════════════════════════════════════════════════════════
//  CREATE ADMIN USER
//
//  Usage (from the repo root on the server):
//
//    node scripts/create-admin.js "Name" email@company.com password123
//
//    # or with flags to update an existing user's password/role:
//    node scripts/create-admin.js "Name" email@company.com password123 --update
//
//  Creates a full-access admin login (role: admin, department: admin)
//  through the real User model, so the password is bcrypt-hashed by the
//  same pre-save hook as normal signup. Refuses to touch an existing
//  email unless --update is passed.
// ══════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');

const [name, email, password] = process.argv.slice(2);
const UPDATE = process.argv.includes('--update');

async function main() {
  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js "Name" email@company.com password [--update]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Refusing: password must be at least 8 characters for an admin account.');
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
  const normalized = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalized }).select('+password');

  if (existing && !UPDATE) {
    console.error(`A user with ${normalized} already exists (role: ${existing.role}).`);
    console.error('Re-run with --update to reset their password and promote to admin.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (existing) {
    existing.name = name.trim();
    existing.password = password;        // pre-save hook re-hashes
    existing.role = 'admin';
    existing.department = 'admin';
    await existing.save();
    console.log(`✅ Updated ${normalized} — password reset, promoted to admin.`);
  } else {
    await User.create({
      name: name.trim(),
      email: normalized,
      password,                          // hashed by the pre-save hook
      role: 'admin',
      department: 'admin',
    });
    console.log(`✅ Admin created: ${normalized}`);
  }

  console.log('Log in on the web app with this email + password. Manage further users from the Users screen.');
  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });

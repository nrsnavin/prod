/**
 * seed.js — create a demo admin user
 * Run once on the server: node seed.js
 */

if (process.env.NODE_ENV !== 'PRODUCTION') {
  require('dotenv').config({ path: 'config/.env' });
}

const mongoose = require('mongoose');
const User     = require('./models/User');

const DEMO_USER = {
  name:     'Demo Admin',
  email:    'admin@anutapes.com',
  password: 'Admin@1234',
  role:     'admin',
};

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB');

    const existing = await User.findOne({ email: DEMO_USER.email });
    if (existing) {
      console.log(`User "${DEMO_USER.email}" already exists — nothing to do.`);
      process.exit(0);
    }

    // User.create triggers the pre-save bcrypt hook, so the password
    // is hashed automatically before insertion.
    const user = await User.create(DEMO_USER);
    console.log('Demo user created successfully:');
    console.log(`  Name  : ${user.name}`);
    console.log(`  Email : ${user.email}`);
    console.log(`  Role  : ${user.role}`);
    console.log(`  ID    : ${user._id}`);
    console.log('\nLogin credentials:');
    console.log(`  Email    : ${DEMO_USER.email}`);
    console.log(`  Password : ${DEMO_USER.password}`);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();

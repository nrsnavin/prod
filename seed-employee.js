/**
 * seed-employee.js — create a demo Employee + linked User
 *
 * Run once:
 *   node seed-employee.js
 *
 * Prints the login credentials for the new employee user. Idempotent:
 * re-running with the same email is a no-op (just prints the existing
 * record's id and skips). The script:
 *   1. Connects to Mongo using config/.env (or prod env).
 *   2. Creates an Employee doc if one with the demo phone doesn't
 *      already exist.
 *   3. Creates a User doc linked to that Employee (role: "employee").
 *   4. Backfills User.employee on a pre-existing user if the link is
 *      missing — useful when the user was created before the
 *      User.employee field shipped.
 */

if (process.env.NODE_ENV !== 'PRODUCTION') {
  require('dotenv').config({ path: 'config/.env' });
}

const mongoose = require('mongoose');
const User     = require('./models/User');
const Employee = require('./models/Employee');

const DEMO_EMPLOYEE = {
  name:        'Demo Worker',
  phoneNumber: '9999900001',
  role:        'weaver',
  department:  'weaving',
  skill:       3,
  hourlyRate:  120,
};

const DEMO_USER = {
  name:     'Demo Worker',
  email:    'worker@anutapes.com',
  password: 'Worker@1234',
  role:     'employee',
};

const MONGO_URL =
  process.env.MONGO_URL ||
  'mongodb+srv://navin:navin@cluster0.ftoq7bw.mongodb.net/?appName=Cluster0';

(async () => {
  try {
    await mongoose.connect(MONGO_URL);
    console.log('Connected to MongoDB');

    // ── 1. Employee ─────────────────────────────────────────
    let employee = await Employee.findOne({ phoneNumber: DEMO_EMPLOYEE.phoneNumber });
    if (!employee) {
      employee = await Employee.create(DEMO_EMPLOYEE);
      console.log(`✔ Employee created: ${employee.name} (${employee._id})`);
    } else {
      console.log(`• Employee already exists: ${employee.name} (${employee._id})`);
    }

    // ── 2. User ─────────────────────────────────────────────
    let user = await User.findOne({ email: DEMO_USER.email });
    if (!user) {
      // User.create runs the pre-save bcrypt hook so the password
      // is hashed automatically.
      user = await User.create({ ...DEMO_USER, employee: employee._id });
      console.log(`✔ User created and linked to employee`);
    } else {
      console.log(`• User already exists: ${user.email}`);
      if (!user.employee) {
        user.employee = employee._id;
        await user.save();
        console.log(`  ↳ backfilled User.employee = ${employee._id}`);
      } else if (user.employee.toString() !== employee._id.toString()) {
        console.log(`  ⚠ User.employee points elsewhere: ${user.employee}. Leaving as-is.`);
      } else {
        console.log(`  ↳ already linked correctly`);
      }
    }

    console.log('\n──────────────────────────────────────────────');
    console.log(' Worker Portal login');
    console.log('──────────────────────────────────────────────');
    console.log(`  Email    : ${DEMO_USER.email}`);
    console.log(`  Password : ${DEMO_USER.password}`);
    console.log(`  Employee : ${employee._id}`);
    console.log('──────────────────────────────────────────────\n');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();

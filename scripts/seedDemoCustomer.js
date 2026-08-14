#!/usr/bin/env node
"use strict";
//
// Seed the database with a demo customer + full portal-facing data
// surface, so a portal log-in shows realistic content end-to-end.
//
// Idempotent: every demo entity is tagged with a known marker
// (`__demo: true` in metadata, or a stable name prefix) so re-running
// wipes the previous seed and re-creates fresh, deterministic data.
//
// Run (against your local Mongo):
//   node scripts/seedDemoCustomer.js
//
// Override defaults via env:
//   DEMO_EMAIL=demo@portal.test
//   DEMO_PASSWORD=demo1234
//   DEMO_CUSTOMER_NAME="Demo Textiles Pvt Ltd"
//   MONGODB_URI=mongodb://localhost:27017/elastic_erp
//
// What you get:
//   - 1 Customer org + 1 CustomerUser (login credentials)
//   - 3 raw materials, 3 elastics
//   - 2 machines (4-head + 6-head) with heads pre-mapped to elastics
//   - 30 closed shifts spread across 25 days → seeds the per-pair
//     Bayesian posterior past the informative threshold
//   - 6 orders covering every status the portal can render:
//       Open, Approved, InProgress (mostly-done), InProgress (late),
//       Completed, Cancelled
//   - 3 JobOrders for the in-flight orders, linked to machines
//   - 2 Delivery challans (dispatched + delivered) for the completed
//     order
//   - EtaRatePosterior docs are populated naturally by replaying
//     each closed shift through updatePairPosterior, so /running-eta
//     shows "learned" rate sources, not cold-start fallback.
//
const path     = require("path");
const mongoose = require("mongoose");

// Load .env the same way app.js does so this works out of the box
// against any environment that already runs the API.
if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({ path: path.resolve(__dirname, "../config/.env") });
}

// Plugins must be registered before any model is required.
const auditFields = require("../models/plugins/auditFields.js");
mongoose.plugin(auditFields);

const Customer         = require("../models/Customer.js");
const CustomerUser     = require("../models/CustomerUser.js");
const RawMaterial      = require("../models/RawMaterial.js");
const Elastic          = require("../models/Elastic.js");
const Machine          = require("../models/Machine.js");
const Order            = require("../models/Order.js");
const JobOrder         = require("../models/JobOrder.js");
const ShiftDetail      = require("../models/ShiftDetail.js");
const ShiftPlan        = require("../models/ShiftPlan.js");
const Employee         = require("../models/Employee.js");
const User             = require("../models/User.js");
const DeliveryChallan  = require("../models/DeliveryChallan.js");
const EtaRatePosterior = require("../models/EtaRatePosterior.js");

const { updatePairPosterior } = require("../utils/etaPosterior.js");

// ── Config ───────────────────────────────────────────────────────
const DEMO_PREFIX        = "__DEMO__";
const DEMO_EMAIL         = (process.env.DEMO_EMAIL    || "demo@portal.test").toLowerCase();
const DEMO_PASSWORD      = process.env.DEMO_PASSWORD  || "demo1234";
const DEMO_CUSTOMER_NAME = process.env.DEMO_CUSTOMER_NAME || `${DEMO_PREFIX} Demo Textiles Pvt Ltd`;
const MONGO_URI          = process.env.MONGODB_URI
  || "mongodb://localhost:27017/elastic_erp";

// ─────────────────────────────────────────────────────────────────
const log = (...a) => console.log("[demo-seed]", ...a);
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

const today    = new Date();
const daysAgo  = (n) => new Date(today.getTime() - n * 86_400_000);
const daysAhead = (n) => new Date(today.getTime() + n * 86_400_000);

// ─────────────────────────────────────────────────────────────────
async function main() {
  log("connecting to", MONGO_URI);
  await mongoose.connect(MONGO_URI);

  await wipePreviousSeed();

  log("seeding identity…");
  const customer     = await seedCustomer();
  const customerUser = await seedCustomerUser(customer);

  log("seeding catalog…");
  const rawMats = await seedRawMaterials();
  const elastics = await seedElastics(rawMats);
  const employee = await seedEmployee();
  const machines = await seedMachines(elastics);

  log("seeding production history (30 shifts → posterior)…");
  await seedClosedShifts(machines, employee);

  log("seeding orders + jobs…");
  const orders = await seedOrders(customer, elastics);
  await seedJobs(orders, customer, machines, elastics);

  log("seeding delivery challans…");
  await seedDeliveryChallans(orders.completed, customer, elastics);

  log("");
  log("✓ done");
  log("  customer org   :", customer.name, dim(`(${customer._id})`));
  log("  portal login   :", DEMO_EMAIL);
  log("  portal password:", DEMO_PASSWORD);
  log("");
  log(dim("  Re-run this script any time — it wipes previous demo data first."));

  await mongoose.disconnect();
}

// ─────────────────────────────────────────────────────────────────
// Idempotency — wipe everything tagged with the demo marker.
// ─────────────────────────────────────────────────────────────────
async function wipePreviousSeed() {
  const cust = await Customer.findOne({ name: DEMO_CUSTOMER_NAME }).lean();
  if (cust) {
    log("removing previous demo customer", dim(cust._id.toString()));
    const orders = await Order.find({ customer: cust._id }).select("_id").lean();
    const orderIds = orders.map((o) => o._id);
    if (orderIds.length) {
      await DeliveryChallan.deleteMany({ order: { $in: orderIds } });
      await JobOrder.deleteMany({ order: { $in: orderIds } });
      await Order.deleteMany({ _id: { $in: orderIds } });
    }
    await CustomerUser.deleteMany({ customer: cust._id });
    await Customer.deleteOne({ _id: cust._id });
  }

  // Defensive — wipe any orphaned CustomerUser at the demo email
  // even if its parent Customer doc was already gone.
  await CustomerUser.deleteMany({ email: DEMO_EMAIL });

  // Demo-tagged catalog + ops state — same prefix.
  await ShiftDetail.deleteMany({ description: new RegExp(`^${DEMO_PREFIX}`) });
  await ShiftPlan.deleteMany({});      // small, demo-owned
  await Machine.deleteMany({ ID:        new RegExp(`^${DEMO_PREFIX}`) });
  await Elastic.deleteMany({ name:      new RegExp(`^${DEMO_PREFIX}`) });
  await RawMaterial.deleteMany({ name:  new RegExp(`^${DEMO_PREFIX}`) });
  await Employee.deleteMany({ name:     new RegExp(`^${DEMO_PREFIX}`) });
  await User.deleteMany({ name:         new RegExp(`^${DEMO_PREFIX}`) });
  await EtaRatePosterior.deleteMany({}); // posteriors are global; safe to rebuild
}

// ─────────────────────────────────────────────────────────────────
async function seedCustomer() {
  return Customer.create({
    name:        DEMO_CUSTOMER_NAME,
    contactName: "Asha Procurement",
    phoneNumber: "9876543210",
    email:       "procurement@demo-textiles.example",
    gstin:       "29ABCDE1234F1Z5",
    paymentTerms: "45",
    status:      "Active",
  });
}

async function seedCustomerUser(customer) {
  return CustomerUser.create({
    customer: customer._id,
    name:     "Asha Procurement",
    email:    DEMO_EMAIL,
    phone:    "9876543210",
    password: DEMO_PASSWORD,
    role:     "buyer",
    status:   "active",
    notificationPrefs: { email: true, sms: false },
  });
}

// ─────────────────────────────────────────────────────────────────
async function seedRawMaterials() {
  const baseRow = (overrides) => ({
    category: overrides.category,
    name:     `${DEMO_PREFIX} ${overrides.name}`,
    unit:     "kg",
    stock:    1000,
    minStock: 50,
    currentPrice: overrides.price,
    totalConsumption: 0,
    ...overrides,
  });

  // Categories the app actually uses.
  //
  // This used to invent "spandex", "polyester" and "cotton" — three
  // names that appeared in no picker, no filter chip and no recipe
  // query anywhere in the system. Harmless while `category` was
  // unvalidated free text; not harmless once material groups exist,
  // because the migration reads the DISTINCT categories in the database
  // and faithfully creates a group for each. Seeding a demo customer
  // put three phantom groups in the Groups screen that nobody added and
  // nothing on the shop floor recognises.
  //
  // The demo materials are a warp yarn, a weft yarn and a rubber, so
  // they are filed as such — which also puts them in the elastic recipe
  // pickers, where the seeded elastics below expect to find them.
  const spandex = await RawMaterial.create(baseRow({
    category: "Rubber", name: "Spandex 40D",        price: 380,
  }));
  const polyester = await RawMaterial.create(baseRow({
    category: "weft", name: "Polyester 75/72",  price: 195,
  }));
  const cotton = await RawMaterial.create(baseRow({
    category: "warp",  name: "Cotton 30s",          price: 240,
  }));
  return { spandex, polyester, cotton };
}

async function seedElastics(raw) {
  const make = async (name, qtyOnHand) =>
    Elastic.create({
      name:        `${DEMO_PREFIX} ${name}`,
      weaveType:   "8",
      warpSpandex: { id: raw.spandex._id,   ends: 4,  weight: 50  },
      warpYarn:    [{ id: raw.cotton._id,   ends: 24, weight: 80 }],
      spandexCovering: { id: raw.spandex._id, weight: 20 },
      weftYarn:    { id: raw.polyester._id, weight: 60 },
      spandexEnds: 4,
      yarnEnds:    24,
      pick:        24,
      noOfHook:    1,
      weight:      150,
      testingParameters: { width: 12, elongation: 140, recovery: 92 },
      stock:       qtyOnHand,
      minStock:    200,
    });

  const a = await make("Elastic A — 12mm boxer waistband", 600);
  const b = await make("Elastic A — 16mm bra strap",       400);
  const c = await make("Elastic A — 20mm trouser",         150);
  return { a, b, c };
}

// Demo employee that owns every closed shift we replay. Most fields
// are optional and we keep this lightweight.
async function seedEmployee() {
  return Employee.create({
    name:        `${DEMO_PREFIX} Demo Operator`,
    designation: "Operator",
    phoneNumber: "9000000001",
    status:      "Active",
  });
}

async function seedMachines(el) {
  // M1 — 4-head: 2 heads ElasticA, 2 heads ElasticB.
  const m1 = await Machine.create({
    ID:           `${DEMO_PREFIX} M1`,
    manufacturer: "Karl Mayer",
    NoOfHead:     4,
    NoOfHooks:    8,
    status:       "running",
    elastics: [
      { head: 1, elastic: el.a._id },
      { head: 2, elastic: el.a._id },
      { head: 3, elastic: el.b._id },
      { head: 4, elastic: el.b._id },
    ],
  });

  // M2 — 6-head: 4 heads ElasticC, 2 heads ElasticA.
  const m2 = await Machine.create({
    ID:           `${DEMO_PREFIX} M2`,
    manufacturer: "Comez",
    NoOfHead:     6,
    NoOfHooks:    12,
    status:       "running",
    elastics: [
      { head: 1, elastic: el.c._id },
      { head: 2, elastic: el.c._id },
      { head: 3, elastic: el.c._id },
      { head: 4, elastic: el.c._id },
      { head: 5, elastic: el.a._id },
      { head: 6, elastic: el.a._id },
    ],
  });

  return [m1, m2];
}

// ─────────────────────────────────────────────────────────────────
// Replay 30 closed shifts over the last 25 days, alternating between
// the two machines + day/night shifts. The posterior collector hook
// updates EtaRatePosterior once per (elastic, machine) pair per
// shift — at 30 shifts we're well past the 5-observation informative
// threshold for every pair we touch.
// ─────────────────────────────────────────────────────────────────
async function seedClosedShifts(machines, employee) {
  const rng = mulberry32(20260616); // stable per-day jitter
  let total = 0;

  for (let d = 25; d > 0; d--) {
    for (const shiftLabel of ["DAY", "NIGHT"]) {
      // Skip Sundays so the calendar feels realistic.
      const date = daysAgo(d);
      if (date.getDay() === 0) continue;

      // One ShiftPlan per (date, shift) — ShiftPlan has a unique
      // index on that pair, so both machines must share it.
      const plan = await ShiftPlan.create({
        date,
        shift: shiftLabel,
        plan:  [],
      });

      for (const m of machines) {
        // Per-machine per-head meters/shift — small jitter around a
        // machine-specific baseline so the posterior mean converges
        // to a believable number.
        const baseline = m.ID.endsWith("M1") ? 380 : 320;
        const productionMeters = Math.round(baseline + (rng() - 0.5) * 60);

        const shift = await ShiftDetail.create({
          date,
          shift:            shiftLabel,
          status:           "closed",
          description:      `${DEMO_PREFIX} replayed shift`,
          job:              new mongoose.Types.ObjectId(),
          timer:            "08:00:00",
          productionMeters,
          elastics:         m.elastics,
          employee:         employee._id,
          shiftPlan:        plan._id,
          machine:          m._id,
        });

        // Drive the posterior update the same way the verify cascade
        // does in production — single function call, no fakery.
        try {
          await updatePairPosterior(null, {
            shift,
            machine: m,
            productionMeters,
          });
          total += 1;
        } catch (err) {
          log("  ! posterior update failed:", err.message);
        }
      }
    }
  }
  log(`  ${total} posterior updates committed`);
}

// ─────────────────────────────────────────────────────────────────
async function seedOrders(customer, el) {
  const baseOrdered = [
    { elastic: el.a._id, quantity: 6000 },
    { elastic: el.b._id, quantity: 4000 },
  ];

  // Helper — clones the orderlines and lets us tweak produced
  // quantities per scenario.
  const mkOrder = (overrides) => Order.create({
    date:        overrides.date  || daysAgo(20),
    po:          overrides.po,
    customer:    customer._id,
    supplyDate:  overrides.supplyDate,
    description: overrides.description || "",
    elasticOrdered:  overrides.elasticOrdered  || baseOrdered,
    producedElastic: overrides.producedElastic || [],
    pendingElastic:  overrides.pendingElastic
      || (overrides.elasticOrdered || baseOrdered)
           .map((e) => ({ elastic: e.elastic, quantity: e.quantity })),
    status: overrides.status,
    approvedAt:  overrides.approvedAt,
    startedAt:   overrides.startedAt,
    completedAt: overrides.completedAt,
    cancelledAt: overrides.cancelledAt,
  });

  const open = await mkOrder({
    po: "PO-OPEN-001", supplyDate: daysAhead(45),
    status: "Open", date: daysAgo(2),
    elasticOrdered: [{ elastic: el.c._id, quantity: 8000 }],
    description: "Pending admin approval. Customer placed via portal.",
  });

  const approved = await mkOrder({
    po: "PO-APPR-002", supplyDate: daysAhead(30),
    status: "Approved", date: daysAgo(5), approvedAt: daysAgo(1),
    elasticOrdered: [{ elastic: el.c._id, quantity: 5000 }],
    description: "Approved — production hasn't started yet.",
  });

  // InProgress, mostly done — should land on-time.
  const inflightOnTime = await mkOrder({
    po: "PO-RUN-003", supplyDate: daysAhead(8),
    status: "InProgress", date: daysAgo(15),
    approvedAt: daysAgo(13), startedAt: daysAgo(11),
    elasticOrdered: [
      { elastic: el.a._id, quantity: 6000 },
      { elastic: el.b._id, quantity: 4000 },
    ],
    producedElastic: [
      { elastic: el.a._id, quantity: 4200 },
      { elastic: el.b._id, quantity: 2800 },
    ],
  });

  // InProgress, behind schedule — should render "Nd late vs supply".
  const inflightLate = await mkOrder({
    po: "PO-RUN-004", supplyDate: daysAhead(2),
    status: "InProgress", date: daysAgo(20),
    approvedAt: daysAgo(18), startedAt: daysAgo(16),
    elasticOrdered: [
      { elastic: el.a._id, quantity: 9000 },
      { elastic: el.c._id, quantity: 5000 },
    ],
    producedElastic: [
      { elastic: el.a._id, quantity: 2400 },
      { elastic: el.c._id, quantity: 1100 },
    ],
    description: "Demand spike — at risk of missing supply date.",
  });

  const completed = await mkOrder({
    po: "PO-DONE-005", supplyDate: daysAgo(10),
    status: "Completed", date: daysAgo(60),
    approvedAt:  daysAgo(58),
    startedAt:   daysAgo(55),
    completedAt: daysAgo(12),
    elasticOrdered: [
      { elastic: el.a._id, quantity: 4000 },
      { elastic: el.b._id, quantity: 3000 },
    ],
    producedElastic: [
      { elastic: el.a._id, quantity: 4000 },
      { elastic: el.b._id, quantity: 3000 },
    ],
    pendingElastic: [],
  });

  const cancelled = await mkOrder({
    po: "PO-CANC-006", supplyDate: daysAhead(60),
    status: "Cancelled", date: daysAgo(40),
    cancelledAt: daysAgo(38),
    elasticOrdered: [{ elastic: el.c._id, quantity: 3000 }],
    description: "Customer-requested cancellation before approval.",
  });

  return { open, approved, inflightOnTime, inflightLate, completed, cancelled };
}

// ─────────────────────────────────────────────────────────────────
async function seedJobs(orders, customer, machines, el) {
  const [m1, m2] = machines;

  // InProgress on-time → one job on M1 (which runs ElasticA + B).
  await JobOrder.create({
    date: daysAgo(11),
    order: orders.inflightOnTime._id,
    customer: customer._id,
    machine:  m1._id,
    status:   "weaving",
    elastics:        orders.inflightOnTime.elasticOrdered,
    producedElastic: orders.inflightOnTime.producedElastic,
  });

  // InProgress late → two jobs, one per machine, neither close to done.
  await JobOrder.create({
    date: daysAgo(16),
    order: orders.inflightLate._id,
    customer: customer._id,
    machine:  m1._id,
    status:   "weaving",
    elastics:        [{ elastic: el.a._id, quantity: 9000 }],
    producedElastic: [{ elastic: el.a._id, quantity: 2400 }],
  });
  await JobOrder.create({
    date: daysAgo(15),
    order: orders.inflightLate._id,
    customer: customer._id,
    machine:  m2._id,
    status:   "weaving",
    elastics:        [{ elastic: el.c._id, quantity: 5000 }],
    producedElastic: [{ elastic: el.c._id, quantity: 1100 }],
  });

  // Completed job for the completed order (status: completed so
  // /running-eta excludes it).
  await JobOrder.create({
    date: daysAgo(55),
    order: orders.completed._id,
    customer: customer._id,
    machine:  m1._id,
    status:   "completed",
    elastics:        orders.completed.elasticOrdered,
    producedElastic: orders.completed.producedElastic,
    completedAt:     daysAgo(12),
  });
}

// ─────────────────────────────────────────────────────────────────
async function seedDeliveryChallans(completedOrder, customer, el) {
  const fy = financialYear(daysAgo(14));

  // First DC: 60% of the order, dispatched.
  await DeliveryChallan.create({
    dcNumber: `${DEMO_PREFIX}-DC-001`,
    type:     "elastic",
    financialYear: fy,
    sequence: 1,
    order:    completedOrder._id,
    customer: customer._id,
    customerName:    customer.name,
    customerPhone:   customer.phoneNumber,
    customerGstin:   customer.gstin,
    customerAddress: "12 Industrial Estate, Bangalore",
    date:     daysAgo(14),
    status:   "dispatched",
    items: [
      { elastic: el.a._id, elasticName: el.a.name, quantity: 2400, unit: "m", rate: 6.5, amount: 15600 },
      { elastic: el.b._id, elasticName: el.b.name, quantity: 1800, unit: "m", rate: 7.0, amount: 12600 },
    ],
    totalAmount: 28200,
  });

  // Second DC: balance, delivered.
  await DeliveryChallan.create({
    dcNumber: `${DEMO_PREFIX}-DC-002`,
    type:     "elastic",
    financialYear: fy,
    sequence: 2,
    order:    completedOrder._id,
    customer: customer._id,
    customerName:    customer.name,
    customerPhone:   customer.phoneNumber,
    customerGstin:   customer.gstin,
    customerAddress: "12 Industrial Estate, Bangalore",
    date:     daysAgo(11),
    status:   "delivered",
    items: [
      { elastic: el.a._id, elasticName: el.a.name, quantity: 1600, unit: "m", rate: 6.5, amount: 10400 },
      { elastic: el.b._id, elasticName: el.b.name, quantity: 1200, unit: "m", rate: 7.0, amount:  8400 },
    ],
    totalAmount: 18800,
  });
}

// ── Utilities ────────────────────────────────────────────────────

function financialYear(d) {
  const y = d.getFullYear();
  // India FY: Apr 1 → Mar 31. e.g. May 2026 → "2026-27".
  if (d.getMonth() >= 3) return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

// Tiny deterministic RNG so production data is the same on every
// re-run (helps when debugging UI off the same seed twice).
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────
main().catch(async (err) => {
  console.error("[demo-seed] failed:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exitCode = 1;
});

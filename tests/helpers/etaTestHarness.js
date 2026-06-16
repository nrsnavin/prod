'use strict';
//
// Integration-test harness for the ETA stack.
//
// Spins up an in-memory Mongo, mounts a minimal express app with
// only the order + shift routers (skipping all other model wiring),
// and bypasses auth so tests can hit protected routes directly.
//
// Exports `boot()` returning { app, mongo, stop } plus model
// references for seeding. Each test file calls boot() in
// beforeAll() and `await stop()` in afterAll().

const express              = require("express");
const cookieParser         = require("cookie-parser");
const bodyParser           = require("body-parser");
const mongoose             = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// ── Auth bypass — replace the middleware module before any router
// requires it. Tests get to skip JWT verification while still
// exercising the real handler code. The stub admin matches the
// fingerprint helper's expectations.
jest.mock("../../middleware/auth.js", () => {
  const stubAdmin = {
    _id:   "000000000000000000000001",
    name:  "Integration Test Admin",
    role:  "admin",
    email: "test-admin@example.com",
  };
  return {
    isAuthenticated: (req, _res, next) => { req.user = stubAdmin; next(); },
    isAdmin:         () => (_req, _res, next) => next(),
  };
});

async function boot() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  // Models — required after the connect so their indexes register
  // against the test db.
  const Order            = require("../../models/Order.js");
  const Job              = require("../../models/JobOrder.js");
  const Machine          = require("../../models/Machine.js");
  const ShiftDetail      = require("../../models/ShiftDetail.js");
  const ShiftPlan        = require("../../models/ShiftPlan.js");
  const Elastic          = require("../../models/Elastic.js");
  const Customer         = require("../../models/Customer.js");
  const EtaRatePosterior = require("../../models/EtaRatePosterior.js");

  // Minimal express app: cookieParser/bodyParser to match the real
  // app, then mount only the order router (the SUT for these tests).
  const app = express();
  app.use(cookieParser());
  app.use(bodyParser.json({ limit: "5mb" }));
  app.use("/api/v2/order", require("../../api/order.js"));
  // catchAsyncErrors throws → express default handler. Match the real
  // app's error shape so error-path assertions stay accurate.
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      success: false, message: err.message || "Internal error",
    });
  });

  const stop = async () => {
    await mongoose.disconnect();
    await mongo.stop();
  };

  return {
    app, mongo, stop,
    models: { Order, Job, Machine, ShiftDetail, ShiftPlan, Elastic, Customer, EtaRatePosterior },
  };
}

// ── Helpers for seeding ──────────────────────────────────────────

const oid = (n) =>
  new mongoose.Types.ObjectId(String(n).padStart(24, "0"));

async function seedClosedShift(models, { date, machine, elastics, productionMeters, plan, employee, job }) {
  const shift = await models.ShiftDetail.create({
    date,
    shift:    "DAY",
    status:   "closed",
    job:      job || oid(99),
    timer:    "08:00:00",
    productionMeters,
    elastics, // [{ head, elastic }]
    employee: employee || oid(100),
    shiftPlan: plan || oid(101),
    machine,
  });
  return shift;
}

async function seedCustomer(models, name = "Acme Corp") {
  return models.Customer.create({
    name, phoneNumber: "9876543210", contactName: "Test Contact",
  });
}

async function seedOrder(models, { customer, supplyDate, status, elasticOrdered, producedElastic = [] }) {
  return models.Order.create({
    date:     new Date(),
    po:       "PO-TEST",
    customer,
    supplyDate,
    status,
    elasticOrdered,
    producedElastic,
    pendingElastic: elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: e.quantity })),
  });
}

async function seedMachine(models, { id, NoOfHead, elastics }) {
  return models.Machine.create({
    ID: id,
    NoOfHead,
    NoOfHooks: NoOfHead * 2,
    manufacturer: "Test Mfg",
    status: "running",
    elastics, // [{ head, elastic }]
  });
}

async function seedJob(models, { order, customer, machine, elastics, producedElastic = [], status = "weaving" }) {
  return models.Job.create({
    date:     new Date(),
    order,
    customer,
    machine,
    status,
    elastics,
    producedElastic,
  });
}

module.exports = {
  boot,
  oid,
  seedClosedShift,
  seedCustomer,
  seedOrder,
  seedMachine,
  seedJob,
};

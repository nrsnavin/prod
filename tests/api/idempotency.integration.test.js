'use strict';
//
// Replay protection for stock-writing creates (Phase 1).
//
// The property under test: sending the SAME request twice (same
// requestId — a network retry or double-tap) must apply the business
// effect exactly once, and the second response must say duplicate:true.
//
// Covers the two new mechanisms:
//   • inward-stock  → IdempotencyKey claim inside the transaction
//                     (batch write; key doc, not per-row field)
//   • DC create     → requestId field on the document under a unique
//                     sparse index (also proves no DC number is burned)
//
// Transactional routes → MongoMemoryReplSet (standalone can't do txns).

jest.mock("../../middleware/auth.js", () => {
  const stubAdmin = {
    _id:  "000000000000000000000001",
    name: "Integration Test Admin",
    role: "admin",
  };
  return {
    isAuthenticated: (req, _res, next) => { req.user = stubAdmin; next(); },
    isAdmin:         () => (_req, _res, next) => next(),
    requireFeature:  () => (_req, _res, next) => next(),
  };
});

const express  = require("express");
const request  = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let mongo, app;
let Supplier, PurchaseOrder, RawMaterial, MaterialInward, DeliveryChallan;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());

  Supplier        = require("../../models/Supplier");
  PurchaseOrder   = require("../../models/PurchaseOrder");
  RawMaterial     = require("../../models/RawMaterial");
  MaterialInward  = require("../../models/MaterialInward");
  DeliveryChallan = require("../../models/DeliveryChallan");
  // Ensure unique indexes exist before the replay tests rely on them.
  await Promise.all([
    PurchaseOrder.init(), DeliveryChallan.init(),
    require("../../models/IdempotencyKey").init(),
  ]);

  app = express();
  app.use(express.json());
  app.use("/supplier", require("../../api/supplier.js"));
  app.use("/dc",       require("../../api/deliveryChallan.js"));
  // Mirror the app's error handler contract enough for assertions.
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("inward-stock replay", () => {
  it("credits stock exactly once for a retried requestId", async () => {
    const supplier = await Supplier.create({ name: "Acme Yarn", phoneNumber: "9999999999" });
    const material = await RawMaterial.create({
      name: "Latex 42s", category: "rubber", unit: "kg",
      stock: 100, minStock: 10, price: 5, supplier: supplier._id,
    });
    const po = await PurchaseOrder.create({
      supplier: supplier._id, poNo: 9001, status: "Open",
      items: [{ rawMaterial: material._id, quantity: 50, price: 5, receivedQuantity: 0 }],
    });

    const body = {
      poId: po._id.toString(),
      requestId: "test-inward-replay-1",
      items: [{ rawMaterial: material._id.toString(), quantity: 20 }],
    };

    const first = await request(app).post("/supplier/inward-stock").send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post("/supplier/inward-stock").send(body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    // The business effect happened exactly once.
    const after = await RawMaterial.findById(material._id).lean();
    expect(after.stock).toBe(120);                     // 100 + 20, not 140
    const poAfter = await PurchaseOrder.findById(po._id).lean();
    expect(poAfter.items[0].receivedQuantity).toBe(20); // not 40
    expect(await MaterialInward.countDocuments({ purchaseOrder: po._id })).toBe(1);
    // And it was fingerprinted on the PO.
    expect(poAfter.fingerprints.some((f) => f.code === "PO_STOCK_INWARD")).toBe(true);
  });
});

describe("DC create replay", () => {
  it("cuts exactly one challan (and one number) for a retried requestId", async () => {
    const body = {
      type: "machine_part",
      customerName: "Sri Mills",
      requestId: "test-dc-replay-1",
      items: [{ description: "Spare gear", quantity: 2, rate: 100 }],
    };

    const first = await request(app).post("/dc/create").send(body);
    expect(first.status).toBe(201);
    const dcNumber = first.body.dc.dcNumber;

    const second = await request(app).post("/dc/create").send(body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.dc.dcNumber).toBe(dcNumber); // same challan, no new number

    expect(await DeliveryChallan.countDocuments({ customerName: "Sri Mills" })).toBe(1);
  });
});

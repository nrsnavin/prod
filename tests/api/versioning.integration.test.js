'use strict';
//
// Optimistic locking on user-edited documents (Phase 2).
//
// Property under test: an edit carrying a stale expectedVersion must be
// rejected with 409 and change nothing; a fresh one succeeds and bumps
// __v so the NEXT stale editor is caught. Requests without
// expectedVersion (legacy clients) behave as before.

jest.mock("../../middleware/auth.js", () => ({
  isAuthenticated: (req, _res, next) => {
    req.user = { _id: "000000000000000000000001", name: "Test Admin", role: "admin" };
    next();
  },
  isAdmin: () => (_req, _res, next) => next(),
  requireFeature:  () => (_req, _res, next) => next(),
}));

const express  = require("express");
const request  = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let mongo, app;
let Supplier, PurchaseOrder, RawMaterial;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());

  Supplier      = require("../../models/Supplier");
  PurchaseOrder = require("../../models/PurchaseOrder");
  RawMaterial   = require("../../models/RawMaterial");

  app = express();
  app.use(express.json());
  app.use("/supplier", require("../../api/supplier.js"));
  app.use(require("../../middleware/error.js"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function seedPo() {
  const supplier = await Supplier.create({ name: `S-${Date.now()}-${Math.random()}`, phoneNumber: "9999999999" });
  const material = await RawMaterial.create({
    name: `M-${Date.now()}-${Math.random()}`, category: "rubber", unit: "kg",
    stock: 10, minStock: 1, price: 5, supplier: supplier._id,
  });
  const po = await PurchaseOrder.create({
    supplier: supplier._id, status: "Open",
    items: [{ rawMaterial: material._id, quantity: 10, price: 5, receivedQuantity: 0 }],
  });
  return { po, material };
}

describe("edit-po optimistic locking", () => {
  it("rejects a stale expectedVersion with 409 and changes nothing", async () => {
    const { po, material } = await seedPo();

    const res = await request(app).put("/supplier/edit-po").send({
      poId: po._id.toString(),
      auditReason: "stale editor",
      expectedVersion: po.__v + 5, // stale/mismatched
      notes: "should not land",
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/changed by someone else/i);
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(after.notes || "").not.toBe("should not land");
    expect(material).toBeTruthy();
  });

  it("accepts the current version, bumps __v, then catches the next stale editor", async () => {
    const { po } = await seedPo();

    const ok = await request(app).put("/supplier/edit-po").send({
      poId: po._id.toString(),
      auditReason: "first editor",
      expectedVersion: po.__v,
      notes: "first edit",
    });
    expect(ok.status).toBe(200);

    const bumped = await PurchaseOrder.findById(po._id).lean();
    expect(bumped.__v).toBeGreaterThan(po.__v); // version moved on

    // Second editor still holding the ORIGINAL version → conflict.
    const stale = await request(app).put("/supplier/edit-po").send({
      poId: po._id.toString(),
      auditReason: "second editor",
      expectedVersion: po.__v,
      notes: "second edit",
    });
    expect(stale.status).toBe(409);

    const final = await PurchaseOrder.findById(po._id).lean();
    expect(final.notes).toBe("first edit"); // first edit preserved
  });

  it("legacy clients without expectedVersion still edit successfully", async () => {
    const { po } = await seedPo();
    const res = await request(app).put("/supplier/edit-po").send({
      poId: po._id.toString(),
      auditReason: "legacy client",
      notes: "legacy edit",
    });
    expect(res.status).toBe(200);
  });
});

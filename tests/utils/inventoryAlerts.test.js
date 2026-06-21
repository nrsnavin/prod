'use strict';
//
// Step 5 — unit tests for the inventory-alert guards. The helpers are
// the only place where the "should I fire this?" rules live, so we
// pin the gating logic directly here rather than going through the
// orchestrator. notify() is mocked so we just assert what was called.

jest.mock("../../utils/notify.js", () => ({
  notify: jest.fn().mockResolvedValue({ ok: true }),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo;
let RawMaterial, PurchaseOrder, MaterialOutward, Order, Supplier;
let alerts, notifyMock;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  RawMaterial     = require("../../models/RawMaterial.js");
  PurchaseOrder   = require("../../models/PurchaseOrder.js");
  MaterialOutward = require("../../models/MaterialOut.cjs");
  Order           = require("../../models/Order.js");
  Supplier        = require("../../models/Supplier.js");
  alerts          = require("../../utils/inventoryAlerts.js");
  notifyMock      = require("../../utils/notify.js").notify;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
  notifyMock.mockClear();
});

async function makeSupplier() {
  return Supplier.create({ name: "Acme" });
}
async function makeMaterial(over = {}) {
  const supplier = await makeSupplier();
  return RawMaterial.create({
    name: "Yarn-20s", category: "Yarn", supplier: supplier._id,
    stock: 100, minStock: 10, price: 100,
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────
// criticalStockout
// ─────────────────────────────────────────────────────────────────
describe("maybeFireCriticalStockout", () => {
  test("fires when stock crosses from healthy to at-or-below minStock", async () => {
    const m = await makeMaterial({ stock: 5, minStock: 10 });
    await alerts.maybeFireCriticalStockout({ material: m, oldStock: 20, newStock: 5 });
    expect(notifyMock).toHaveBeenCalledWith(
      "criticalStockout",
      expect.objectContaining({ materialName: "Yarn-20s", stock: 5, minStock: 10 }),
    );
  });

  test("skips when stock was already below the floor (throttle handles repeats)", async () => {
    const m = await makeMaterial({ stock: 4, minStock: 10 });
    await alerts.maybeFireCriticalStockout({ material: m, oldStock: 7, newStock: 4 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips when stock is still healthy", async () => {
    const m = await makeMaterial({ stock: 15, minStock: 10 });
    await alerts.maybeFireCriticalStockout({ material: m, oldStock: 20, newStock: 15 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips when an open PO for the material is already in flight", async () => {
    const m = await makeMaterial({ stock: 5, minStock: 10 });
    const sup = await makeSupplier();
    await PurchaseOrder.create({
      supplier: sup._id, status: "Open",
      items: [{ rawMaterial: m._id, quantity: 100 }],
    });
    await alerts.maybeFireCriticalStockout({ material: m, oldStock: 20, newStock: 5 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips materials with minStock=0 (untracked)", async () => {
    const m = await makeMaterial({ stock: 0, minStock: 0 });
    await alerts.maybeFireCriticalStockout({ material: m, oldStock: 5, newStock: 0 });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// priceChangeAbove10
// ─────────────────────────────────────────────────────────────────
describe("maybeFirePriceChangeAlert", () => {
  test("fires when |Δprice| ≥ 10% and material has recent usage", async () => {
    const m = await makeMaterial();
    await MaterialOutward.create({
      rawMaterial: m._id, quantity: 4200,
      outwardDate: new Date(),
      unitPrice: 100,
      type: "ORDER_APPROVAL",
    });
    await alerts.maybeFirePriceChangeAlert({ material: m, oldPrice: 100, newPrice: 125 });
    expect(notifyMock).toHaveBeenCalledWith(
      "priceChangeAbove10",
      expect.objectContaining({ oldPrice: 100, newPrice: 125, direction: "up" }),
    );
  });

  test("does NOT fire when the change is below 10%", async () => {
    const m = await makeMaterial();
    await MaterialOutward.create({
      rawMaterial: m._id, quantity: 4200,
      outwardDate: new Date(),
      unitPrice: 100,
      type: "ORDER_APPROVAL",
    });
    await alerts.maybeFirePriceChangeAlert({ material: m, oldPrice: 100, newPrice: 105 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips long-tail SKUs with zero recent usage", async () => {
    const m = await makeMaterial();
    // no MaterialOutward rows → recent consumption = 0
    await alerts.maybeFirePriceChangeAlert({ material: m, oldPrice: 100, newPrice: 200 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips when oldPrice is 0 (brand-new material catalogue entry)", async () => {
    const m = await makeMaterial();
    await MaterialOutward.create({
      rawMaterial: m._id, quantity: 4200,
      outwardDate: new Date(), unitPrice: 100, type: "ORDER_APPROVAL",
    });
    await alerts.maybeFirePriceChangeAlert({ material: m, oldPrice: 0, newPrice: 100 });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// poReceivedForCritical
// ─────────────────────────────────────────────────────────────────
describe("maybeFirePoReceivedForCritical", () => {
  test("fires when the inward refills a material that WAS below floor", async () => {
    const m = await makeMaterial({ stock: 54, minStock: 10 });
    await alerts.maybeFirePoReceivedForCritical({
      material: m, stockBefore: 4, stockAfter: 54, quantity: 50,
    });
    expect(notifyMock).toHaveBeenCalledWith(
      "poReceivedForCritical",
      expect.objectContaining({ stockBefore: 4, stockAfter: 54, quantity: 50 }),
    );
  });

  test("stays silent for routine PO receipts on healthy stock", async () => {
    const m = await makeMaterial({ stock: 150, minStock: 10 });
    await alerts.maybeFirePoReceivedForCritical({
      material: m, stockBefore: 100, stockAfter: 150, quantity: 50,
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

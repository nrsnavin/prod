"use strict";

jest.mock("../../models/RawMaterial");
jest.mock("../../models/PurchaseOrder");
jest.mock("../../models/Materialnward");
jest.mock("../../models/MaterialOut.cjs");
jest.mock("../../models/Supplier");

const request = require("supertest");
const app = require("../../app");
const RawMaterial = require("../../models/RawMaterial");
const PurchaseOrder = require("../../models/PurchaseOrder");
const MaterialInward = require("../../models/Materialnward");
const Supplier = require("../../models/Supplier");

const fakeMaterial = (overrides = {}) => ({
  _id: "mat1",
  name: "Nylon Thread",
  category: "warp",
  stock: 500,
  minStock: 100,
  price: 250,
  supplier: "sup1",
  stockMovements: [],
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

// ─── POST /create-raw-material ──────────────────────────────────────────────

describe("POST /api/v2/materials/create-raw-material", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates material and returns 201", async () => {
    RawMaterial.create = jest.fn().mockResolvedValue(fakeMaterial());

    const res = await request(app)
      .post("/api/v2/materials/create-raw-material")
      .send({ name: "Nylon Thread", category: "warp", supplier: "sup1" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.material.name).toBe("Nylon Thread");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/v2/materials/create-raw-material")
      .send({ category: "warp", supplier: "sup1" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it("returns 400 when category is missing", async () => {
    const res = await request(app)
      .post("/api/v2/materials/create-raw-material")
      .send({ name: "Thread", supplier: "sup1" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when supplier is missing", async () => {
    const res = await request(app)
      .post("/api/v2/materials/create-raw-material")
      .send({ name: "Thread", category: "warp" });

    expect(res.status).toBe(400);
  });

  it("defaults stock and price to 0 when not provided", async () => {
    RawMaterial.create = jest.fn().mockResolvedValue(fakeMaterial({ stock: 0, price: 0 }));

    const res = await request(app)
      .post("/api/v2/materials/create-raw-material")
      .send({ name: "Nylon", category: "warp", supplier: "sup1" });

    expect(res.status).toBe(201);
    expect(RawMaterial.create).toHaveBeenCalledWith(
      expect.objectContaining({ stock: 0, price: 0 })
    );
  });
});

// ─── GET /get-raw-materials ─────────────────────────────────────────────────

describe("GET /api/v2/materials/get-raw-materials", () => {
  beforeEach(() => jest.clearAllMocks());

  const buildChain = (result) => ({
    populate: jest.fn().mockReturnThis(),
    select:   jest.fn().mockReturnThis(),
    sort:     jest.fn().mockResolvedValue(result),
  });

  it("returns 200 with array of materials", async () => {
    RawMaterial.find = jest.fn().mockReturnValue(buildChain([fakeMaterial()]));

    const res = await request(app).get("/api/v2/materials/get-raw-materials");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.materials)).toBe(true);
  });

  it("filters by category when provided", async () => {
    RawMaterial.find = jest.fn().mockReturnValue(buildChain([]));

    await request(app).get("/api/v2/materials/get-raw-materials?category=warp");

    expect(RawMaterial.find).toHaveBeenCalledWith(expect.objectContaining({ category: "warp" }));
  });

  it("adds name regex filter when search is provided", async () => {
    RawMaterial.find = jest.fn().mockReturnValue(buildChain([]));

    await request(app).get("/api/v2/materials/get-raw-materials?search=Nylon");

    const filter = RawMaterial.find.mock.calls[0][0];
    expect(filter.name).toMatchObject({ $regex: "Nylon" });
  });
});

// ─── GET /get-raw-material-detail ──────────────────────────────────────────

describe("GET /api/v2/materials/get-raw-material-detail", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when id is not provided", async () => {
    const res = await request(app).get("/api/v2/materials/get-raw-material-detail");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it("returns 404 when material is not found", async () => {
    const chain = {
      populate: jest.fn().mockReturnThis(),
      lean:     jest.fn().mockResolvedValue(null),
    };
    RawMaterial.findById = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/materials/get-raw-material-detail?id=bad");
    expect(res.status).toBe(404);
  });

  it("returns 200 with material and history", async () => {
    const mat = { ...fakeMaterial(), stockMovements: [], inwards: [], outwards: [] };
    const chain = {
      populate: jest.fn().mockReturnThis(),
      lean:     jest.fn().mockResolvedValue(mat),
    };
    RawMaterial.findById = jest.fn().mockReturnValue(chain);

    const inwardChain = { populate: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
    const outwardChain = { populate: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };

    const MaterialOutward = require("../../models/MaterialOut.cjs");
    MaterialInward.find = jest.fn().mockReturnValue(inwardChain);
    MaterialOutward.find = jest.fn().mockReturnValue(outwardChain);

    const res = await request(app).get("/api/v2/materials/get-raw-material-detail?id=mat1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.material.name).toBe("Nylon Thread");
  });
});

// ─── DELETE /delete-raw-material ───────────────────────────────────────────

describe("DELETE /api/v2/materials/delete-raw-material", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when id is missing", async () => {
    const res = await request(app).delete("/api/v2/materials/delete-raw-material");
    expect(res.status).toBe(400);
  });

  it("returns 404 when material not found", async () => {
    RawMaterial.findByIdAndDelete = jest.fn().mockResolvedValue(null);

    const res = await request(app).delete("/api/v2/materials/delete-raw-material?id=bad");
    expect(res.status).toBe(404);
  });

  it("deletes material and returns 200", async () => {
    RawMaterial.findByIdAndDelete = jest.fn().mockResolvedValue(fakeMaterial());

    const res = await request(app).delete("/api/v2/materials/delete-raw-material?id=mat1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/deleted/i);
  });
});

// ─── PUT /edit-raw-material ─────────────────────────────────────────────────

describe("PUT /api/v2/materials/edit-raw-material", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when _id is missing", async () => {
    const res = await request(app)
      .put("/api/v2/materials/edit-raw-material")
      .send({ name: "Updated" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when material not found", async () => {
    RawMaterial.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    const res = await request(app)
      .put("/api/v2/materials/edit-raw-material")
      .send({ _id: "bad", name: "X" });

    expect(res.status).toBe(404);
  });

  it("updates material and returns 200", async () => {
    RawMaterial.findByIdAndUpdate = jest.fn().mockResolvedValue(fakeMaterial({ name: "Updated Thread" }));

    const res = await request(app)
      .put("/api/v2/materials/edit-raw-material")
      .send({ _id: "mat1", name: "Updated Thread" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.material.name).toBe("Updated Thread");
  });
});

// ─── GET /suppliers ─────────────────────────────────────────────────────────

describe("GET /api/v2/materials/suppliers", () => {
  it("returns 200 with supplier list", async () => {
    const chain = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([{ _id: "sup1", name: "SupCo" }]) };
    Supplier.find = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/materials/suppliers");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.suppliers)).toBe(true);
  });
});

// ─── POST /bulk-adjust-stock ────────────────────────────────────────────────

describe("POST /api/v2/materials/bulk-adjust-stock", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when adjustments array is empty", async () => {
    const res = await request(app)
      .post("/api/v2/materials/bulk-adjust-stock")
      .send({ adjustments: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it("returns 200 with no-op when all adjustments are zero", async () => {
    const res = await request(app)
      .post("/api/v2/materials/bulk-adjust-stock")
      .send({ adjustments: [{ _id: "mat1", adjustment: 0 }] });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/no changes/i);
    expect(res.body.skipped).toBe(1);
  });

  it("adjusts stock and returns 200 with updated list", async () => {
    const mat = fakeMaterial({ stock: 500 });
    RawMaterial.findById = jest.fn().mockResolvedValue(mat);

    const res = await request(app)
      .post("/api/v2/materials/bulk-adjust-stock")
      .send({ adjustments: [{ _id: "mat1", adjustment: 50, reason: "Audit" }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].newStock).toBe(550);
  });

  it("clamps stock to 0 when adjustment would make it negative", async () => {
    const mat = fakeMaterial({ stock: 30 });
    RawMaterial.findById = jest.fn().mockResolvedValue(mat);

    const res = await request(app)
      .post("/api/v2/materials/bulk-adjust-stock")
      .send({ adjustments: [{ _id: "mat1", adjustment: -100 }] });

    expect(res.status).toBe(200);
    expect(res.body.updated[0].newStock).toBe(0);
  });
});

// ─── POST /raise-po ──────────────────────────────────────────────────────────

describe("POST /api/v2/materials/raise-po", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when supplier is missing", async () => {
    const res = await request(app)
      .post("/api/v2/materials/raise-po")
      .send({ items: [{ rawMaterial: "mat1", quantity: 10 }] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/supplier required/i);
  });

  it("returns 400 when items array is empty", async () => {
    const res = await request(app)
      .post("/api/v2/materials/raise-po")
      .send({ supplier: "sup1", items: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one item/i);
  });

  it("returns 400 when item has no rawMaterial", async () => {
    const res = await request(app)
      .post("/api/v2/materials/raise-po")
      .send({ supplier: "sup1", items: [{ quantity: 5 }] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rawMaterial required/i);
  });

  it("returns 400 when item quantity is 0", async () => {
    const res = await request(app)
      .post("/api/v2/materials/raise-po")
      .send({ supplier: "sup1", items: [{ rawMaterial: "mat1", quantity: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/quantity must be > 0/i);
  });

  it("creates PO and returns 201", async () => {
    const fakePO = {
      _id: "po1",
      supplier: "sup1",
      items: [{ rawMaterial: "mat1", quantity: 10 }],
      populate: jest.fn().mockResolvedValue({ _id: "po1" }),
    };
    PurchaseOrder.create = jest.fn().mockResolvedValue(fakePO);

    const res = await request(app)
      .post("/api/v2/materials/raise-po")
      .send({ supplier: "sup1", items: [{ rawMaterial: "mat1", quantity: 10 }] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

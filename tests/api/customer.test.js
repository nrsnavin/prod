"use strict";

jest.mock("../../models/Customer");

const request = require("supertest");
const app = require("../../app");
const Customer = require("../../models/Customer");

const fakeCustomer = (overrides = {}) => ({
  _id: "cust1",
  name: "Acme Corp",
  phoneNumber: "9876543210",
  gstin: "GST123",
  ...overrides,
});

// ─── POST /create ───────────────────────────────────────────────────────────

describe("POST /api/v2/customer/create", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a customer and returns 201", async () => {
    Customer.create = jest.fn().mockResolvedValue(fakeCustomer());

    const res = await request(app)
      .post("/api/v2/customer/create")
      .send({ name: "Acme Corp", phoneNumber: "9876543210" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ name: "Acme Corp" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/v2/customer/create")
      .send({ phoneNumber: "9876543210" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name is required/i);
  });
});

// ─── PUT /update ────────────────────────────────────────────────────────────

describe("PUT /api/v2/customer/update", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates customer and returns 200", async () => {
    Customer.findByIdAndUpdate = jest.fn().mockResolvedValue(fakeCustomer({ name: "Updated Corp" }));

    const res = await request(app)
      .put("/api/v2/customer/update")
      .send({ _id: "cust1", name: "Updated Corp" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("Updated Corp");
  });

  it("returns 404 when customer not found", async () => {
    Customer.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    const res = await request(app)
      .put("/api/v2/customer/update")
      .send({ _id: "nonexistent", name: "X" });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });
});

// ─── GET /all-customers ─────────────────────────────────────────────────────

describe("GET /api/v2/customer/all-customers", () => {
  beforeEach(() => jest.clearAllMocks());

  const buildChain = (result) => {
    const chain = {
      sort:  jest.fn().mockReturnThis(),
      skip:  jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(result),
    };
    return chain;
  };

  it("returns 200 with list of customers", async () => {
    Customer.find = jest.fn().mockReturnValue(buildChain([fakeCustomer()]));

    const res = await request(app).get("/api/v2/customer/all-customers");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });

  it("passes search query to find", async () => {
    Customer.find = jest.fn().mockReturnValue(buildChain([]));

    await request(app).get("/api/v2/customer/all-customers?search=Acme");

    const query = Customer.find.mock.calls[0][0];
    expect(query).toHaveProperty("$or");
  });

  it("uses default pagination when no params provided", async () => {
    const chain = buildChain([]);
    Customer.find = jest.fn().mockReturnValue(chain);

    await request(app).get("/api/v2/customer/all-customers");

    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it("respects page and limit query params", async () => {
    const chain = buildChain([]);
    Customer.find = jest.fn().mockReturnValue(chain);

    await request(app).get("/api/v2/customer/all-customers?page=2&limit=5");

    expect(chain.skip).toHaveBeenCalledWith(5);
    expect(chain.limit).toHaveBeenCalledWith(5);
  });
});

// ─── GET /customerDetail ────────────────────────────────────────────────────

describe("GET /api/v2/customer/customerDetail", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 with customer data", async () => {
    Customer.findById = jest.fn().mockResolvedValue(fakeCustomer());

    const res = await request(app).get("/api/v2/customer/customerDetail?id=cust1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.customer).toMatchObject({ name: "Acme Corp" });
  });

  it("returns 404 when customer not found", async () => {
    Customer.findById = jest.fn().mockResolvedValue(null);

    const res = await request(app).get("/api/v2/customer/customerDetail?id=bad");

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });
});

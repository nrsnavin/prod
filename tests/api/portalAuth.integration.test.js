'use strict';
//
// End-to-end integration tests for the customer portal auth surface.
// Covers login, /me, logout, role/audience separation from admin tokens,
// and the admin-side portal-user provisioning route.

// Same auth-mock pattern as the ETA integration tests: the admin
// auth middleware is stubbed before any router requires it so we
// can hit ADMIN_GATE routes (portal-user creation) without spinning
// up real JWTs. Portal routes don't use this stub — they use the
// real middleware/portalAuth.js, so the auth behavior is genuinely
// tested.
jest.mock("../../middleware/auth.js", () => {
  const stubAdmin = {
    _id:   "000000000000000000000001",
    name:  "Stub Admin",
    role:  "admin",
    email: "stub@example.com",
  };
  return {
    isAuthenticated: (req, _res, next) => { req.user = stubAdmin; next(); },
    isAdmin:         () => (_req, _res, next) => next(),
  };
});

const express              = require("express");
const cookieParser         = require("cookie-parser");
const bodyParser           = require("body-parser");
const request              = require("supertest");
const mongoose             = require("mongoose");
const jwt                  = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Fix a secret before any auth module loads so the portal middleware
// has a stable key to verify against.
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";

let app;
let mongo;
let Customer;
let CustomerUser;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  Customer     = require("../../models/Customer.js");
  CustomerUser = require("../../models/CustomerUser.js");
  const portalAuth   = require("../../api/portal/auth.js");
  const customerRtr  = require("../../api/customer.js");

  app = express();
  app.use(cookieParser());
  app.use(bodyParser.json());
  app.use("/api/v3/portal/auth", portalAuth);
  app.use("/api/v2/customer",    customerRtr);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
}, 60_000);

afterAll(async () => {
  if (mongo) {
    await mongoose.disconnect();
    await mongo.stop();
  }
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function seedCustomer() {
  return Customer.create({
    name:        "Acme Corp",
    contactName: "Alice Procurement",
    phoneNumber: "9876543210",
  });
}
async function seedPortalUser(custId, overrides = {}) {
  return CustomerUser.create({
    customer: custId,
    name:     "Alice",
    email:    `alice-${Date.now()}@example.com`,
    password: "secret123",
    role:     "buyer",
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /api/v2/customer/:id/portal-users — admin provisioning
// ─────────────────────────────────────────────────────────────────
describe("POST /api/v2/customer/:id/portal-users (admin)", () => {
  test("creates a portal user for a customer", async () => {
    const c = await seedCustomer();
    const r = await request(app)
      .post(`/api/v2/customer/${c._id}/portal-users`)
      .send({ name: "Alice", email: "alice@acme.test", password: "pw123456", role: "buyer" });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.user.email).toBe("alice@acme.test");
    // Password hash never leaks.
    expect(r.body.user).not.toHaveProperty("password");
  });

  test("rejects duplicate emails", async () => {
    const c = await seedCustomer();
    await seedPortalUser(c._id, { email: "dup@acme.test" });
    const r = await request(app)
      .post(`/api/v2/customer/${c._id}/portal-users`)
      .send({ name: "X", email: "dup@acme.test", password: "pw123456" });
    expect(r.status).toBe(409);
  });

  test("rejects on missing required fields", async () => {
    const c = await seedCustomer();
    const r = await request(app)
      .post(`/api/v2/customer/${c._id}/portal-users`)
      .send({ email: "x@y.com" });
    expect(r.status).toBe(400);
  });

  test("404 for unknown customer", async () => {
    const r = await request(app)
      .post(`/api/v2/customer/${new mongoose.Types.ObjectId()}/portal-users`)
      .send({ name: "X", email: "z@y.com", password: "pw123456" });
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v3/portal/auth/login
// ─────────────────────────────────────────────────────────────────
describe("POST /api/v3/portal/auth/login", () => {
  test("400 when email or password missing", async () => {
    const r = await request(app).post("/api/v3/portal/auth/login").send({});
    expect(r.status).toBe(400);
  });

  test("401 on unknown email — no user enumeration", async () => {
    const r = await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "ghost@nowhere.test", password: "x" });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/invalid/i);
  });

  test("401 on wrong password — same generic message", async () => {
    const c = await seedCustomer();
    await seedPortalUser(c._id, { email: "right@acme.test" });
    const r = await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "right@acme.test", password: "wrong" });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/invalid/i);
  });

  test("401 on disabled account", async () => {
    const c = await seedCustomer();
    await seedPortalUser(c._id, {
      email: "off@acme.test", status: "disabled",
    });
    const r = await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "off@acme.test", password: "secret123" });
    expect(r.status).toBe(401);
  });

  test("200 + sets portalToken cookie + returns user on success", async () => {
    const c = await seedCustomer();
    await seedPortalUser(c._id, { email: "ok@acme.test" });
    const r = await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "ok@acme.test", password: "secret123" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.user.email).toBe("ok@acme.test");
    // Cookie header carries the portal token.
    expect(r.headers["set-cookie"]?.[0]).toMatch(/portalToken=/);
    expect(r.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/);
  });

  test("login updates lastLoginAt", async () => {
    const c = await seedCustomer();
    const u = await seedPortalUser(c._id, { email: "ts@acme.test" });
    expect(u.lastLoginAt).toBeUndefined();
    await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "ts@acme.test", password: "secret123" });
    const refreshed = await CustomerUser.findById(u._id);
    expect(refreshed.lastLoginAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/v3/portal/auth/me
// ─────────────────────────────────────────────────────────────────
describe("GET /api/v3/portal/auth/me", () => {
  test("401 with no cookie", async () => {
    const r = await request(app).get("/api/v3/portal/auth/me");
    expect(r.status).toBe(401);
  });

  test("401 with garbage token", async () => {
    const r = await request(app)
      .get("/api/v3/portal/auth/me")
      .set("Cookie", "portalToken=not-a-real-jwt");
    expect(r.status).toBe(401);
  });

  test("401 when token has wrong audience — admin token rejected", async () => {
    // Forge an admin-style token (no aud:"portal" claim) and try to use it.
    const fake = jwt.sign(
      { id: new mongoose.Types.ObjectId(), role: "admin" },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "1h" }
    );
    const r = await request(app)
      .get("/api/v3/portal/auth/me")
      .set("Cookie", `portalToken=${fake}`);
    expect(r.status).toBe(401);
  });

  test("returns user + customer after a real login", async () => {
    const c = await seedCustomer();
    await seedPortalUser(c._id, { email: "me@acme.test" });

    const login = await request(app)
      .post("/api/v3/portal/auth/login")
      .send({ email: "me@acme.test", password: "secret123" });
    const cookie = login.headers["set-cookie"][0];

    const me = await request(app)
      .get("/api/v3/portal/auth/me")
      .set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("me@acme.test");
    expect(me.body.customer.name).toBe("Acme Corp");
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v3/portal/auth/logout
// ─────────────────────────────────────────────────────────────────
describe("POST /api/v3/portal/auth/logout", () => {
  test("clears the portalToken cookie", async () => {
    const r = await request(app).post("/api/v3/portal/auth/logout");
    expect(r.status).toBe(200);
    // Set-Cookie carries a clearing directive (expired / empty value).
    expect(r.headers["set-cookie"]?.[0]).toMatch(/portalToken=;/);
  });
});

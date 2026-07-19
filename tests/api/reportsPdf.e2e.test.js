"use strict";
// End-to-end test of the reports feature THROUGH the real Express app:
// auth cookie -> gate -> sanitizeMongo -> report service -> JSON / CSV /
// PDF response. Proves the endpoints actually serve real data and a
// valid PDF (not just that the service functions in isolation).

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";
process.env.NODE_ENV = "test";

const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, app, User, admin, cookie;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  app = require("../../app.js");
  User = require("../../models/User.js");

  admin = await User.create({
    name: "Admin", email: "admin@test.com", password: "secret123", role: "admin",
  });
  const token = jwt.sign(
    { id: admin._id, role: "admin", name: admin.name, email: admin.email },
    process.env.JWT_SECRET_KEY,
  );
  cookie = [`token=${token}`];

  // Seed one dispatched delivery challan in the current month so the
  // dispatch report has real rows/value.
  await mongoose.connection.collection("deliverychallans").insertOne({
    dcNumber: 90001,
    status: "dispatched",
    dispatchDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    customerName: "Acme Elastics",
    totalQuantity: 500,
    totalAmount: 25000,
    items: [{ elastic: new mongoose.Types.ObjectId(), elasticName: "20mm", quantity: 500, amount: 25000 }],
  });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("GET /api/v2/reports/dispatch (through the app)", () => {
  test("401 without an auth cookie", async () => {
    const res = await request(app).get("/api/v2/reports/dispatch?preset=month");
    expect(res.status).toBe(401);
  });

  test("JSON: returns the report with the seeded row", async () => {
    const res = await request(app)
      .get("/api/v2/reports/dispatch?preset=month&groupBy=customer")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.summary.amount).toBe(25000);
    expect(res.body.report.rows[0].label).toBe("Acme Elastics");
  });

  test("CSV: downloadable text with the data", async () => {
    const res = await request(app)
      .get("/api/v2/reports/dispatch?preset=month&groupBy=customer&format=csv")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=/);
    expect(res.text).toMatch(/Acme Elastics/);
  });

  test("PDF: valid application/pdf attachment", async () => {
    const res = await request(app)
      .get("/api/v2/reports/dispatch?preset=month&groupBy=customer&format=pdf")
      .set("Cookie", cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(Buffer.from(c, "binary")));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/\.pdf"/);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
    expect(res.body.length).toBeGreaterThan(800);
  });
});

describe("health probes", () => {
  test("liveness /health is public and 200", async () => {
    const res = await request(app).get("/api/v2/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("readiness /health/ready reports the DB as connected", async () => {
    const res = await request(app).get("/api/v2/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.db).toBe("connected");
  });
});

describe("every report endpoint answers PDF + JSON", () => {
  const paths = ["production", "dispatch", "order-book", "stock-purchases", "stock-movements"];
  test.each(paths)("GET /reports/%s serves JSON and a PDF", async (p) => {
    const json = await request(app).get(`/api/v2/reports/${p}?preset=month`).set("Cookie", cookie);
    expect(json.status).toBe(200);
    expect(json.body.report).toBeTruthy();

    const pdf = await request(app)
      .get(`/api/v2/reports/${p}?preset=month&format=pdf`)
      .set("Cookie", cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(Buffer.from(c, "binary")));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 5).toString()).toBe("%PDF-");
  });
});

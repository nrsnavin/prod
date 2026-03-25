"use strict";

jest.mock("../../models/User");
jest.mock("jsonwebtoken");

const request = require("supertest");
const app = require("../../app");
const User = require("../../models/User");
const jwt = require("jsonwebtoken");

describe("POST /api/v2/user/sign-up", () => {
  it("creates a user and returns 200", async () => {
    const fakeUser = { _id: "u1", name: "Alice", email: "alice@test.com" };
    User.create = jest.fn().mockResolvedValue(fakeUser);

    const res = await request(app)
      .post("/api/v2/user/sign-up")
      .send({ name: "Alice", email: "alice@test.com", password: "secret" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toMatchObject({ name: "Alice" });
  });

  it("returns 500 when User.create throws", async () => {
    User.create = jest.fn().mockRejectedValue(new Error("DB error"));

    const res = await request(app)
      .post("/api/v2/user/sign-up")
      .send({ name: "Alice" });

    expect(res.status).toBe(500);
  });
});

describe("POST /api/v2/user/login-user", () => {
  it("returns 400 when email or password is missing", async () => {
    const res = await request(app)
      .post("/api/v2/user/login-user")
      .send({ email: "alice@test.com" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fields/i);
  });

  it("returns 400 when user does not exist", async () => {
    User.findOne = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) });

    const res = await request(app)
      .post("/api/v2/user/login-user")
      .send({ email: "nobody@test.com", password: "pass" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/doesn't exists/i);
  });

  it("returns 201 with token when login succeeds", async () => {
    const fakeUser = { _id: "u1", name: "Alice", role: "admin" };
    User.findOne = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(fakeUser) });
    jwt.sign = jest.fn().mockReturnValue("signed.jwt.token");

    const res = await request(app)
      .post("/api/v2/user/login-user")
      .send({ email: "alice@test.com", password: "secret" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      username: "Alice",
      id: "u1",
      role: "admin",
      token: "signed.jwt.token",
    });
  });
});

describe("GET /api/v2/user/logout", () => {
  it("clears the cookie and returns success", async () => {
    const res = await request(app).get("/api/v2/user/logout");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: /log out/i });
  });
});

describe("GET /api/v2/user/all-users", () => {
  it("returns 401 when no token is provided", async () => {
    const res = await request(app).get("/api/v2/user/all-users");
    expect(res.status).toBe(401);
  });

  it("returns users when authenticated", async () => {
    const fakeUsers = [{ _id: "u1", name: "Admin", role: "admin" }];

    jwt.verify = jest.fn().mockReturnValue({ id: "u1" });
    User.findById = jest.fn().mockResolvedValue({ _id: "u1", role: "admin" });
    User.find = jest.fn().mockResolvedValue(fakeUsers);

    const res = await request(app)
      .get("/api/v2/user/all-users")
      .set("Cookie", "token=valid.token");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

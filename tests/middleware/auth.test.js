"use strict";

jest.mock("jsonwebtoken");
jest.mock("../../models/User");

const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const { isAuthenticated, isAdmin } = require("../../middleware/auth");

const buildNext = () => jest.fn();

describe("isAuthenticated", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET_KEY = "test-secret";
  });

  it("calls next with 401 ErrorHandler when token is missing", async () => {
    const req = { cookies: {} };
    const res = {};
    const next = buildNext();

    await isAuthenticated(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/login/i);
  });

  it("verifies token and attaches user to req", async () => {
    const fakeUser = { _id: "user123", name: "Test" };
    jwt.verify = jest.fn().mockReturnValue({ id: "user123" });
    User.findById = jest.fn().mockResolvedValue(fakeUser);

    const req = { cookies: { token: "valid.token.here" } };
    const res = {};
    const next = buildNext();

    await isAuthenticated(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith("valid.token.here", "test-secret");
    expect(User.findById).toHaveBeenCalledWith("user123");
    expect(req.user).toEqual(fakeUser);
    expect(next).toHaveBeenCalledWith(); // called with no args = success
  });

  it("forwards jwt.verify errors to next", async () => {
    jwt.verify = jest.fn().mockImplementation(() => { throw new Error("invalid token"); });

    const req = { cookies: { token: "bad.token" } };
    const res = {};
    const next = buildNext();

    await isAuthenticated(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("isAdmin", () => {
  it("calls next() when user role is in allowed roles", () => {
    const req = { user: { role: "admin" } };
    const res = {};
    const next = buildNext();

    isAdmin("admin", "superadmin")(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("calls next with ErrorHandler when role is not allowed", () => {
    const req = { user: { role: "employee" } };
    const res = {};
    const next = buildNext();

    isAdmin("admin")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.message).toMatch(/employee/);
  });

  it("allows multiple roles", () => {
    const next = buildNext();
    isAdmin("admin", "manager")({ user: { role: "manager" } }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });
});

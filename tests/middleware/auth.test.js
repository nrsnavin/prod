"use strict";

jest.mock("jsonwebtoken");
jest.mock("../../models/User");

const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const { isAuthenticated, isAdmin, requireFeature } = require("../../middleware/auth");

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

describe("requireFeature (writes only, admins included)", () => {
  const run = (user, method, ...keys) => {
    const next = buildNext();
    requireFeature(...keys)({ user, method }, {}, next);
    return next;
  };
  // A denial calls next(err); a pass calls next() with no args.
  const passed = (next) =>
    next.mock.calls.length === 1 && next.mock.calls[0].length === 0;

  it("never gates reads — GET passes regardless of features or user", () => {
    expect(passed(run(undefined, "GET", "/reports"))).toBe(true);
    expect(passed(run({ role: "production", features: ["/jobs"] }, "GET", "/reports"))).toBe(true);
  });

  it("401s on a write with no authenticated user", () => {
    const next = run(undefined, "POST", "/reports");
    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it("enforces writes for admins too (no bypass)", () => {
    // admin whose custom list omits the feature is blocked from writing
    const denied = run({ role: "admin", features: ["/orders"] }, "POST", "/reports");
    expect(passed(denied)).toBe(false);
    expect(denied.mock.calls[0][0].statusCode).toBe(403);
    // admin who holds it may write
    expect(passed(run({ role: "admin", features: ["/reports"] }, "POST", "/reports"))).toBe(true);
  });

  it("defers when the user has no explicit features (owner / legacy)", () => {
    expect(passed(run({ role: "admin", features: [] }, "POST", "/reports"))).toBe(true);
    expect(passed(run({ role: "production" }, "PUT", "/reports"))).toBe(true); // absent list
  });

  it("passes a write when the explicit list includes any required key", () => {
    expect(passed(run({ features: ["/qc", "/jobs"] }, "POST", "/qc", "/jobs"))).toBe(true);
    // holds only the sibling/consuming feature — still allowed
    expect(passed(run({ features: ["/jobs"] }, "DELETE", "/qc", "/jobs"))).toBe(true);
  });

  it("403s a write when the explicit list omits every required key", () => {
    const next = run({ role: "production", features: ["/jobs", "/machines"] }, "PUT", "/reports");
    expect(passed(next)).toBe(false);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});

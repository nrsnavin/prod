'use strict';
//
// Unit coverage for the security-hardening helpers. Pure functions —
// no DB, no server.

const sanitizeMongo = require("../../middleware/sanitizeMongo.js");
const { escapeRegex } = require("../../utils/escapeRegex.js");
const { resolveEmployeeId } = require("../../utils/resolveEmployee.js");

describe("sanitizeMongo middleware", () => {
  function run(reqLike) {
    let called = false;
    sanitizeMongo(reqLike, {}, () => { called = true; });
    return called;
  }

  test("strips $-prefixed operator keys from body", () => {
    const req = { body: { email: { $gt: "" }, password: "x" } };
    run(req);
    expect(req.body.email).toEqual({}); // $gt removed, leaving {}
    expect(req.body.password).toBe("x");
  });

  test("strips $-operators smuggled into an update body", () => {
    const req = { body: { _id: "1", $unset: { minStock: 1 }, $rename: { a: "b" } } };
    run(req);
    expect(req.body).toEqual({ _id: "1" });
  });

  test("strips dotted keys (subdocument path injection)", () => {
    const req = { body: { "a.b.c": 1, normal: 2 } };
    run(req);
    expect(req.body).toEqual({ normal: 2 });
  });

  test("recurses into nested objects and arrays", () => {
    const req = { body: { list: [{ $ne: null }, { ok: 1 }] } };
    run(req);
    expect(req.body.list[0]).toEqual({});
    expect(req.body.list[1]).toEqual({ ok: 1 });
  });

  test("leaves clean bodies untouched and calls next()", () => {
    const req = { body: { name: "Acme", n: 5 }, query: { q: "hi" }, params: {} };
    expect(run(req)).toBe(true);
    expect(req.body).toEqual({ name: "Acme", n: 5 });
  });

  test("string VALUES containing $ or . are preserved (only keys inspected)", () => {
    const req = { body: { note: "cost is $5.00" } };
    run(req);
    expect(req.body.note).toBe("cost is $5.00");
  });
});

describe("escapeRegex", () => {
  test("escapes regex metacharacters", () => {
    expect(escapeRegex("(a+)+$")).toBe("\\(a\\+\\)\\+\\$");
  });
  test("a catastrophic-backtracking pattern becomes a literal", () => {
    const escaped = escapeRegex("(a+)+$");
    // Used as a literal, it only matches the literal text, fast.
    expect(new RegExp(escaped).test("(a+)+$")).toBe(true);
    expect(new RegExp(escaped).test("aaaaaaaaaa")).toBe(false);
  });
  test("caps length to bound work", () => {
    expect(escapeRegex("a".repeat(500)).length).toBeLessThanOrEqual(100);
  });
  test("handles null/undefined", () => {
    expect(escapeRegex(null)).toBe("");
    expect(escapeRegex(undefined)).toBe("");
  });
});

describe("resolveEmployeeId", () => {
  test("worker is pinned to their own linked employee, body ignored", () => {
    const req = { user: { role: "worker", employee: "EMP1" }, body: { employeeId: "EMP2" } };
    expect(resolveEmployeeId(req)).toBe("EMP1");
  });

  test("worker with no linked employee resolves to null (caller 403s)", () => {
    const req = { user: { role: "worker" }, body: { employeeId: "EMP2" } };
    expect(resolveEmployeeId(req)).toBeNull();
  });

  test("admin may act on behalf via body.employeeId", () => {
    const req = { user: { role: "admin", employee: "ADMINEMP" }, body: { employeeId: "EMP2" } };
    expect(resolveEmployeeId(req)).toBe("EMP2");
  });

  test("admin with no body id falls back to their own employee", () => {
    const req = { user: { role: "admin", employee: "ADMINEMP" }, body: {} };
    expect(resolveEmployeeId(req)).toBe("ADMINEMP");
  });
});

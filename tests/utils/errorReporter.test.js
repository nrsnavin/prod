"use strict";
//
// Unit test for utils/errorReporter.js — the 5xx error sink wired into
// the Express error handler. Verifies it emits a structured stderr line
// with request context, is fail-open (never throws), and does not depend
// on Sentry being installed.

const { reportError } = require("../../utils/errorReporter.js");

describe("errorReporter.reportError", () => {
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  test("emits one structured JSON line with the error and request context", () => {
    const err = Object.assign(new Error("boom"), { statusCode: 500, name: "TypeError" });
    const req = {
      method: "POST",
      originalUrl: "/api/v2/order/approve?force=1",
      user: { _id: "abc123" },
      // What Express works out from the proxy it trusts (app.set("trust
      // proxy")) — not the header, which the caller writes themselves.
      ip: "10.0.0.5",
      headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.5" },
      socket: { remoteAddress: "172.16.0.1" },
    };

    reportError(err, req);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.level).toBe("error");
    expect(line.status).toBe(500);
    expect(line.name).toBe("TypeError");
    expect(line.msg).toBe("boom");
    expect(line.method).toBe("POST");
    expect(line.path).toBe("/api/v2/order/approve"); // query stripped
    expect(line.user).toBe("abc123");
    expect(line.ip).toBe("10.0.0.5"); // the trusted address, not the header's first entry
    expect(line.stack).toContain("boom");
  });

  test("carries the reference the person was shown", () => {
    reportError(Object.assign(new Error("boom"), { statusCode: 500 }), { method: "GET", url: "/x", headers: {} }, "4F2A91C0");
    expect(JSON.parse(spy.mock.calls[0][0]).ref).toBe("4F2A91C0");
  });

  test("falls back to the socket's address with no proxy in front", () => {
    reportError(new Error("boom"), { method: "GET", url: "/x", headers: { "x-forwarded-for": "6.6.6.6" }, socket: { remoteAddress: "172.16.0.1" } });
    expect(JSON.parse(spy.mock.calls[0][0]).ip).toBe("172.16.0.1");
  });

  test("works without a request object", () => {
    reportError(new Error("no req"));
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.msg).toBe("no req");
    expect(line.method).toBeUndefined();
  });

  test("is fail-open — never throws even on a malformed error", () => {
    expect(() => reportError(null)).not.toThrow();
    expect(() => reportError(undefined, undefined)).not.toThrow();
    expect(() => reportError("just a string")).not.toThrow();
  });
});

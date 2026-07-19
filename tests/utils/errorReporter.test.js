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
      headers: { "x-forwarded-for": "10.0.0.5, 172.16.0.1" },
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
    expect(line.ip).toBe("10.0.0.5"); // first hop from x-forwarded-for
    expect(line.stack).toContain("boom");
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

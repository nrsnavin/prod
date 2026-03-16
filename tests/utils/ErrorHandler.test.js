"use strict";

const ErrorHandler = require("../../utils/ErrorHandler");

describe("ErrorHandler", () => {
  it("extends Error", () => {
    const err = new ErrorHandler("test error", 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ErrorHandler);
  });

  it("sets message correctly", () => {
    const err = new ErrorHandler("Not found", 404);
    expect(err.message).toBe("Not found");
  });

  it("sets statusCode correctly", () => {
    const err = new ErrorHandler("Unauthorized", 401);
    expect(err.statusCode).toBe(401);
  });

  it("has a stack trace", () => {
    const err = new ErrorHandler("Server error", 500);
    expect(err.stack).toBeDefined();
  });

  it("works with 500 status code", () => {
    const err = new ErrorHandler("Internal Server Error", 500);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe("Internal Server Error");
  });
});

"use strict";

const catchAsyncErrors = require("../../middleware/catchAsyncErrors");

describe("catchAsyncErrors", () => {
  it("calls the wrapped function with req, res, next", async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const wrapped = catchAsyncErrors(handler);

    const req = {};
    const res = {};
    const next = jest.fn();

    await wrapped(req, res, next);

    expect(handler).toHaveBeenCalledWith(req, res, next);
  });

  it("calls next with error when the wrapped function rejects", async () => {
    const error = new Error("async failure");
    const handler = jest.fn().mockRejectedValue(error);
    const wrapped = catchAsyncErrors(handler);

    const req = {};
    const res = {};
    const next = jest.fn();

    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  it("does not call next when the wrapped function resolves", async () => {
    const handler = jest.fn().mockResolvedValue("ok");
    const wrapped = catchAsyncErrors(handler);

    const next = jest.fn();

    await wrapped({}, {}, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("returns a function (middleware signature)", () => {
    const handler = jest.fn();
    const wrapped = catchAsyncErrors(handler);
    expect(typeof wrapped).toBe("function");
  });
});

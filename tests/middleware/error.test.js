"use strict";

const errorMiddleware = require("../../middleware/error");
const ErrorHandler = require("../../utils/ErrorHandler");

const buildRes = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

describe("error middleware", () => {
  it("responds with the error's statusCode and message", () => {
    const err = new ErrorHandler("Not found", 404);
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: "Not found" });
  });

  it("defaults statusCode to 500 when not set", () => {
    const err = new Error("Unknown");
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("defaults message to 'Internal server Error' when not set", () => {
    const err = {};
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Internal server Error" })
    );
  });

  it("handles CastError (invalid MongoDB id)", () => {
    const err = { name: "CastError", path: "_id" };
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Invalid _id") })
    );
  });

  it("handles duplicate key error (code 11000)", () => {
    const err = { code: 11000, keyValue: { email: "test@test.com" } };
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Duplicate key") })
    );
  });

  it("handles JsonWebTokenError", () => {
    const err = { name: "JsonWebTokenError" };
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("invalid") })
    );
  });

  it("handles TokenExpiredError", () => {
    const err = { name: "TokenExpiredError" };
    const res = buildRes();

    errorMiddleware(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("expired") })
    );
  });
});

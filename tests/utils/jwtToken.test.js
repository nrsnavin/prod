"use strict";

const sendToken = require("../../utils/jwtToken");

describe("sendToken", () => {
  const mockToken = "mock.jwt.token";

  const mockUser = {
    _id: "user123",
    name: "Test User",
    getJwtToken: jest.fn().mockReturnValue(mockToken),
  };

  const buildRes = () => {
    const res = {
      status: jest.fn(),
      cookie: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.cookie.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    mockUser.getJwtToken.mockClear();
  });

  it("calls res.status with the provided statusCode", () => {
    const res = buildRes();
    sendToken(mockUser, 200, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("sets the token cookie with httpOnly and secure flags", () => {
    const res = buildRes();
    sendToken(mockUser, 200, res);
    expect(res.cookie).toHaveBeenCalledWith(
      "token",
      mockToken,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "none",
      })
    );
  });

  it("sets cookie expiry ~90 days in the future", () => {
    const before = Date.now();
    const res = buildRes();
    sendToken(mockUser, 200, res);
    const after = Date.now();

    const [, , options] = res.cookie.mock.calls[0];
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    expect(options.expires.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs - 1000);
    expect(options.expires.getTime()).toBeLessThanOrEqual(after + ninetyDaysMs + 1000);
  });

  it("responds with success:true, user, and token in JSON body", () => {
    const res = buildRes();
    sendToken(mockUser, 200, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      user: mockUser,
      token: mockToken,
    });
  });

  it("calls user.getJwtToken() to generate the token", () => {
    const res = buildRes();
    sendToken(mockUser, 201, res);
    expect(mockUser.getJwtToken).toHaveBeenCalledTimes(1);
  });
});

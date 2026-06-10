const ErrorHandler = require("../utils/ErrorHandler");

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || "Internal server Error";

  // Preserve route-supplied diagnostic fields so the frontend can
  // branch on them (e.g. INSUFFICIENT_STOCK → show force-approve
  // dialog) before any of the recreating branches below swap `err`.
  const routeCode     = err.code;
  const routeShortfall = err.shortfall;

  // wrong mongodb id error
  if (err.name === "CastError") {
    const message = `Resources not found with this id.. Invalid ${err.path}`;
    err = new ErrorHandler(message, 400);
  }

  // Duplicate key error
  if (err.code === 11000) {
    const message = `Duplicate key ${Object.keys(err.keyValue)} Entered`;
    err = new ErrorHandler(message, 400);
  }

  // wrong jwt error
  if (err.name === "JsonWebTokenError") {
    const message = `Your url is invalid please try again letter`;
    err = new ErrorHandler(message, 400);
  }

  // jwt expired
  if (err.name === "TokenExpiredError") {
    const message = `Your Url is expired please try again letter!`;
    err = new ErrorHandler(message, 400);
  }

  // Surface diagnostic fields only when the route attached them via
  // a string `code` (Mongo's 11000 is numeric and is already mapped
  // above). Keeps the response shape clean for typical errors.
  const payload = {
    success: false,
    message: err.message,
  };
  if (typeof routeCode === "string") payload.code = routeCode;
  if (routeShortfall) payload.shortfall = routeShortfall;

  res.status(err.statusCode).json(payload);
};
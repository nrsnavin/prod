// middleware/portalAuth.js
//
// Auth gate for the customer-facing portal API. Hydrates the
// authenticated CustomerUser onto req and pins req.customerId — the
// row-level filter that every portal route must apply when querying
// orders / DCs / invoices / jobs.
//
// Three layers of separation from the admin/employee auth so a
// leaked admin token can't read customer data and vice-versa:
//   1. Distinct cookie name        ("portalToken")
//   2. Distinct signing key        (PORTAL_JWT_SECRET_KEY, falls
//                                   back to JWT_SECRET_KEY in dev)
//   3. Audience claim verification ({audience: "portal"})
//   PLUS the role check below      (decoded.role === "customer")
const jwt              = require("jsonwebtoken");
const ErrorHandler     = require("../utils/ErrorHandler.js");
const catchAsyncErrors = require("./catchAsyncErrors.js");
const CustomerUser     = require("../models/CustomerUser.js");

const PORTAL_COOKIE = "portalToken";

exports.PORTAL_COOKIE = PORTAL_COOKIE;

exports.isCustomerAuthenticated = catchAsyncErrors(async (req, _res, next) => {
  const token = req.cookies?.[PORTAL_COOKIE];
  if (!token) return next(new ErrorHandler("Please log in to the portal", 401));

  let decoded;
  try {
    decoded = jwt.verify(
      token,
      process.env.PORTAL_JWT_SECRET_KEY || process.env.JWT_SECRET_KEY,
      { audience: "portal" }
    );
  } catch (_err) {
    return next(new ErrorHandler("Portal session is invalid — please log in again", 401));
  }

  // Belt-and-suspenders: role + audience must both line up.
  if (decoded.role !== "customer") {
    return next(new ErrorHandler("This token can't be used on the portal", 401));
  }

  const user = await CustomerUser.findById(decoded.id);
  if (!user || user.status !== "active") {
    return next(new ErrorHandler("Portal account not active — contact support", 401));
  }

  req.customerUser = user;
  req.customerId   = user.customer;
  next();
});

// Role gate for portal-internal authorisation (e.g. only buyers can
// place orders; accountants can't). Used as
//   router.post("/orders", isCustomerAuthenticated, requirePortalRole("buyer"), ...);
exports.requirePortalRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.customerUser?.role)) {
    return next(new ErrorHandler(
      `Your role (${req.customerUser?.role}) can't perform this action`,
      403
    ));
  }
  next();
};

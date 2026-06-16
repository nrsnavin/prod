// api/portal/auth.js
//
// Customer-portal auth surface. Separate from /api/v2/user (admin
// + employee logins) — different token, different cookie, different
// role.
//
// Scope for Phase 1:
//   POST /login    email + password
//   POST /logout   clears the portal cookie
//   GET  /me       returns the authenticated user + their org
//
// Phase 2 adds OTP, forgot-password, refresh, multi-user invites.
const express          = require("express");
const router           = express.Router();
const catchAsyncErrors = require("../../middleware/catchAsyncErrors.js");
const ErrorHandler     = require("../../utils/ErrorHandler.js");

const CustomerUser = require("../../models/CustomerUser.js");
const Customer     = require("../../models/Customer.js");

const { isCustomerAuthenticated, PORTAL_COOKIE } = require("../../middleware/portalAuth.js");

// 7-day cookie by default; Secure + SameSite=lax in production so the
// browser actually attaches it on cross-origin XHR from the portal
// SPA. dev: SameSite=lax + non-Secure so it works on localhost http.
function cookieOptions() {
  const isProd = process.env.NODE_ENV === "PRODUCTION";
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge:   7 * 24 * 60 * 60 * 1000,
    path:     "/",
  };
}

// ─────────────────────────────────────────────────────────────────
// POST /api/v3/portal/auth/login
// Body: { email, password }
// ─────────────────────────────────────────────────────────────────
router.post(
  "/login",
  catchAsyncErrors(async (req, res, next) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return next(new ErrorHandler("Email and password are required", 400));
    }

    const user = await CustomerUser.findOne({ email: String(email).toLowerCase().trim() })
      .select("+password");

    // Always run comparePassword (constant-time-ish) when the user
    // exists, but the timing-leak risk on a missing user is small for
    // a B2B portal — collapsing to one generic message is what
    // matters for the UX and prevents user-enumeration.
    const ok = user ? await user.comparePassword(password) : false;
    if (!user || !ok) {
      return next(new ErrorHandler("Invalid email or password", 401));
    }
    if (user.status !== "active") {
      return next(new ErrorHandler("Portal account not active — contact support", 401));
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = user.getJwtToken();
    res.cookie(PORTAL_COOKIE, token, cookieOptions());

    return res.json({
      success: true,
      user: _safe(user),
    });
  })
);

// ─────────────────────────────────────────────────────────────────
// POST /api/v3/portal/auth/logout
// Clears the portal cookie. Stateless — the cookie was the session.
// ─────────────────────────────────────────────────────────────────
router.post("/logout", (_req, res) => {
  res.clearCookie(PORTAL_COOKIE, { path: "/" });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/v3/portal/auth/me
// Returns the authenticated user + their customer org. Used by the
// portal SPA to hydrate state on app boot.
// ─────────────────────────────────────────────────────────────────
router.get(
  "/me",
  isCustomerAuthenticated,
  catchAsyncErrors(async (req, res) => {
    const customer = await Customer.findById(req.customerId).lean();
    return res.json({
      success: true,
      user:     _safe(req.customerUser),
      customer: customer
        ? {
            _id:         customer._id,
            name:        customer.name,
            gstin:       customer.gstin,
            contactName: customer.contactName,
            phoneNumber: customer.phoneNumber,
          }
        : null,
    });
  })
);

// Don't ever return the password hash, even though `select: false`
// would suppress it on most queries.
function _safe(u) {
  return {
    _id:               u._id,
    customer:          u.customer,
    name:              u.name,
    email:             u.email,
    phone:             u.phone,
    role:              u.role,
    status:            u.status,
    notificationPrefs: u.notificationPrefs,
    lastLoginAt:       u.lastLoginAt,
  };
}

module.exports = router;

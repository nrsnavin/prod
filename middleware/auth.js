const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("./catchAsyncErrors");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

exports.isAuthenticated = catchAsyncErrors(async (req, res, next) => {
    const { token } = req.cookies;

    if (!token) {
        return next(new ErrorHandler("Please login to continue", 401));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);

    // BUG FIX: support both 'id' (canonical) and 'userid' (legacy) JWT
    // payload shapes. generateToken() in api/user.js used to put 'userid',
    // so reading decoded.id alone returned undefined and req.user was null,
    // causing every authenticated route to crash.
    const userId = decoded.id || decoded.userid;
    req.user = await User.findById(userId);

    if (!req.user) {
        return next(new ErrorHandler("Session is invalid — please login again", 401));
    }

    next();
});

exports.isAdmin = (...roles) => {
    return (req, res, next) => {
        // Guard against being mounted without a preceding isAuthenticated
        // — a null req.user would otherwise throw a 500 and read as a
        // server error rather than an auth failure.
        if (!req.user) {
            return next(new ErrorHandler("Please login to continue", 401));
        }
        if (!roles.includes(req.user.role)) {
            // 403, not the ErrorHandler default of 500 — this is an
            // authorization denial, not a server fault.
            return next(new ErrorHandler(`${req.user.role} can not access this resources!`, 403));
        }
        next();
    }
}

// Per-user FEATURE guard. Use AFTER isAuthenticated, layered on top of
// the coarse isAdmin(...) role gate, to enforce the same per-user feature
// list the web/mobile nav uses — for EVERYONE, admins included.
//
// It gates WRITES ONLY (POST/PUT/PATCH/DELETE). Reads (GET/HEAD/OPTIONS)
// always pass, so cross-feature reads (e.g. the Customer page pulling a
// customer's recent orders from /order) and worker self-service reads
// (own payslip/leave/attendance) can never be blocked by a feature gate.
//
// A write passes when ANY holds:
//   • the user has NO explicit feature list — the owner / legacy accounts
//     defer to the preceding role gate (an admin with no custom list
//     keeps everything);
//   • the user's explicit `features` list includes ANY of `keys`.
// Otherwise the write is 403 — including for an admin whose custom list
// omits the feature. `keys` accepts the owning feature plus any sibling
// feature that legitimately writes through the same router (e.g. an
// elastic group created from the Order form → also accept /orders).
exports.requireFeature = (...keys) => {
    return (req, res, next) => {
        const m = req.method;
        if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();

        if (!req.user) {
            return next(new ErrorHandler("Please login to continue", 401));
        }

        const explicit = Array.isArray(req.user.features) ? req.user.features : [];
        // No explicit customization → defer to the preceding role gate.
        if (explicit.length === 0) return next();

        if (keys.some((k) => explicit.includes(k))) return next();

        return next(new ErrorHandler("You don't have access to this feature", 403));
    };
};

// Per-employee ownership guard. Use after isAuthenticated on routes
// whose path/query carries an :empId — admins pass through, but a
// worker can only access their own employee record. Closes the
// privacy gap where any logged-in worker could read another's
// payslip / leave history / attendance / bonus by swapping the id.
//
// Resolves the requested employee id from (in order):
//   req.params.empId / req.params.id / req.query.empId / req.query.id
// Compares with `req.user.employee` (the Employee ObjectId linked
// to the requesting User account).
exports.selfOrAdmin = (req, res, next) => {
    // `accounts` (finance) administers payroll/HR, so it reads any
    // employee's records just like admin; everyone else only their own.
    if (req.user?.role === 'admin' || req.user?.role === 'accounts') return next();
    const wantEmp =
        req.params?.empId ??
        req.params?.id    ??
        req.query?.empId  ??
        req.query?.id;
    const myEmp = req.user?.employee?.toString();
    if (myEmp && wantEmp && myEmp === String(wantEmp)) return next();
    return next(new ErrorHandler("Forbidden — you can only access your own records", 403));
};

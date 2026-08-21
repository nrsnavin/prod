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

    // ── Has this account's sessions been ended since? ──────────────
    // The app holds a token for ninety days, so "wait for it to
    // expire" is not an answer to a lost phone. Bumping
    // User.tokenVersion invalidates every token already issued for
    // the account, on every device, immediately.
    //
    // Tokens minted before the claim existed carry no `v`, and those
    // are honoured rather than rejected — deliberately, and for the
    // same reason the `userid` fallback above exists. Rejecting them
    // would sign out every user in the mill the moment this deploys,
    // which is a worse outage than the narrow window it closes. They
    // age out on their own within 24 hours, since every token issued
    // before this change was a 24-hour one.
    if (decoded.v !== undefined && decoded.v !== (req.user.tokenVersion ?? 0)) {
        return next(new ErrorHandler(
            "You have been signed out. Please login again.", 401));
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
//   • the account has NO feature list AT ALL (the field is absent) — a
//     legacy account, the create-admin owner or the WhatsApp bot — which
//     defers to the preceding role gate;
//   • the user's explicit `features` list includes ANY of `keys`.
// Otherwise the write is 403 — including for an admin whose custom list
// omits the feature. `keys` accepts the owning feature plus any sibling
// feature that legitimately writes through the same router (e.g. an
// elastic group created from the Order form → also accept /orders).
//
// An EMPTY list is a decision, not an absence: an admin who ticked no
// boxes gets nothing. Absent-vs-empty is the whole distinction — see
// models/User.js and migrations/20260805000002-unset-empty-user-features.js.
exports.requireFeature = (...keys) => {
    return (req, res, next) => {
        const m = req.method;
        if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();

        if (!req.user) {
            return next(new ErrorHandler("Please login to continue", 401));
        }

        // Never configured → defer to the preceding role gate.
        if (!Array.isArray(req.user.features)) return next();

        const explicit = req.user.features;
        if (keys.some((k) => explicit.includes(k))) return next();

        return next(new ErrorHandler("You don't have access to this feature", 403));
    };
};

// Per-user FEATURE guard for READS — the counterpart requireFeature always
// let through. Without it, an admin narrowing a user's feature list below
// their department default (unticking a box on the Users page) only ever
// stopped that user WRITING through the module; they could still browse
// every record in it by calling the read routes directly, feature list or
// not. This closes that gap, using the identical allow rule requireFeature
// already applies to writes:
//   • no feature list at all (field absent) → defer to the role gate;
//   • explicit list includes ANY of `keys` → allowed;
//   • otherwise (including an explicitly EMPTY list) → 403.
//
// Mount this ONLY where every route on the router is either genuinely
// module-owned data or is independently scoped by identity (selfOrAdmin) —
// gate self-service routes THEMSELVES for that reason if the router
// mixes the two (see payroll.js, leave.js, bonus.js, attendence.js for the
// pattern: exempt the selfOrAdmin path before calling this). A worker
// reading their own payslip is answerable to their identity, not to
// whether the admin ticked the Payroll checkbox for them.
//
// `keys` takes every feature that legitimately reads through this router —
// broader than the write-side list wherever a sibling screen only ever
// reads here (e.g. Analytics pulling delivery-challan on-time stats never
// writes a DC, so /analytics has to be read-only accepted on that mount).
exports.requireFeatureRead = (...keys) => {
    return (req, res, next) => {
        const m = req.method;
        if (m !== "GET" && m !== "HEAD") return next(); // writes: requireFeature's job

        if (!req.user) {
            return next(new ErrorHandler("Please login to continue", 401));
        }

        // Never configured → defer to the role gate. An empty list is a
        // deliberate "nothing", and falls through to the 403 below.
        if (!Array.isArray(req.user.features)) return next();

        const explicit = req.user.features;
        if (keys.some((k) => explicit.includes(k))) return next();

        return next(new ErrorHandler("You don't have access to this feature", 403));
    };
};

// Read gate with PER-PATH widening.
//
// requireFeatureRead applies one key list to a whole router, which is too
// blunt for the shared master-data routers. Every cross-feature read in
// the app is a picker/list call — the Order form needs the customer LIST,
// Analytics needs the machine LIST — but granting that at router level
// also handed over the detail routes, so a user with only /orders could
// read a customer's full record and portal logins.
//
// `base` is who may read the router at all (normally just the owning
// feature). `wider` maps a specific read path to the EXTRA features
// allowed to read only that path. Match is exact or by "/path/" prefix,
// so "/all-customers" won't accidentally open "/all-customers-export".
exports.requireFeatureReadPaths = (base, wider = {}) => {
    const entries = Object.entries(wider);
    return (req, res, next) => {
        const m = req.method;
        if (m !== "GET" && m !== "HEAD") return next(); // writes: requireFeature's job

        if (!req.user) {
            return next(new ErrorHandler("Please login to continue", 401));
        }

        // Never configured → defer to the role gate, as everywhere else.
        if (!Array.isArray(req.user.features)) return next();
        const explicit = req.user.features;

        let keys = base;
        for (const [p, extra] of entries) {
            if (req.path === p || req.path.startsWith(p + "/")) {
                keys = base.concat(extra);
                break;
            }
        }

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

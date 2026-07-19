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

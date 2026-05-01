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
        if (!roles.includes(req.user.role)) {
            return next(new ErrorHandler(`${req.user.role} can not access this resources!`));
        };
        next();
    }
}

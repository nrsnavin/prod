const express = require("express");
const User = require("../models/User.js");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const sendToken = require("../utils/jwtToken.js");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
var jwt = require('jsonwebtoken');


// Sign-up is admin-only — accepting `role` from req.body otherwise lets
// any visitor create themselves an admin account (privilege escalation).
router.post("/sign-up",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
  const user = await User.create(req.body);
  try {
    res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, 500));
  }
}))


// login user
router.post(
  "/login-user",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return next(new ErrorHandler("Please provide the all fields!", 400));
      }

      const user = await User.findOne({ email }).select("+password");

      if (!user) {
        return next(new ErrorHandler("User doesn't exists!", 400));
      }

      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        return next(new ErrorHandler("Invalid credentials!", 401));
      }

      const token = generateToken(user);

      res
        .status(201)
        .cookie("token", token, {
          httpOnly: true,
          sameSite: "none",
          secure: true,
          maxAge: 24 * 60 * 60 * 1000, // 24h
        })
        .json({
          username: user.name,
          id: user._id,
          role: user.role,
          token: token,
        });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

router.get(
  "/getuser",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);

      if (!user) {
        return next(new ErrorHandler("User doesn't exists", 400));
      }

      res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// ─────────────────────────────────────────────────────────────
//  GET /user/me
//
//  Bootstrap endpoint for the employee mobile app. Returns the
//  current user (decoded from the JWT cookie) along with the
//  linked Employee document. The employee app uses the returned
//  `employee._id` to scope shift / wastage / payroll requests.
// ─────────────────────────────────────────────────────────────
router.get(
  "/me",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.user.id)
      .populate("employee", "name department phoneNumber role hourlyRate")
      .lean();
    if (!user) return next(new ErrorHandler("User not found", 404));

    res.status(200).json({
      success: true,
      user: {
        id:       user._id,
        name:     user.name,
        email:    user.email,
        role:     user.role,
        employee: user.employee || null,
      },
    });
  })
);


router.get(
  "/all-users",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const users = await User.find({ role: "admin" });

      if (!users) {
        return next(new ErrorHandler("User doesn't exists", 400));
      }

      res.status(200).json({
        success: true,
        users,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

// log out user
router.get(
  "/logout",
  catchAsyncErrors(async (req, res, next) => {
    try {
      res.cookie("token", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });
      res.status(201).json({
        success: true,
        message: "Log out successful!",
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


// BUG FIX: payload key is 'id' (not 'userid') so middleware/auth.js
// (which reads decoded.id) actually finds the user. Old tokens issued
// with 'userid' still work via the back-compat fallback in auth.js.
function generateToken(user) {
  const payload = {
    id: user._id,
    username: user.name,
    role: user.role,
  };
  const options = {
    expiresIn: "24h",
  };
  return jwt.sign(payload, process.env.JWT_SECRET_KEY, options);
}

module.exports = router;

const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User.js");
const Employee = require("../models/Employee.js");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const sendToken = require("../utils/jwtToken.js");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { EMPLOYEE_CARD_FIELDS } = require("../utils/populateFields");
const { DEPARTMENTS, roleForDepartment, isDepartment } = require("../utils/roles");
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
      // Coerce to strings so a JSON object like {"$gt":""} can never
      // reach the query as a Mongo operator (defence-in-depth on top
      // of the app-wide sanitizeMongo middleware).
      const email    = typeof req.body.email === "string" ? req.body.email.trim() : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!email || !password) {
        return next(new ErrorHandler("Please provide the all fields!", 400));
      }

      const user = await User.findOne({ email }).select("+password");

      // Unify the "user not found" and "bad password" paths into one
      // generic 401. Distinguishing them lets attackers enumerate
      // registered emails via the response code.
      const isPasswordValid = user
        ? await user.comparePassword(password)
        : false;
      if (!user || !isPasswordValid) {
        return next(new ErrorHandler("Invalid email or password", 401));
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
          department: user.department || null,
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
      .populate("employee", EMPLOYEE_CARD_FIELDS)
      .lean();
    if (!user) return next(new ErrorHandler("User not found", 404));

    res.status(200).json({
      success: true,
      user: {
        id:         user._id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        department: user.department || null,
        employee:   user.employee || null,
      },
    });
  })
);


// ─────────────────────────────────────────────────────────────
//  PATCH /user/me
//
//  Lets the authenticated user edit their own profile from the
//  employee mobile app's "Edit Profile" sheet. Accepts:
//    - name         → updates User.name AND linked Employee.name
//    - email        → updates User.email (validated + uniqueness checked)
//    - phoneNumber  → updates linked Employee.phoneNumber
//
//  All writes run inside a mongoose session so the User and the
//  linked Employee stay in sync (no half-updated state on crash).
//  Returns the same shape as GET /me so the client can hydrate
//  LoginController.user directly off the response.
// ─────────────────────────────────────────────────────────────
router.patch(
  "/me",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { name, email, phoneNumber } = req.body || {};

    // Trim now so downstream uniqueness / regex checks see the
    // canonical form the user will actually be saved with.
    const cleanName  = typeof name === "string" ? name.trim() : undefined;
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : undefined;
    const cleanPhone = typeof phoneNumber === "string" ? phoneNumber.trim() : undefined;

    if (cleanEmail !== undefined) {
      // Simple but strict enough: requires user@host.tld, no spaces.
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(cleanEmail)) {
        return next(new ErrorHandler("Invalid email format", 400));
      }
      // Reject if another User already owns this email. We exclude
      // the current user so a no-op email submit still succeeds.
      const existing = await User.findOne({
        email: cleanEmail,
        _id: { $ne: req.user.id },
      }).lean();
      if (existing) {
        return next(new ErrorHandler("Email already in use", 409));
      }
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const userUpdate = {};
        if (cleanName  !== undefined) userUpdate.name  = cleanName;
        if (cleanEmail !== undefined) userUpdate.email = cleanEmail;
        if (Object.keys(userUpdate).length) {
          await User.updateOne(
            { _id: req.user.id },
            { $set: userUpdate },
            { session, runValidators: true },
          );
        }

        // Mirror name + phone onto the linked Employee so that
        // payroll / shift screens (which key off Employee) show
        // the new values too.
        const user = await User.findById(req.user.id).select("employee").lean();
        if (user && user.employee) {
          const empUpdate = {};
          if (cleanName  !== undefined) empUpdate.name        = cleanName;
          if (cleanPhone !== undefined) empUpdate.phoneNumber = cleanPhone;
          if (Object.keys(empUpdate).length) {
            await Employee.updateOne(
              { _id: user.employee },
              { $set: empUpdate },
              { session, runValidators: true },
            );
          }
        }
      });
    } finally {
      session.endSession();
    }

    // Return the canonical /me shape so the client can swap state.
    const fresh = await User.findById(req.user.id)
      .populate("employee", EMPLOYEE_CARD_FIELDS)
      .lean();

    res.status(200).json({
      success: true,
      user: {
        id:       fresh._id,
        name:     fresh.name,
        email:    fresh.email,
        role:     fresh.role,
        employee: fresh.employee || null,
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

// ══════════════════════════════════════════════════════════════
//  USER MANAGEMENT (admin-only) — backs the web app's Users screen.
//  Departments drive the web nav; the backend `role` is derived from
//  the department (utils/roles.js) and is what the RBAC gates enforce.
// ══════════════════════════════════════════════════════════════

// List all users (no password) for the admin Users screen.
router.get(
  "/manage/list",
  isAuthenticated, isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const users = await User.find({})
      .select("name email role department createdAt")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, departments: DEPARTMENTS, users });
  })
);

// Create a user with a department; role is derived, never taken raw.
router.post(
  "/manage/create",
  isAuthenticated, isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const name       = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email      = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password   = typeof req.body.password === "string" ? req.body.password : "";
    const department = typeof req.body.department === "string" ? req.body.department : "";

    if (!name || !email || !password || !department)
      return next(new ErrorHandler("name, email, password and department are required", 400));
    if (!isDepartment(department))
      return next(new ErrorHandler(`Invalid department: ${department}`, 400));
    if (password.length < 4)
      return next(new ErrorHandler("Password must be at least 4 characters", 400));

    const exists = await User.findOne({ email }).lean();
    if (exists) return next(new ErrorHandler("A user with this email already exists", 409));

    const user = await User.create({
      name, email, password, department, role: roleForDepartment(department),
    });
    res.status(201).json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department },
    });
  })
);

// Update a user's department (role re-derived), name, email, or password.
router.put(
  "/manage/:id",
  isAuthenticated, isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.params.id).select("+password");
    if (!user) return next(new ErrorHandler("User not found", 404));

    if (typeof req.body.name === "string" && req.body.name.trim())
      user.name = req.body.name.trim();
    if (typeof req.body.email === "string" && req.body.email.trim())
      user.email = req.body.email.trim().toLowerCase();
    if (typeof req.body.department === "string" && req.body.department) {
      if (!isDepartment(req.body.department))
        return next(new ErrorHandler(`Invalid department: ${req.body.department}`, 400));
      // Guard: don't strip the last admin of their admin department.
      if (user.department === "admin" && req.body.department !== "admin") {
        const admins = await User.countDocuments({ department: "admin" });
        if (admins <= 1) return next(new ErrorHandler("Cannot remove the last admin", 400));
      }
      user.department = req.body.department;
      user.role       = roleForDepartment(req.body.department);
    }
    if (typeof req.body.password === "string" && req.body.password) {
      if (req.body.password.length < 4)
        return next(new ErrorHandler("Password must be at least 4 characters", 400));
      user.password = req.body.password; // pre-save hook re-hashes
    }

    await user.save();
    res.json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department },
    });
  })
);

// Delete a user. Can't delete yourself or the last admin.
router.delete(
  "/manage/:id",
  isAuthenticated, isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    if (String(req.params.id) === String(req.user._id || req.user.id))
      return next(new ErrorHandler("You cannot delete your own account", 400));
    const user = await User.findById(req.params.id);
    if (!user) return next(new ErrorHandler("User not found", 404));
    if (user.department === "admin" || user.role === "admin") {
      const admins = await User.countDocuments({ $or: [{ department: "admin" }, { role: "admin" }] });
      if (admins <= 1) return next(new ErrorHandler("Cannot delete the last admin", 400));
    }
    await user.deleteOne();
    res.json({ success: true, message: "User deleted" });
  })
);

module.exports = router;

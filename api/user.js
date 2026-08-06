const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User.js");
const Employee = require("../models/Employee.js");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const sendToken = require("../utils/jwtToken.js");
const { isAuthenticated, isAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");
const { EMPLOYEE_CARD_FIELDS } = require("../utils/populateFields");
const { DEPARTMENTS, roleForDepartment, isDepartment } = require("../utils/roles");
const { FEATURES, featuresForDepartment, sanitizeFeatures } = require("../utils/features");
const { sendPasswordResetEmail, sendLoginOtpEmail } = require("../utils/mailer");
const { escapeRegex } = require("../utils/escapeRegex");
var jwt = require('jsonwebtoken');

const RESET_TTL_MINUTES = 30;


// Sign-up is admin-only — accepting `role` from req.body otherwise lets
// any visitor create themselves an admin account (privilege escalation).
router.post("/sign-up",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
  // Store emails lowercase — mixed-case emails break the exact-match
  // lookups in login and (before it went case-insensitive) forgot-password.
  if (typeof req.body.email === "string") {
    req.body.email = req.body.email.trim().toLowerCase();
  }
  // Allowlist the fields a create may set. This used to pass req.body
  // straight to User.create, so a request could set ANY schema path —
  // including arbitrary `features` strings and a `role` inconsistent with
  // the department — producing accounts that break the invariants the
  // Users page and the feature gates rely on. Role is derived and the
  // feature list sanitized here exactly as /manage/create does.
  const department = req.body.department || null;
  // Intersect with what the department can reach, the same way
  // /manage/create does — otherwise this path can store keys the role
  // gate will always refuse, which reads as access the user doesn't have.
  const signupScope = new Set(featuresForDepartment(department));
  const user = await User.create({
    name:       req.body.name,
    email:      req.body.email,
    password:   req.body.password,
    department,
    role:       roleForDepartment(department) || req.body.role,
    features:   Array.isArray(req.body.features)
      ? sanitizeFeatures(req.body.features).filter((k) => signupScope.has(k))
      : featuresForDepartment(department),
    ...(req.body.employee ? { employee: req.body.employee } : {}),
  });
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
          features: Array.isArray(user.features)
            ? user.features
            : featuresForDepartment(user.department || user.role),
          token: token,
        });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

// ══════════════════════════════════════════════════════════════
//  FORGOT PASSWORD  —  POST /user/forgot-password  { email }
//
//  Emails a one-time reset link to the account (if it exists). Always
//  returns the SAME generic 200 whether or not the email matched a
//  user, so the endpoint can't be used to discover which emails have
//  accounts (user-enumeration), mirroring how /login-user unifies its
//  errors. A mail-send failure is swallowed for the same reason — the
//  client never learns anything about the target address.
//
//  Rate-limited at the app.js mount (loginLimiter) since it's an
//  unauthenticated, abuse-prone surface.
// ══════════════════════════════════════════════════════════════
router.post(
  "/forgot-password",
  catchAsyncErrors(async (req, res, next) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) {
      return next(new ErrorHandler("Email is required", 400));
    }

    const generic = {
      success: true,
      message: "If an account exists for that email, a reset link has been sent.",
    };

    // Case-insensitive match: accounts created through the legacy
    // /sign-up path may be stored with mixed-case emails, and an exact
    // match on the lowercased input would silently never find them.
    const user = await User.findOne({
      email: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
    });
    // No user → return generic success without sending anything.
    if (!user) {
      return res.status(200).json(generic);
    }

    const rawToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const base = (process.env.WEB_URL || "https://erp.baluelastics.com").replace(/\/+$/, "");
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    try {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
        ttlMinutes: RESET_TTL_MINUTES,
      });
    } catch (err) {
      // Roll back the token so a transient mail outage doesn't leave a
      // live reset token stranded on the account, then still return
      // generic success (never leak the failure to the caller).
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });
      console.error("[forgot-password] mail send failed:", err.message);
    }

    return res.status(200).json(generic);
  })
);

// ══════════════════════════════════════════════════════════════
//  RESET PASSWORD  —  POST /user/reset-password  { token, password }
//
//  Consumes the raw token from the emailed link, verifies its hash is
//  on some user and not expired, sets the new password (the model's
//  pre-save hook re-hashes it) and clears the token so it can't be
//  reused.
// ══════════════════════════════════════════════════════════════
router.post(
  "/reset-password",
  catchAsyncErrors(async (req, res, next) => {
    const rawToken = typeof req.body.token === "string" ? req.body.token.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!rawToken || !password) {
      return next(new ErrorHandler("Token and new password are required", 400));
    }
    if (password.length < 4) {
      return next(new ErrorHandler("Password should be greater than 4 characters", 400));
    }

    const hashed = User.hashResetToken(rawToken);
    const user = await User.findOne({
      resetPasswordToken: hashed,
      resetPasswordExpire: { $gt: new Date() },
    }).select("+resetPasswordToken +resetPasswordExpire +password");

    if (!user) {
      return next(new ErrorHandler("This reset link is invalid or has expired. Request a new one.", 400));
    }

    user.password = password;            // pre-save hook hashes it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password updated. You can now sign in with your new password.",
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  EMAIL-OTP LOGIN
//
//  The primary sign-in for web + mobile: request a 6-digit code by
//  email, then exchange it for the same JWT cookie /login-user issues.
//  /login-user itself stays mounted as an unlisted emergency fallback
//  (e.g. SMTP outage) — nothing in the UI links to it.
//
//  POST /user/request-otp  { email }
//  Same anti-enumeration contract as forgot-password: identical generic
//  200 whether or not the email matches an account, mail failures
//  swallowed. Both routes sit behind loginLimiter in app.js.
// ══════════════════════════════════════════════════════════════
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

router.post(
  "/request-otp",
  catchAsyncErrors(async (req, res, next) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) {
      return next(new ErrorHandler("Email is required", 400));
    }

    const generic = {
      success: true,
      message: "If an account exists for that email, a sign-in code has been sent.",
    };

    const user = await User.findOne({
      email: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
    });
    if (!user) {
      return res.status(200).json(generic);
    }

    const code = user.createLoginOtp();
    await user.save({ validateBeforeSave: false });

    try {
      await sendLoginOtpEmail({
        to: user.email,
        name: user.name,
        code,
        ttlMinutes: OTP_TTL_MINUTES,
      });
    } catch (err) {
      user.clearLoginOtp();
      await user.save({ validateBeforeSave: false });
      console.error("[request-otp] mail send failed:", err.message);
    }

    return res.status(200).json(generic);
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /user/verify-otp  { email, otp }
//
//  On success issues the SAME cookie + JSON shape as /login-user so the
//  web and mobile session code is reused unchanged. The code is
//  single-use (cleared on success) and dies after OTP_MAX_ATTEMPTS
//  wrong guesses or OTP_TTL_MINUTES, whichever comes first.
// ─────────────────────────────────────────────────────────────
router.post(
  "/verify-otp",
  catchAsyncErrors(async (req, res, next) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const otp   = typeof req.body.otp === "string" ? req.body.otp.trim()
                : typeof req.body.otp === "number" ? String(req.body.otp) : "";

    if (!email || !otp) {
      return next(new ErrorHandler("Email and code are required", 400));
    }

    const user = await User.findOne({
      email: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
    }).select("+otpCode +otpExpire +otpAttempts");

    // One generic 401 for every failure mode — no oracle for which part
    // was wrong (missing account, stale code, bad guess).
    const fail = () => next(new ErrorHandler("Invalid or expired code — request a new one.", 401));

    if (!user || !user.otpCode || !user.otpExpire) return fail();

    if (user.otpExpire.getTime() < Date.now()) {
      user.clearLoginOtp();
      await user.save({ validateBeforeSave: false });
      return fail();
    }

    if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
      user.clearLoginOtp();
      await user.save({ validateBeforeSave: false });
      return fail();
    }

    const hashed = User.hashResetToken(otp); // same sha256 helper
    if (hashed !== user.otpCode) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save({ validateBeforeSave: false });
      return fail();
    }

    user.clearLoginOtp();
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user);
    res
      .status(201)
      .cookie("token", token, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 24 * 60 * 60 * 1000, // 24h — matches /login-user
      })
      .json({
        username: user.name,
        id: user._id,
        role: user.role,
        department: user.department || null,
        // The comment above promises the SAME shape as /login-user, and
        // it did not: `features` was missing here. The web app offers
        // ONLY the OTP path, and its session mapper reads
        // `res.features ?? undefined` — so every web login landed with
        // no feature list, and the client fell back to the DEPARTMENT
        // defaults. Per-user access was invisible in the UI: nav entries
        // and buttons the admin had revoked stayed on screen, and the
        // API's 403 was the first anyone heard of it.
        features: Array.isArray(user.features)
          ? user.features
          : featuresForDepartment(user.department || user.role),
        token: token,
      });
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
        // When this login was created — the profile page's "member since".
        createdAt:  user.createdAt,
        // Effective per-user feature set (falls back to the department
        // default for legacy users with none stored) so the client can
        // refresh access on load without re-login. NOTE: this is the one
        // live GET /me — do not add a second, it would be shadowed.
        features:   Array.isArray(user.features)
          ? user.features
          : featuresForDepartment(user.department || user.role),
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

// NOTE: GET /user/me lives above (near the profile routes) and already
// returns the effective feature set. A second /me here would be shadowed
// by Express (first match wins), so it is intentionally not redefined.

// The Users screen is a revocable feature (/users), so being admin-ROLE
// is not enough to reach it — an admin-department account whose list
// omits /users must not be able to read the roster (every account, its
// department and its exact feature grants) or edit anyone. This can't be
// gated at the mount in app.js: this router also hosts the public
// login / OTP / forgot-password routes, so the gate is scoped to the
// /manage prefix here instead. It must stay ABOVE the routes it guards —
// Express runs middleware in declaration order.
router.use("/manage", isAuthenticated, requireFeature('/users'), requireFeatureRead('/users'));

// List all users (no password) for the admin Users screen.
router.get(
  "/manage/list",
  isAuthenticated, isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const users = await User.find({})
      .select("name email role department features createdAt")
      .sort({ createdAt: -1 })
      .lean();
    // Backfill an effective feature set for legacy users with none stored,
    // so the admin screen shows what they can actually access.
    const withFeatures = users.map((u) => ({
      ...u,
      features: Array.isArray(u.features)
        ? u.features
        : featuresForDepartment(u.department || u.role),
    }));
    res.json({ success: true, departments: DEPARTMENTS, features: FEATURES, users: withFeatures });
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

    // Explicit custom feature list if supplied, else the department default.
    // A user's features are a SUBSET of what their department/role can
    // reach — intersect so a feature the role gate would block can never
    // be stored (keeps the per-user set and the role gate consistent).
    const scope = new Set(featuresForDepartment(department));
    let features;
    if (Array.isArray(req.body.features)) {
      const requested = sanitizeFeatures(req.body.features);
      features = requested.filter((k) => scope.has(k));
      // An explicit [] means "grant nothing" and is honoured. But a
      // non-empty request that scopes down to nothing means the caller
      // sent another department's keys — since [] now means "granted
      // nothing" rather than "defer to the role gate", silently storing
      // it would create an account locked out of everything at birth.
      if (requested.length > 0 && features.length === 0) {
        return next(new ErrorHandler(
          `None of the selected features are available to the ${department} department`, 400
        ));
      }
    } else {
      features = featuresForDepartment(department);
    }

    const user = await User.create({
      name, email, password, department, role: roleForDepartment(department), features,
    });
    res.status(201).json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, features: user.features },
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
    if (Array.isArray(req.body.features)) {
      // Scope to the user's (possibly just-changed) department/role.
      const scope = new Set(featuresForDepartment(user.department || user.role));
      const requested = sanitizeFeatures(req.body.features);
      const scoped = requested.filter((k) => scope.has(k));
      // Sending a non-empty list that scopes down to nothing means the
      // caller changed the department without re-picking features. That
      // is a mismatch, not a revocation — and since [] now means "granted
      // nothing", storing it would silently lock the account out of every
      // module. An explicit [] still means exactly that, deliberately.
      if (requested.length > 0 && scoped.length === 0) {
        return next(new ErrorHandler(
          `None of the selected features are available to the ${user.department || user.role} department`, 400
        ));
      }
      user.features = scoped;
    }

    await user.save();
    res.json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, features: user.features },
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

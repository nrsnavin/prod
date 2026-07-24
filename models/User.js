const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      min: 2,
      max: 100,
      required: [true, "Please enter your name!"],
    },
    email: {
      type: String,
      required: [true, "Please enter your email!"],
      max: 50,
      unique: true,
    },
    password: {
      type: String,
      required: [true, "Please enter your password"],
      minLength: [4, "Password should be greater than 4 characters"],
      select: false,
    },
    role: {
      type: String,
      required: true,
    },
    // Shop-floor department that drives the web app's nav + route access
    // (preparatory / weaving / packing / finance / admin). The coarser
    // `role` above is DERIVED from this (see utils/roles.js) and is what
    // the backend RBAC gates enforce. Optional so pre-existing users
    // (which only carry `role`) remain valid.
    department: {
      // preparatory + weaving were merged into "production"; the legacy
      // values stay enum-valid so pre-migration accounts still save.
      type: String,
      enum: ["admin", "production", "packing", "finance", "preparatory", "weaving"],
    },
    // Per-user custom feature access (keys mirror the web nav paths, e.g.
    // "/orders", "/wastage"). When set, this is the source of truth for
    // what the user can SEE/open. Empty/unset → the app falls back to the
    // department-derived default set (utils/features.js), so pre-existing
    // users keep working. `admin` always has everything regardless.
    features: {
      type: [String],
      default: [],
    },
    // Optional link to the Employee document. Set on User creation
    // for any user that's also a workforce member, so the mobile
    // employee app can look up their wastage / shift / payroll
    // records via this id without an extra query.
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },
    // Password-reset flow. We store only the SHA-256 HASH of the token
    // that was emailed — never the raw token — so a database leak can't
    // be replayed to reset anyone's password. `select:false` keeps both
    // out of normal query results.
    resetPasswordToken: {
      type: String,
      select: false,
    },
    resetPasswordExpire: {
      type: Date,
      select: false,
    },
    // Email-OTP login. Same hashing discipline as the reset token: only
    // the SHA-256 hash of the 6-digit code is stored. otpAttempts caps
    // brute-force guessing of a live code (cleared on success/expiry).
    otpCode: {
      type: String,
      select: false,
    },
    otpExpire: {
      type: Date,
      select: false,
    },
    otpAttempts: {
      type: Number,
      select: false,
      default: 0,
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next){
  if(!this.isModified("password")){
    next();
  }

  this.password = await bcrypt.hash(this.password, 10);
});

// jwt token
userSchema.methods.getJwtToken = function () {
  return jwt.sign({ id: this._id,role:this.role,name:this.name,email:this.email}, process.env.JWT_SECRET_KEY,{
    expiresIn: process.env.JWT_EXPIRES,
  });
};

// compare password
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ─────────────────────────────────────────────────────────────
//  Password reset token
//
//  Returns the RAW token (goes in the emailed link) and stores its
//  SHA-256 hash + a 30-minute expiry on the document. Caller must
//  save() the user afterwards. Verification hashes the incoming raw
//  token and matches the hash — the raw value never touches the DB.
// ─────────────────────────────────────────────────────────────
userSchema.methods.createPasswordResetToken = function () {
  const rawToken = crypto.randomBytes(32).toString("hex");
  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
  this.resetPasswordExpire = new Date(Date.now() + 30 * 60 * 1000); // 30 min
  return rawToken;
};

// Static helper: hash a raw token the same way for lookup.
userSchema.statics.hashResetToken = function (rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
};

// ─────────────────────────────────────────────────────────────
//  Login OTP
//
//  Returns the RAW 6-digit code (goes in the email) and stores its
//  SHA-256 hash + a 10-minute expiry + a reset attempt counter on the
//  document. Caller must save() afterwards.
// ─────────────────────────────────────────────────────────────
userSchema.methods.createLoginOtp = function () {
  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits, crypto RNG
  this.otpCode = crypto.createHash("sha256").update(code).digest("hex");
  this.otpExpire = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  this.otpAttempts = 0;
  return code;
};

userSchema.methods.clearLoginOtp = function () {
  this.otpCode = undefined;
  this.otpExpire = undefined;
  this.otpAttempts = 0;
};

const User = mongoose.model("User", userSchema);
module.exports=User;


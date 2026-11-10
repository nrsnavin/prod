// models/CustomerUser.js
//
// A person who logs in to the customer-facing portal. Belongs to a
// Customer org (the company). One Customer → many CustomerUsers so
// procurement, accounts, and plant-side contacts at the same
// customer can all have separate logins with different roles.
//
// Distinct from User (admin/employee/worker) and from the contact
// blocks embedded on Customer itself (purchase/accountant/merchandiser
// — those are just records of who to call; CustomerUsers actually
// authenticate).
const mongoose = require("mongoose");
const { hashPassword, verifyPassword } = require("../utils/passwordHash");
const jwt      = require("jsonwebtoken");

const CustomerUserSchema = new mongoose.Schema(
  {
    customer: {
      type:     mongoose.Types.ObjectId,
      ref:      "Customer",
      required: true,
      index:    true,
    },
    name: {
      type:     String,
      required: [true, "Please enter the contact's name"],
      min:      2,
      max:      100,
    },
    email: {
      type:     String,
      required: [true, "Please enter an email"],
      max:      100,
      unique:   true,
      lowercase: true,
      trim:     true,
    },
    phone: {
      type: String,
      default: "",
      trim:    true,
    },
    password: {
      type:      String,
      required:  [true, "Please set a password"],
      minLength: [8, "Password must be at least 8 characters"],
      select:    false,
    },
    role: {
      type:    String,
      enum:    ["buyer", "viewer", "accountant"],
      default: "buyer",
    },
    status: {
      type:    String,
      enum:    ["active", "disabled"],
      default: "active",
    },
    notificationPrefs: {
      email: { type: Boolean, default: true },
      sms:   { type: Boolean, default: false },
    },
    lastLoginAt: { type: Date },
    // Counted up when the password is changed or the login is switched
    // off: a session opened before then is refused (middleware/portalAuth.js).
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

CustomerUserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await hashPassword(this.password);
});

// JWT — separate cookie and (optionally) separate secret from the
// admin app. Includes `aud: "portal"` so the portal middleware can
// reject any admin-issued token even if the secret was shared.
CustomerUserSchema.methods.getJwtToken = function () {
  return jwt.sign(
    {
      id:       this._id,
      role:     "customer",
      portalRole: this.role,
      customer: this.customer,
      name:     this.name,
      email:    this.email,
      v:        this.tokenVersion ?? 0,
    },
    process.env.PORTAL_JWT_SECRET_KEY || process.env.JWT_SECRET_KEY,
    {
      audience:  "portal",
      expiresIn: process.env.PORTAL_JWT_EXPIRES || "7d",
      algorithm: "HS256",
    }
  );
};

// Same contract as User#comparePassword: verify, and upgrade a legacy
// bcrypt hash in place once the password is proven.
CustomerUserSchema.methods.comparePassword = async function (entered) {
  const { ok, needsRehash } = await verifyPassword(entered, this.password);
  if (ok && needsRehash) {
    try {
      const upgraded = await hashPassword(entered);
      await this.constructor.updateOne({ _id: this._id }, { $set: { password: upgraded } });
    } catch (err) {
      console.warn(`[portal-auth] hash upgrade skipped for ${this._id}: ${err?.message}`);
    }
  }
  return ok;
};

module.exports = mongoose.model("CustomerUser", CustomerUserSchema);

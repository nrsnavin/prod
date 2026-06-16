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
const bcrypt   = require("bcryptjs");
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
      minLength: [6, "Password should be at least 6 characters"],
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
  },
  { timestamps: true }
);

CustomerUserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
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
    },
    process.env.PORTAL_JWT_SECRET_KEY || process.env.JWT_SECRET_KEY,
    {
      audience:  "portal",
      expiresIn: process.env.PORTAL_JWT_EXPIRES || "7d",
    }
  );
};

CustomerUserSchema.methods.comparePassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model("CustomerUser", CustomerUserSchema);

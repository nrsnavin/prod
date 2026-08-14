const mongoose = require("mongoose");


const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true, // allows multiple nulls
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        'Invalid GSTIN format',
      ],
    },

    phoneNumber: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
    },
    // ── Replenishment terms ──────────────────────────────────────
    //
    // How long this supplier takes to deliver, in days. THE number the
    // reorder point is built on: ordering on the day stock runs out is
    // ordering `leadTimeDays` too late, and before this field existed
    // the forecast had no way to know that.
    //
    // Defaults to 0, which reproduces the old behaviour exactly — a
    // zero-lead-time material has a reorder point of zero and is never
    // flagged early. So nothing changes on any screen until somebody
    // fills these in, which is the right default for a field nobody has
    // set yet.
    leadTimeDays: { type: Number, default: 0, min: 0 },

    // What this supplier will actually sell. A suggestion of 812 kg
    // against a 25 kg pack means 825 — ordering 812 gets you 825 and an
    // invoice nobody expected.
    minOrderQty: { type: Number, default: 0, min: 0 },
    packSize:    { type: Number, default: 0, min: 0 },

    address: {
      type: String,
    },

    contactPerson: {
      type: String,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const SupplierModel = mongoose.model("Supplier", supplierSchema);
module.exports = SupplierModel;
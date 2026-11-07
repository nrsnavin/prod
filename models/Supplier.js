const mongoose = require("mongoose");


const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // The ledger's name in Tally when it is not `name` exactly.
    tallyName: { type: String, trim: true, default: "", maxlength: 120 },

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

    // What the supplier may charge: a composition dealer or an
    // unregistered supplier charges no GST (services/billChecks.js).
    gstRegistration: { type: String, enum: ["regular", "composition", "unregistered"], default: "regular" },

    // Days after the bill date its bills fall due (and its expenses).
    paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },

    // For TDS returns (26Q): without a PAN, tax is deducted at 20% (s.206AA).
    pan: { type: String, trim: true, uppercase: true, default: "", maxlength: 10 },
    // Where they are paid. A change is the classic payment fraud (a mail
    // "our bank has changed"), so when, by whom and from what is kept, and
    // a payment soon after it must be confirmed (services/paymentChecks.js).
    bank: {
      accountNo:         { type: String, trim: true, default: "", maxlength: 20 },
      ifsc:              { type: String, trim: true, uppercase: true, default: "", maxlength: 11 },
      holder:            { type: String, trim: true, default: "", maxlength: 120 },
      changedAt:         { type: Date, default: null },
      changedByName:     { type: String, default: "" },
      previousAccountNo: { type: String, default: "" },
      // "cheque" when read from their cancelled cheque (utils/kycOcr.js),
      // with whether the holder printed on it is this supplier's name.
      source:            { type: String, enum: ["", "typed", "cheque"], default: "" },
      holderMatches:     { type: Boolean, default: null },
    },

    // MSME (Udyam) registration. A bill to a micro or small enterprise
    // must be paid within 15 days, or the days agreed in writing (at most
    // 45): otherwise the expense is disallowed in the year (s.43B(h)) and
    // the supplier is owed interest (MSMED Act s.16).
    msme: {
      category:   { type: String, enum: ["", "micro", "small", "medium"], default: "" },
      udyam:      { type: String, trim: true, uppercase: true, default: "", maxlength: 20 },
      agreedDays: { type: Number, default: 0, min: 0, max: 45 },
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
'use strict';
//
// A price quoted to a customer for one elastic, and the costing behind it.
//
// The costing is stored ALONGSIDE the rate rather than recomputed on
// read. A quote is a commitment made on a particular day at particular
// yarn prices; if it were recalculated when reopened, last month's quote
// would silently restate itself at this month's costs and nobody could
// answer why the customer was charged what they were charged.
//
// It is deliberately not tied to an Elastic. Quotes are written for
// developments that do not exist in the system yet — that is most of
// what quoting IS — so the product is described in words and its recipe
// typed in. `elastic` is there for the day a quote is raised against a
// product on file, and is never required.

const mongoose = require('mongoose');

const QuoteMaterialSchema = new mongoose.Schema(
  {
    // Free text: the four the form ships with are named, and anything
    // else the customer's cloth needs is typed.
    label:       { type: String, required: true, trim: true },
    weightGrams: { type: Number, default: 0, min: 0 },
    ratePerKg:   { type: Number, default: 0, min: 0 },
    // Frozen, not derived. See the note above.
    cost:        { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const QuoteSchema = new mongoose.Schema(
  {
    // QT-25/26-0001
    quoteNo:       { type: String, required: true, unique: true, index: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },

    date:      { type: Date, required: true, default: Date.now },
    validTill: { type: Date, required: true },

    // Typed, or picked from the customer master. A quote often goes to
    // somebody who is not a customer yet, so the name is what is
    // required and the reference is what is optional.
    customer:        { type: mongoose.Types.ObjectId, ref: 'Customer' },
    customerName:    { type: String, required: true, trim: true },
    customerAddress: { type: String, default: '', trim: true },
    customerGstin:   { type: String, default: '', trim: true },
    customerRef:     { type: String, default: '', trim: true },

    // The product being quoted, described rather than referenced.
    elastic:     { type: mongoose.Types.ObjectId, ref: 'Elastic' },
    productName: { type: String, required: true, trim: true },
    productSpec: { type: String, default: '', trim: true },

    materials: { type: [QuoteMaterialSchema], default: [] },

    // ── The costing, per metre, frozen at the moment of quoting ──
    totalWeightGrams: { type: Number, default: 0 },
    materialCost:     { type: Number, default: 0 },
    conversionCost:   { type: Number, default: 0 },
    totalCost:        { type: Number, default: 0 },
    marginPercent:    { type: Number, default: 0 },
    marginAmount:     { type: Number, default: 0 },
    rateBeforeTax:    { type: Number, default: 0 },
    gstPercent:       { type: Number, default: 5 },
    gstAmount:        { type: Number, default: 0 },
    rateInclTax:      { type: Number, default: 0 },

    // Optional — an indicative quantity, and what the order would come
    // to at this rate. Not a commitment to supply it.
    quantityMetres: { type: Number, default: 0, min: 0 },
    valueBeforeTax: { type: Number, default: 0 },
    valueInclTax:   { type: Number, default: 0 },

    remarks: { type: String, default: '', trim: true },

    status: {
      type: String,
      enum: ['draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled'],
      default: 'draft',
      index: true,
    },

    createdBy:    { type: mongoose.Types.ObjectId, ref: 'User' },
    fingerprints: { type: Array, default: [] },
  },
  { timestamps: true }
);

QuoteSchema.index({ financialYear: 1, sequence: 1 });
QuoteSchema.index({ customerName: 1, date: -1 });

module.exports = mongoose.model('Quote', QuoteSchema);

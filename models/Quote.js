'use strict';
//
// A price quoted to a customer, and the costing behind every line of it.
//
// The costing is stored ALONGSIDE the rate rather than recomputed on
// read. A quote is a commitment made on a particular day at particular
// yarn prices; if it were recalculated when reopened, last month's quote
// would silently restate itself at this month's costs and nobody could
// answer why the customer was charged what they were charged.
//
// SEVERAL PRODUCTS, ONE DOCUMENT
//
// A customer asking about elastic asks about three widths at once, so a
// quotation carries lines. Each line is costed and priced on its own —
// its own materials, conversion cost and margin — because they are
// different cloths and averaging them would quote every one wrongly.
//
// GST sits on the QUOTE, not the line. It is a property of what is being
// sold rather than of which row it lands on, and one quotation for
// elastic tape carries one rate. Per-line tax would invite a document
// that adds up to a figure the invoice cannot match.
//
// THE CUSTOMER
//
// `customer` links the master record when there is one, and the name and
// address are ALSO copied onto the quote. That is deliberate: a quote is
// a document that was sent, and it has to keep saying what it said even
// after the customer master is edited or archived. The link is for
// finding things; the snapshot is the document.

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

const QuoteLineSchema = new mongoose.Schema(
  {
    // Optional — quotes are written for developments that do not exist
    // in the system yet, which is most of what quoting IS.
    elastic:     { type: mongoose.Types.ObjectId, ref: 'Elastic' },
    productName: { type: String, required: true, trim: true },
    productSpec: { type: String, default: '', trim: true },

    materials:      { type: [QuoteMaterialSchema], default: [] },
    conversionCost: { type: Number, default: 0, min: 0 },
    marginPercent:  { type: Number, default: 0, min: 0 },
    quantityMetres: { type: Number, default: 0, min: 0 },

    // ── Frozen costing, per metre of THIS product ──
    totalWeightGrams: { type: Number, default: 0 },
    materialCost:     { type: Number, default: 0 },
    totalCost:        { type: Number, default: 0 },
    marginAmount:     { type: Number, default: 0 },
    rateBeforeTax:    { type: Number, default: 0 },
    gstAmount:        { type: Number, default: 0 },
    rateInclTax:      { type: Number, default: 0 },

    // Extended over the quantity, when one was given.
    valueBeforeTax: { type: Number, default: 0 },
    valueInclTax:   { type: Number, default: 0 },
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

    // The link, and the snapshot. See the note above.
    customer:        { type: mongoose.Types.ObjectId, ref: 'Customer', index: true },
    customerName:    { type: String, required: true, trim: true },
    customerAddress: { type: String, default: '', trim: true },
    customerGstin:   { type: String, default: '', trim: true },
    customerPhone:   { type: String, default: '', trim: true },
    customerRef:     { type: String, default: '', trim: true },

    lines: { type: [QuoteLineSchema], default: [] },

    // ── Document totals ──
    gstPercent:          { type: Number, default: 5 },
    subTotal:            { type: Number, default: 0 },
    gstAmount:           { type: Number, default: 0 },
    grandTotal:          { type: Number, default: 0 },
    totalQuantityMetres: { type: Number, default: 0 },

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

"use strict";
// ══════════════════════════════════════════════════════════════════
//  SUPPLIER BILL (purchase bill)
//
//  What a supplier charged for goods or services — yarn against a
//  purchase order and its goods receipts, or a job-work / transport
//  bill with no PO. The bill's own number and date are the supplier's;
//  ours (PB/2026-27/0001) is the series the books run on.
//
//  The tax split is recorded per line so the input credit (ITC) is
//  known, and whether this payee is subject to TDS so the payment
//  voucher deducts it. What has been paid, deducted and debited is
//  kept on the bill (updated by vouchers and notes inside the same
//  transaction) so the outstanding is a subtraction, not a scan.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { TaxLineSchema, TotalsSchema, AttachmentSchema, FingerprintSchema } = require("./accountsShared");

const SupplierBillSchema = new mongoose.Schema(
  {
    billNo:        { type: String, required: true, unique: true, trim: true }, // ours
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    supplier:      { type: mongoose.Types.ObjectId, ref: "Supplier", required: true },
    supplierName:  { type: String, required: true, trim: true },
    supplierGstin: { type: String, default: "", trim: true },
    supplierStateCode: { type: String, default: "" },

    // The supplier's own invoice number and date — what the GST return matches on.
    supplierBillNo: { type: String, required: true, trim: true, maxlength: 40 },
    billDate:       { type: Date, required: true },
    dueDate:        { type: Date },

    purchaseOrder: { type: mongoose.Types.ObjectId, ref: "PurchaseOrder" },
    poNo:          { type: Number },
    inwards:       { type: [{ type: mongoose.Types.ObjectId, ref: "MaterialInward" }], default: [] },

    kind: { type: String, enum: ["goods", "service"], default: "goods" },
    // A service or spare-part bill entered from a machine's service log.
    machine:     { type: mongoose.Types.ObjectId, ref: "Machine" },
    serviceBill: { type: mongoose.Types.ObjectId, ref: "MachineServiceBill" },
    category: { type: mongoose.Types.ObjectId, ref: "ExpenseCategory" },

    supplyType: { type: String, enum: ["intra", "inter"], required: true },
    lines:  { type: [TaxLineSchema], default: [] },
    totals: { type: TotalsSchema, default: () => ({}) },

    // Input tax credit: claimable unless the bill says otherwise
    // (composition supplier, blocked credit).
    itc: {
      eligible: { type: Boolean, default: true },
      amount:   { type: Number, default: 0 },
    },
    // What the supplier reported in GSTR-2B for this bill (services/gstr2b.js).
    gstr2b: {
      status:  { type: String, enum: ["", "matched", "mismatch", "missing"], default: "" },
      period:  { type: String, default: "" },   // the 2B month it was found (or looked for) in
      entry:   { type: mongoose.Types.ObjectId, ref: "Gstr2bEntry" },
      diff:    { type: Number, default: 0 },    // tax in books − tax in 2B
      note:    { type: String, default: "" },
      at:      { type: Date },
    },
    // Input credit reversed because the supplier was not paid within 180
    // days (CGST Rule 37), and re-claimed when paid.
    itcReversal: {
      amount:        { type: Number, default: 0 },
      period:        { type: String, default: "" },
      at:            { type: Date },
      reclaimAmount: { type: Number, default: 0 },
      reclaimPeriod: { type: String, default: "" },
      reclaimAt:     { type: Date },
    },
    // TDS to deduct when paying this bill.
    tds: {
      applicable: { type: Boolean, default: false },
      section:    { type: String, default: "", trim: true },
      rate:       { type: Number, default: 0, min: 0, max: 100 },
    },

    // Reverse charge: the supplier charged no GST and we pay it. `totals`
    // are what the supplier is owed; this is the tax we owe and claim.
    reverseCharge: { type: Boolean, default: false },
    rcm: {
      cgst: { type: Number, default: 0 }, sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 }, tax: { type: Number, default: 0 },
    },

    // The three-way match: lines whose rate is off the PO or whose
    // quantity is more than was received, and the note that let it in.
    variance: {
      lines: {
        type: [new mongoose.Schema({
          description: String, rawMaterial: { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
          poRate: Number, billRate: Number, receivedQty: Number, billedQty: Number, rateOffPercent: Number, amount: Number,
        }, { _id: false })],
        default: [],
      },
      total: { type: Number, default: 0 },
      note:  { type: String, default: "" },
    },

    // Settled so far — by vouchers, TDS deducted on them, debit notes.
    paidAmount:    { type: Number, default: 0 },
    tdsAmount:     { type: Number, default: 0 },
    debitedAmount: { type: Number, default: 0 },

    status: { type: String, enum: ["open", "part_paid", "paid", "cancelled"], default: "open" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },

    notes:       { type: String, default: "", trim: true, maxlength: 500 },
    attachments: { type: [AttachmentSchema], default: [] },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date }, cancelBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, cancelAt: { type: Date } },
    // "manual", or "scan" when the bill photo was read by the model.
    source:      { type: String, default: "manual" },
    aiSuggestion: { type: mongoose.Types.ObjectId, ref: "AiSuggestion" },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

SupplierBillSchema.index({ financialYear: 1, sequence: 1 });
SupplierBillSchema.index({ supplier: 1, billDate: -1 });
SupplierBillSchema.index({ status: 1, dueDate: 1 });
SupplierBillSchema.index({ purchaseOrder: 1 });
// The same supplier invoice entered twice is the commonest double payment.
// ($in, not $ne: a partial index cannot say "not cancelled" directly.)
SupplierBillSchema.index({ supplier: 1, supplierBillNo: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["open", "part_paid", "paid"] } } });

/** What is still owed on this bill. */
SupplierBillSchema.methods.outstanding = function outstanding() {
  return Math.round(((this.totals?.grand || 0) - this.paidAmount - this.tdsAmount - this.debitedAmount) * 100) / 100;
};

module.exports = mongoose.model("SupplierBill", SupplierBillSchema);

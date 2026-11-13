'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WEEK'S PAYMENT RUN, AS PAID — services/paymentRun.js
//
//  The proposal is worked out afresh each time it is asked for, and kept
//  nowhere. What is kept is the run a person paid: which suppliers, the
//  bills each payment settled and why each was in the run, the cash
//  position it was worked out on, and the voucher each made (or why it
//  failed). "Why did we pay them that week?" has an answer later.
//
//  One run per request id: the same request sent twice is answered by
//  the first, and each supplier's payment carries `${requestId}:${id}`,
//  so a retry never pays anyone twice.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const PaymentRunSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true },
    date: { type: Date, required: true },
    account: { type: mongoose.Types.ObjectId, ref: 'BankAccount', required: true },
    accountName: { type: String, default: '' },
    /** What the run was worked out on: bank, commitments, what could be spent. */
    cash: { type: mongoose.Schema.Types.Mixed, default: null },
    lines: [
      {
        _id: false,
        supplier: { type: mongoose.Types.ObjectId, ref: 'Supplier' },
        supplierName: String,
        priority: String,
        why: String,
        docs: [{ _id: false, docType: String, doc: mongoose.Types.ObjectId, docNo: String, outstanding: Number, tds: Number, cash: Number, why: String }],
        gross: Number,
        tds: Number,
        cash: Number,
        riskNote: { type: String, default: '' },
        status: { type: String, enum: ['paid', 'failed'], required: true },
        payment: { type: mongoose.Types.ObjectId, ref: 'Payment', default: null },
        voucherNo: { type: String, default: '' },
        error: { type: String, default: '' },
      },
    ],
    totals: { suppliers: Number, paid: Number, failed: Number, cash: Number, tds: Number },
    /** 'running' while its payments are being made; then how it ended. */
    status: { type: String, enum: ['running', 'paid', 'partly_paid', 'failed'], required: true },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

PaymentRunSchema.index({ requestId: 1 }, { unique: true });
PaymentRunSchema.index({ createdAt: -1 });

module.exports = mongoose.models.PaymentRun || mongoose.model('PaymentRun', PaymentRunSchema);

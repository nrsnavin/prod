'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MONTH'S ELECTRICITY BILL — services/powerCost.js
//
//  What the factory's electricity bill says for a month: the units used,
//  what they and the demand cost, and the total. Set against the metres
//  woven that month it gives power cost per metre. One bill a month per
//  service connection; a second for the same month replaces nothing.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const PowerBillSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    consumerNo: { type: String, default: '' },
    billNo: { type: String, default: '' },
    billDate: { type: Date, default: null },
    periodFrom: { type: Date, default: null },
    periodTo: { type: Date, default: null },
    units: { type: Number, required: true, min: 0 },
    demandKva: { type: Number, default: null },
    energyCharges: { type: Number, default: null },
    demandCharges: { type: Number, default: null },
    otherCharges: { type: Number, default: null },
    tax: { type: Number, default: null },
    total: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, default: null },
    note: { type: String, default: '' },
    file: { type: String, select: false, default: '' },
    aiSuggestion: { type: String, default: '' },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

PowerBillSchema.index({ month: 1, consumerNo: 1 }, { unique: true });

module.exports = mongoose.models.PowerBill || mongoose.model('PowerBill', PowerBillSchema);

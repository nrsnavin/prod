'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A SUPPLIER QUOTED FOR A MATERIAL — services/priceLists.js
//
//  One rate per supplier and material is live at a time: a newer price
//  list or quotation takes its place (the old one is kept, not live).
//  A purchase order or bill line above the live rate is flagged; nothing
//  is refused for it.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const SupplierRateSchema = new mongoose.Schema(
  {
    supplier: { type: mongoose.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, default: '' },
    rawMaterial: { type: mongoose.Types.ObjectId, ref: 'RawMaterial', required: true },
    materialName: { type: String, default: '' },
    /** As the supplier wrote it. */
    description: { type: String, default: '' },
    rate: { type: Number, required: true, min: 0 },
    unit: { type: String, default: '' },
    gstPercent: { type: Number, default: null },
    minQty: { type: Number, default: null },
    source: { type: String, enum: ['price_list', 'quotation', 'manual'], default: 'quotation' },
    ref: { type: String, default: '' },
    quotedOn: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    live: { type: Boolean, default: true },
    replacedBy: { type: mongoose.Types.ObjectId, ref: 'SupplierRate', default: null },
    aiSuggestion: { type: String, default: '' },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

SupplierRateSchema.index({ supplier: 1, rawMaterial: 1, live: 1 });
SupplierRateSchema.index({ rawMaterial: 1, live: 1 });

module.exports = mongoose.models.SupplierRate || mongoose.model('SupplierRate', SupplierRateSchema);

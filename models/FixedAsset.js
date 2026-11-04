"use strict";
// ══════════════════════════════════════════════════════════════════
//  FIXED ASSET
//
//  A loom, a warping machine, the compressor, the office computer: what
//  the business bought to keep, not to sell. Each sits in a block for
//  the Income-tax Act (the block's rate, written-down value) and in a
//  class for the Companies Act (Schedule II useful life), and the
//  register (services/fixedAssets.js) works the year's depreciation out
//  under both — the two never agree, and both are needed: one for the
//  accounts, the other for the tax return (deferred tax is the gap).
//
//  `openingWdv` is for an asset bought before these books began: the
//  written-down values under each act at the start of `openingWdv.fy`,
//  from the old register, so the schedule carries on from there.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema, AttachmentSchema } = require("./accountsShared");

/** Income-tax blocks (Rule 5, Appendix I) and Schedule II useful lives. */
const BLOCKS = {
  building:   { label: "Buildings (factory, office)",           itRate: 10, life: 30 },
  plant:      { label: "Plant & machinery",                     itRate: 15, life: 15 },
  furniture:  { label: "Furniture & fittings",                  itRate: 10, life: 10 },
  computer:   { label: "Computers, printers, phones",           itRate: 40, life: 3 },
  server:     { label: "Servers & networks",                    itRate: 40, life: 6 },
  vehicle:    { label: "Vehicles",                              itRate: 15, life: 8 },
  office:     { label: "Office equipment",                      itRate: 15, life: 5 },
  electrical: { label: "Electrical installations",              itRate: 10, life: 10 },
  intangible: { label: "Software, licences (intangible)",       itRate: 25, life: 5 },
};

const FixedAssetSchema = new mongoose.Schema(
  {
    assetNo:       { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    name:        { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    block:       { type: String, enum: Object.keys(BLOCKS), required: true },
    // Companies Act: written-down value (the default) or straight line.
    method:      { type: String, enum: ["wdv", "slm"], default: "wdv" },
    // Schedule II residual value, as a percent of cost (5% is the norm).
    residualPercent: { type: Number, default: 5, min: 0, max: 50 },
    // A life other than the schedule's, when the auditor agreed one.
    lifeYears:   { type: Number, min: 1, max: 100 },

    purchaseDate: { type: Date, required: true },
    // The day it was ready for use: depreciation runs from here.
    putToUse:     { type: Date, required: true },
    // Cost capitalised: price, freight, installation, GST not claimed.
    cost:         { type: Number, required: true, min: 0 },

    supplier:     { type: mongoose.Types.ObjectId, ref: "Supplier" },
    supplierName: { type: String, default: "", trim: true },
    supplierBill: { type: mongoose.Types.ObjectId, ref: "SupplierBill" },
    billNo:       { type: String, default: "", trim: true },
    machine:      { type: mongoose.Types.ObjectId, ref: "Machine" },
    location:     { type: String, default: "", trim: true, maxlength: 80 },
    // Serial / engine / registration number, as the insurer knows it.
    identifier:   { type: String, default: "", trim: true, maxlength: 60 },

    openingWdv: {
      fy:           { type: String, default: "" },
      companiesAct: { type: Number, min: 0 },
      incomeTax:    { type: Number, min: 0 },
    },

    status: { type: String, enum: ["active", "sold", "scrapped"], default: "active" },
    disposal: {
      date:   { type: Date },
      amount: { type: Number, min: 0 },   // what it fetched; 0 when scrapped
      reason: { type: String, default: "", trim: true, maxlength: 200 },
      by:     { type: mongoose.Types.ObjectId, ref: "User" },
    },

    attachments:  { type: [AttachmentSchema], default: [] },
    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

FixedAssetSchema.index({ block: 1, status: 1 });
FixedAssetSchema.index({ putToUse: 1 });
FixedAssetSchema.statics.BLOCKS = BLOCKS;

module.exports = mongoose.model("FixedAsset", FixedAssetSchema);
module.exports.BLOCKS = BLOCKS;

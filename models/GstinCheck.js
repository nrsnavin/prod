'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE GST SYSTEM SAID ABOUT A GSTIN, AND WHEN
//
//  "Verify" on a customer or supplier form asks the GST system, through
//  the connected provider, what it holds on a GSTIN (services/
//  gstinLookup.js). The answer is kept here, one row per GSTIN:
//
//    • a second click, or the same number on the other form, within a
//      few minutes is answered from here — each call to the provider is
//      a call somebody pays for;
//    • the form can say "Active on the GST portal · checked 18 Nov"
//      when the party is opened again, without asking again;
//    • it is the record that somebody did check, who, and what came back.
//
//  Keyed by the GSTIN and not stored on the customer or supplier: a
//  number changed on a party simply has no check of its own, so a stale
//  "verified" can never be read against the wrong number.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const STATUSES = ['active', 'cancelled', 'suspended', 'inactive', 'provisional', 'unknown'];

const GstinCheckSchema = new mongoose.Schema(
  {
    gstin: { type: String, required: true, unique: true, uppercase: true, trim: true },
    /** false: the GST system has no such GSTIN (or would not say). */
    found: { type: Boolean, default: false },
    /** The provider's own words when it was not found. */
    said: { type: String, default: '', maxlength: 300 },

    status: { type: String, enum: STATUSES, default: 'unknown' },
    statusText: { type: String, default: '' },
    legalName: { type: String, default: '' },
    tradeName: { type: String, default: '' },
    taxpayerType: { type: String, default: '' },
    composition: { type: Boolean, default: false },
    sez: { type: Boolean, default: false },
    /** Calendar dates as the system gives them, YYYY-MM-DD ('' when none). */
    registeredOn: { type: String, default: '' },
    cancelledOn: { type: String, default: '' },
    /** Blocked from e-invoicing (the e-invoice system's flag); null when not said. */
    einvoiceBlocked: { type: Boolean, default: null },
    address: {
      line: { type: String, default: '' },
      locality: { type: String, default: '' },
      city: { type: String, default: '' },
      district: { type: String, default: '' },
      state: { type: String, default: '' },
      stateCode: { type: String, default: '' },
      pincode: { type: String, default: '' },
    },

    /** Who was asked: "cleartax", "http-json" or "lookup". */
    source: { type: String, default: '' },
    checkedAt: { type: Date, default: Date.now },
    checkedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    checkedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GstinCheck', GstinCheckSchema);
module.exports.GSTIN_STATUSES = STATUSES;

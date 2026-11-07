'use strict';
// The fingerprint of a bill or receipt photo (utils/imageHash.js), kept
// to say "this photo is already on bill B/12" when it is scanned again.
// A scan's rows wait unlinked (`aiSuggestion`) until the bill or expense
// made from it is saved; only linked rows are matched against.
const mongoose = require('mongoose');

const ImageFingerprintSchema = new mongoose.Schema(
  {
    sha:   { type: String, required: true, index: true },
    dhash: { type: String, default: null, index: true },
    aiSuggestion: { type: mongoose.Types.ObjectId, index: true },
    linked: { type: Boolean, default: false, index: true },
    docType: { type: String, enum: ['SupplierBill', 'Expense', ''], default: '' },
    docId: { type: mongoose.Types.ObjectId },
    docNo: { type: String, default: '' },
    partyName: { type: String, default: '' },
    amount: { type: Number },
    date: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ImageFingerprint', ImageFingerprintSchema);

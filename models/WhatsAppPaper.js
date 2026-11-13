'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PHOTO SENT TO THE WHATSAPP NUMBER — services/whatsappPapers.js
//
//  Whatever someone photographed and sent: a production slip, a
//  supplier's bill, a petty cash receipt, a customer's cheque, a
//  supplier's challan, a customer's PO or payment advice. Each is sorted
//  and handed to the inbox that already reads that paper (the slip
//  reader, the bills inbox, the customer inbox), or — a cheque, a
//  challan, something nobody could tell — kept here for a person, with
//  what was read. The photo stays here either way, so it can be sent on
//  again when the sorting was wrong.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const KINDS = ['production_slip', 'supplier_bill', 'expense_receipt', 'cheque', 'delivery_challan', 'purchase_order', 'payment_advice', 'other'];
const STATUSES = [
  'received',  // taken from the webhook; waiting to be fetched and sorted
  'sorting',   // being fetched, sorted and handed on
  'waiting',   // sorted, and a person has something to do here (a cheque, a challan, an unknown photo)
  'done',      // handed to another inbox, or entered from here
  'dismissed', // not for the books
  'failed',    // could not be fetched or sorted
];

/** Where it went: another inbox's record, or what was entered from it. */
const PlaceSchema = new mongoose.Schema({
  doc: { type: String, default: '' },        // 'SlipIngest' | 'InboxBill' | 'InboxMail' | 'Payment' | 'MaterialInward'
  docId: { type: mongoose.Types.ObjectId, default: null },
  label: { type: String, default: '' },
}, { _id: false });

const WhatsAppPaperSchema = new mongoose.Schema(
  {
    messageSid: { type: String, default: undefined },
    from: { type: String, default: '' },
    /** Who sent it: one of our people, a customer or a supplier on file. */
    who: { type: String, enum: ['staff', 'customer', 'supplier'], required: true },
    sentBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    sentByName: { type: String, default: '' },
    /** May this sender's photos be read as production slips (a production login, or the owner). */
    mayRecordSlips: { type: Boolean, default: false },
    customer: { type: mongoose.Types.ObjectId, ref: 'Customer', default: null },
    supplier: { type: mongoose.Types.ObjectId, ref: 'Supplier', default: null },
    partyName: { type: String, default: '' },
    caption: { type: String, default: '' },

    /** Twilio's links, until the photo is fetched; then the photo itself. */
    media: { type: [{ _id: false, url: String, contentType: String }], default: [], select: false },
    files: { type: [{ _id: false, contentType: String, size: Number, data: String }], default: [], select: false },
    pages: { type: Number, default: 0 },
    /** Four digits, for a reply that sends it on: "BILL 4821". */
    code: { type: String, default: '' },

    status: { type: String, enum: STATUSES, default: 'received', index: true },
    kind: { type: String, enum: [...KINDS, null], default: null },
    /** What decided the kind: the caption, an e-invoice QR, the model, a person, or nothing (the old default). */
    kindBy: { type: String, enum: ['', 'caption', 'qr', 'model', 'person', 'fallback'], default: '' },
    summary: { type: String, default: '' },
    sentTo: { type: PlaceSchema, default: null },
    /** A cheque's or challan's read, kept for the form that enters it. */
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    note: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    aiSuggestion: { type: String, default: '' },

    entered: { type: PlaceSchema, default: null },
    decidedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WhatsAppPaperSchema.index({ messageSid: 1 }, { unique: true, partialFilterExpression: { messageSid: { $type: 'string' } } });
WhatsAppPaperSchema.index({ status: 1, createdAt: -1 });
WhatsAppPaperSchema.index({ from: 1, createdAt: -1 });
WhatsAppPaperSchema.index({ code: 1, status: 1 });

const WhatsAppPaper = mongoose.models.WhatsAppPaper || mongoose.model('WhatsAppPaper', WhatsAppPaperSchema);
module.exports = WhatsAppPaper;
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;

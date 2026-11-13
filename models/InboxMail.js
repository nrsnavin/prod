'use strict';
// A customer's mail read from the customer mailbox (services/customerInbox.js):
// what it was, who sent it, and what it became — an order request, a
// complaint, a payment advice placed on the books, a quote drafted.
const mongoose = require('mongoose');

const InboxMailSchema = new mongoose.Schema({
  messageId:  { type: String, required: true, unique: true },
  /** Mailed, or a photo sent to the WhatsApp number (services/whatsappPapers.js). */
  source:     { type: String, enum: ['mail', 'whatsapp'], default: 'mail' },
  paper:      { type: mongoose.Types.ObjectId, ref: 'WhatsAppPaper', default: null },
  from:       { type: String, default: '' },
  subject:    { type: String, default: '' },
  receivedAt: { type: Date, default: Date.now, index: true },
  text:       { type: String, default: '' },
  files:      { type: [{ _id: false, filename: String, contentType: String, size: Number }], default: [] },
  customer:     { type: mongoose.Types.ObjectId, ref: 'Customer', default: null },
  customerName: { type: String, default: '' },
  kind:     { type: String, enum: ['purchase_order', 'complaint', 'payment_advice', 'enquiry', 'other'], default: 'other', index: true },
  summary:  { type: String, default: '' },
  status:   { type: String, enum: ['reading', 'new', 'done', 'dismissed', 'skipped'], default: 'reading', index: true },
  note:     { type: String, default: '' },
  // What it became.
  orderRequest: { type: mongoose.Types.ObjectId, ref: 'OrderRequest', default: null },
  complaint:    { type: mongoose.Types.ObjectId, ref: 'Complaint', default: null },
  draft:        { type: mongoose.Schema.Types.Mixed, default: null }, // complaint/quote/advice read, when nothing was created
  aiSuggestion: { type: String, default: '' },
  decidedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
  decidedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.models.InboxMail || mongoose.model('InboxMail', InboxMailSchema);

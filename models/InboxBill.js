'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BILL FROM THE BILLS MAILBOX — services/billMailbox.js
//
//  One PDF or photo that came by mail to the bills address, read the way
//  a scanned bill is (utils/billOcr.js) and matched to a supplier on
//  file, waiting for someone to open it as a filled-in bill, check every
//  figure and enter it — or dismiss it. Nothing reaches the books until
//  then. The file is kept (base64, like a timer photo) so the bill can be
//  checked against it and carries it once entered.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const InboxBillSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    /** Which attachment of the mail it is: one bill per file. */
    part: { type: Number, default: 0 },
    from: { type: String, default: '' },
    subject: { type: String, default: '' },
    receivedAt: { type: Date },

    filename: { type: String, default: '' },
    contentType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    data: { type: String, select: false },

    status: { type: String, enum: ['new', 'entered', 'dismissed', 'failed', 'skipped'], default: 'new', index: true },
    note: { type: String, default: '' },

    /** What was read (utils/billOcr.js readBill), as the scan returns it. */
    read: { type: mongoose.Schema.Types.Mixed, default: null },
    /** The e-invoice QR code found in the file, as its text (utils/einvoiceQr.js reads it). */
    einvoiceQr: { type: String, default: '' },
    supplier: { type: mongoose.Types.ObjectId, ref: 'Supplier', default: null },
    supplierName: { type: String, default: '' },
    matchedBy: { type: String, default: null },
    /** The sender's address is the supplier's on file. */
    senderKnown: { type: Boolean, default: false },
    alreadyEntered: { type: String, default: null },
    grand: { type: Number, default: null },
    aiSuggestion: { type: mongoose.Types.ObjectId, ref: 'AiSuggestion', default: null },

    bill: { type: mongoose.Types.ObjectId, ref: 'SupplierBill', default: null },
    decidedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

InboxBillSchema.index({ messageId: 1, part: 1 }, { unique: true });
InboxBillSchema.index({ status: 1, receivedAt: -1 });

module.exports = mongoose.model('InboxBill', InboxBillSchema);

'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NOTICE FROM A GOVERNMENT AUTHORITY, AND ITS REPLY DEADLINE
//
//  GST, income tax, TDS, PF, ESI or professional tax: what it is, the
//  period and amount, and the date by which it must be answered. Open
//  until replied (with the reply's reference) and then closed. Reminders
//  go out as the deadline nears (services/noticeReminders.js); each one
//  is noted in `reminded` so it is sent once.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { AttachmentSchema } = require('./accountsShared');

const AUTHORITIES = ['gst', 'income_tax', 'tds', 'pf', 'esi', 'professional_tax', 'other'];
const STATUSES = ['open', 'replied', 'closed'];

const StatutoryNoticeSchema = new mongoose.Schema(
  {
    authority:     { type: String, enum: AUTHORITIES, default: 'other', index: true },
    form:          { type: String, trim: true, default: '' },
    reference:     { type: String, trim: true, default: '' },
    subject:       { type: String, trim: true, default: '' },
    periodText:    { type: String, trim: true, default: '' },
    financialYear: { type: String, default: '' },
    amount:        { type: Number, min: 0 },
    issuedOn:      Date,
    replyBy:       { type: Date, index: true },
    replyByAssumed: { type: Boolean, default: false },
    hearingOn:     Date,
    summary:       { type: String, default: '' },
    documents:     { type: [String], default: [] },
    owner:         { type: String, trim: true, default: '' },

    status:     { type: String, enum: STATUSES, default: 'open', index: true },
    repliedOn:  Date,
    replyRef:   { type: String, trim: true, default: '' },
    closedNote: { type: String, trim: true, default: '' },

    /** Reminder keys already sent: "7", "3", "1", "0", "overdue". */
    reminded:  { type: [String], default: [] },
    source:    { type: String, enum: ['photo', 'typed'], default: 'typed' },
    attachments: { type: [AttachmentSchema], default: [] },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

StatutoryNoticeSchema.index({ status: 1, replyBy: 1 });
StatutoryNoticeSchema.index({ reference: 1 });

module.exports = mongoose.model('StatutoryNotice', StatutoryNoticeSchema);
module.exports.AUTHORITIES = AUTHORITIES;
module.exports.STATUSES = STATUSES;

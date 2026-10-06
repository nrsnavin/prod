'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PRODUCTION SLIP, READ FROM A PHOTO AND WAITING TO BE CONFIRMED
//
//  received → reading → ready → applied
//                     ↘ failed        (nothing could be read / matched)
//  ready / failed → discarded
//
//  Nothing here touches a shift until someone confirms it — by replying
//  "OK <code>" on WhatsApp, or on the web review screen. Even then the
//  values only become a SUBMISSION (pending verification); a supervisor
//  still verifies each entry before it reaches the job.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const STATUSES = ['received', 'reading', 'ready', 'failed', 'applied', 'discarded'];
const OPEN_STATUSES = ['received', 'reading', 'ready', 'failed'];

const RowSchema = new mongoose.Schema(
  {
    shiftDetail: { type: mongoose.Types.ObjectId, ref: 'ShiftDetail', default: null },
    /** What was read off the photo. */
    code: { type: String, default: null },
    machineRead: { type: String, default: null },
    /** What it matched in the plan. */
    machineID: { type: String, default: null },
    operator: { type: String, default: null },
    jobNo: { type: String, default: null },
    production: { type: Number, default: null },
    timer: { type: String, default: null },
    remarks: { type: String, default: '' },
    confidence: { type: Number, default: null },
    /**
     *  ready  safe to save as read (an "OK" saves these)
     *  check  needs a person to look first (web review)
     *  skip   cannot be saved (verified already, plan finalised)
     */
    state: { type: String, enum: ['ready', 'check', 'skip'], default: 'check' },
    /** Why it is 'check' or 'skip', in words. */
    notes: { type: [String], default: [] },
    expected: {
      low: { type: Number, default: null },
      high: { type: Number, default: null },
    },
    applied: { type: Boolean, default: false },
    appliedProduction: { type: Number, default: null },
  },
  { _id: false }
);

const SlipIngestSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['whatsapp', 'web'], required: true },
    /** Twilio's id for the message: a webhook retry is the same slip. */
    messageSid: { type: String, default: undefined },
    from: { type: String, default: '' },
    sentBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    sentByName: { type: String, default: '' },
    caption: { type: String, default: '' },
    /** Where to fetch the photos from (WhatsApp); emptied once fetched. */
    media: {
      type: [{ url: String, contentType: String, _id: false }],
      default: [],
      select: false,
    },
    pages: { type: Number, default: 0 },

    status: { type: String, enum: STATUSES, default: 'received', index: true },
    /** Why it failed or what it is waiting for, in words. */
    problem: { type: String, default: null },
    /** The number quoted in "OK 4821". */
    confirmCode: { type: String, required: true, index: true },
    readAttempts: { type: Number, default: 0 },

    /** What the photo said, kept so a corrected date/shift can re-match. */
    read: { type: mongoose.Schema.Types.Mixed, default: null },
    format: { type: String, enum: ['sheet', 'slip', null], default: null },

    /** The shift it belongs to. */
    shiftPlan: { type: mongoose.Types.ObjectId, ref: 'ShiftPlan', default: null },
    dateKey: { type: String, default: null }, // YYYY-MM-DD
    shift: { type: String, enum: ['DAY', 'NIGHT', null], default: null },
    /** How the date and shift were known: plan, codes, caption, slip, person. */
    dateFrom: { type: String, default: null },

    rows: { type: [RowSchema], default: [] },
    unmatched: {
      type: [{
        // machineRead, not machine: elsewhere `machine` is a reference, and
        // utils/blankRefs.js only cleans names that are never plain text.
        code: String, machineRead: String, production: Number, timer: String, remarks: String, _id: false,
      }],
      default: [],
    },

    suggestion: { type: mongoose.Types.ObjectId, ref: 'AiSuggestion', default: null },
    readAt: { type: Date, default: null },

    /** Set while a save is running, so a double "OK" saves once. */
    applyingAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    appliedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    appliedByName: { type: String, default: '' },
    discardedAt: { type: Date, default: null },
    discardedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

SlipIngestSchema.index({ messageSid: 1 }, { unique: true, partialFilterExpression: { messageSid: { $type: 'string' } } });
SlipIngestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SlipIngest', SlipIngestSchema);
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;

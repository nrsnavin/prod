'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAMPLE REQUEST
//  File: models/SampleRequest.js
//
//  A customer asks for a sample before they place an order. That request
//  then lives for days or weeks — the spec is discussed, a trial is run,
//  it fails, it is run again, it goes out for approval — and until now
//  none of that was written down anywhere but WhatsApp.
//
//  So this is a LOG, not a form. The request itself is written once and
//  never edited; everything that happens afterwards is appended as an
//  entry with its author and time. A record whose fields can be quietly
//  rewritten cannot answer "what did we tell them, and when" — which is
//  the only question anybody asks a sample file six weeks later.
//
//  Terminal states (completed / closed) are an admin's call. Reopening
//  is allowed and is itself logged: an entry that can be undone silently
//  is not evidence of anything.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/** Live states first, then the two an admin sets. */
const SAMPLE_STATUSES = ['open', 'in_progress', 'completed', 'closed'];

/** The states that accept no further work without an admin reopening. */
const TERMINAL_STATUSES = ['completed', 'closed'];

const PRIORITIES = ['low', 'normal', 'high'];

/**
 * One line of the log.
 *
 * `byName` is a snapshot rather than a populate: the log has to still
 * read correctly after the user who wrote it leaves and their account is
 * removed. `kind` separates the three things an entry can be, so the UI
 * can render a status change differently from a note without parsing
 * text.
 */
const SampleLogSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['created', 'update', 'status', 'photo', 'photo_removed'],
      default: 'update',
    },
    note: { type: String, default: '', trim: true },
    // Set on a `photo` / `photo_removed` entry — the SamplePhoto it is
    // about. The bytes live in their own collection; this is the link.
    photo: { type: mongoose.Types.ObjectId, ref: 'SamplePhoto', default: null },
    // Only set on a `status` entry — what the sample was moved TO.
    status: { type: String, enum: SAMPLE_STATUSES, default: null },
    // What it was moved FROM, so the log reads without cross-referencing.
    fromStatus: { type: String, enum: SAMPLE_STATUSES, default: null },
    by: { type: mongoose.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const SampleRequestSchema = new mongoose.Schema(
  {
    // Allocated atomically through utils/sequence.js — people refer to a
    // sample by its number on the phone, so it has to be stable and its
    // own, not a position in a list.
    sampleNo: { type: Number, required: true, unique: true, index: true },

    title: { type: String, required: true, trim: true },

    // A sample is often for a prospect who is not a customer yet, so the
    // reference is optional and the name is kept alongside it either way.
    customer: { type: mongoose.Types.ObjectId, ref: 'Customer', index: true },
    customerName: { type: String, default: '', trim: true },

    // The spec as it was asked for: width, colour, composition, whatever
    // the customer said. Free text on purpose — every sample is a thing
    // that does not fit the product master yet.
    details: { type: String, required: true, trim: true },

    /** Metres wanted, when a quantity was named at all. */
    quantity: { type: Number, default: 0, min: 0 },

    targetDate: { type: Date, default: null },

    priority: { type: String, enum: PRIORITIES, default: 'normal' },

    status: {
      type: String,
      enum: SAMPLE_STATUSES,
      default: 'open',
      index: true,
    },

    log: { type: [SampleLogSchema], default: [] },

    raisedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
    raisedByName: { type: String, default: '' },

    // Who ended it and when — duplicated out of the log so a list can be
    // sorted and filtered on it without unwinding every entry.
    closedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The list screen is "the open ones, newest first" almost every time.
SampleRequestSchema.index({ status: 1, createdAt: -1 });

const SampleRequest = mongoose.model('SampleRequest', SampleRequestSchema);

module.exports = SampleRequest;
module.exports.SAMPLE_STATUSES = SAMPLE_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
module.exports.PRIORITIES = PRIORITIES;

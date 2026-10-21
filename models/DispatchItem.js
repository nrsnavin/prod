'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE THING WAITING TO LEAVE THE PLANT
//
//  Created when a job reaches packing or a sample request is completed
//  (services/dispatchQueue.js). It waits for marketing or admin to say
//  how urgent the delivery is, then sits in the dispatch queue in
//  deadline order until it is marked dispatched.
//
//    awaiting_urgency → queued → dispatched
//            └──────────┴──────→ cancelled  (job cancelled, sample reopened, removed)
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { URGENCIES } = require('../domain/dispatchSlots');

const DISPATCH_STATUSES = ['awaiting_urgency', 'queued', 'dispatched', 'cancelled'];
const OPEN_STATUSES = ['awaiting_urgency', 'queued'];

const HistorySchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['created', 'urgency', 'dispatched', 'cancelled', 'reopened'], required: true },
    urgency: { type: String, enum: [...URGENCIES, null], default: null },
    note: { type: String, default: '' },
    by: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DispatchItemSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['job', 'sample'], required: true },
    job: { type: mongoose.Types.ObjectId, ref: 'JobOrder', default: undefined },
    order: { type: mongoose.Types.ObjectId, ref: 'Order', default: undefined },
    sample: { type: mongoose.Types.ObjectId, ref: 'SampleRequest', default: undefined },

    // Snapshots, so the queue reads without populating and still reads
    // right if a master record is renamed later.
    customer: { type: mongoose.Types.ObjectId, ref: 'Customer', default: undefined },
    customerName: { type: String, default: '' },
    /** "J-3", "Sample #12" — what people call it. */
    ref: { type: String, default: '' },
    title: { type: String, default: '' },
    /** Metres, when known. */
    quantity: { type: Number, default: 0 },
    orderNo: { type: Number, default: null },

    status: { type: String, enum: DISPATCH_STATUSES, default: 'awaiting_urgency', index: true },
    /** When it reached the dispatch stage — first come, first served within a slot. */
    readyAt: { type: Date, default: Date.now },

    urgency: { type: String, enum: [...URGENCIES, null], default: null },
    dueAt: { type: Date, default: null },
    urgencySetBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    urgencySetByName: { type: String, default: '' },
    urgencySetAt: { type: Date, default: null },

    dispatchedAt: { type: Date, default: null },
    dispatchedByName: { type: String, default: '' },
    dispatchNote: { type: String, default: '' },
    cancelReason: { type: String, default: '' },

    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true }
);

// One queue entry per job and per sample; it is revived, not duplicated.
DispatchItemSchema.index({ job: 1 }, { unique: true, partialFilterExpression: { job: { $type: 'objectId' } } });
DispatchItemSchema.index({ sample: 1 }, { unique: true, partialFilterExpression: { sample: { $type: 'objectId' } } });
DispatchItemSchema.index({ status: 1, dueAt: 1, readyAt: 1 });

module.exports = mongoose.model('DispatchItem', DispatchItemSchema);
module.exports.DISPATCH_STATUSES = DISPATCH_STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;

'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DISPATCH QUEUE
//
//    GET   /dispatch/queue                what is waiting, most urgent first
//    GET   /dispatch/queue?view=dispatched  what has gone, newest first
//    PATCH /dispatch/:id/urgency          ADMIN / MARKETING — when it must leave
//    POST  /dispatch/:id/dispatched       it has gone
//    POST  /dispatch/:id/cancel           ADMIN — off the queue, with a reason
//
//  Items join from the job and sample flows (services/dispatchQueue.js).
//  Order: anything still waiting for an urgency first — it cannot be
//  placed until somebody answers — then by deadline, earliest first, and
//  within one deadline by who was ready first.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const catchAsyncErrors = require('../middleware/catchAsyncErrors.js');
const ErrorHandler = require('../utils/ErrorHandler.js');
const { isAdmin } = require('../middleware/auth.js');
const { saveIf, changedMeanwhile } = require('../utils/conditionalSave.js');
const DispatchItem = require('../models/DispatchItem');
const { OPEN_STATUSES } = require('../models/DispatchItem');
const { URGENCIES, URGENCY_LABELS, dueAtFor, urgencyRank } = require('../domain/dispatchSlots');

const MAX_NOTE = 500;
const note = (v) => String(v ?? '').trim().slice(0, MAX_NOTE);
const actor = (req) => ({ by: req.user?._id ?? null, byName: req.user?.name || '' });

/** Queue order: awaiting first (oldest first), then deadline, slot, readiness. */
function queueOrder(a, b) {
  const aw = a.status === 'awaiting_urgency', bw = b.status === 'awaiting_urgency';
  if (aw !== bw) return aw ? -1 : 1;
  if (!aw) {
    const d = new Date(a.dueAt) - new Date(b.dueAt);
    if (d) return d;
    const r = urgencyRank(a.urgency) - urgencyRank(b.urgency);
    if (r) return r;
  }
  return new Date(a.readyAt) - new Date(b.readyAt);
}

const shape = (i, now) => ({
  ...i,
  urgencyLabel: i.urgency ? URGENCY_LABELS[i.urgency] : null,
  late: !!(i.dueAt && OPEN_STATUSES.includes(i.status) && new Date(i.dueAt) < now),
});

async function load(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw new ErrorHandler('Dispatch item not found', 404);
  const item = await DispatchItem.findById(id);
  if (!item) throw new ErrorHandler('Dispatch item not found', 404);
  return item;
}

router.get(
  '/queue',
  catchAsyncErrors(async (req, res) => {
    const now = new Date();
    if (req.query.view === 'dispatched') {
      const items = await DispatchItem.find({ status: 'dispatched' })
        .sort({ dispatchedAt: -1 }).limit(100).lean();
      return res.json({ success: true, now, items: items.map((i) => shape(i, now)) });
    }
    // The open queue is small by nature — what is packed and not yet gone —
    // so it is sorted here, where "awaiting first" is easy to say.
    const items = await DispatchItem.find({ status: { $in: OPEN_STATUSES } }).limit(500).lean();
    items.sort(queueOrder);
    const shaped = items.map((i) => shape(i, now));
    res.json({
      success: true,
      now,
      urgencies: URGENCIES.map((u) => ({ value: u, label: URGENCY_LABELS[u] })),
      counts: {
        awaiting: shaped.filter((i) => i.status === 'awaiting_urgency').length,
        queued: shaped.filter((i) => i.status === 'queued').length,
        late: shaped.filter((i) => i.late).length,
      },
      items: shaped,
    });
  })
);

router.patch(
  '/:id/urgency',
  isAdmin('admin', 'marketing'),
  catchAsyncErrors(async (req, res, next) => {
    const { urgency } = req.body || {};
    if (!URGENCIES.includes(urgency)) {
      return next(new ErrorHandler(`urgency must be one of: ${URGENCIES.join(', ')}`, 400));
    }
    const item = await load(req.params.id);
    if (!OPEN_STATUSES.includes(item.status)) {
      return next(new ErrorHandler(`This is already ${item.status}; its urgency cannot change`, 409));
    }
    const from = item.status;
    const now = new Date();
    const who = actor(req);
    item.urgency = urgency;
    item.dueAt = dueAtFor(urgency, now);
    item.urgencySetBy = who.by;
    item.urgencySetByName = who.byName;
    item.urgencySetAt = now;
    item.status = 'queued';
    item.history.push({ action: 'urgency', urgency, note: note(req.body.note), ...who, at: now });
    // Only if nobody dispatched or removed it meanwhile.
    if (!(await saveIf(item, { status: from }))) return next(changedMeanwhile('This dispatch', 'updated'));
    res.json({ success: true, item: shape(item.toObject(), now) });
  })
);

router.post(
  '/:id/dispatched',
  catchAsyncErrors(async (req, res, next) => {
    const item = await load(req.params.id);
    if (!OPEN_STATUSES.includes(item.status)) {
      return next(new ErrorHandler(`This is already ${item.status}`, 409));
    }
    const from = item.status;
    const now = new Date();
    const who = actor(req);
    item.status = 'dispatched';
    item.dispatchedAt = now;
    item.dispatchedByName = who.byName;
    item.dispatchNote = note(req.body?.note);
    item.history.push({ action: 'dispatched', note: item.dispatchNote, ...who, at: now });
    if (!(await saveIf(item, { status: from }))) return next(changedMeanwhile('This dispatch', 'updated'));
    res.json({ success: true, item: shape(item.toObject(), now) });
  })
);

router.post(
  '/:id/cancel',
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const reason = note(req.body?.reason);
    if (reason.length < 3) return next(new ErrorHandler('Say why it is coming off the queue', 400));
    const item = await load(req.params.id);
    if (!OPEN_STATUSES.includes(item.status)) {
      return next(new ErrorHandler(`This is already ${item.status}`, 409));
    }
    const from = item.status;
    const who = actor(req);
    item.status = 'cancelled';
    item.cancelReason = reason;
    item.history.push({ action: 'cancelled', note: reason, ...who, at: new Date() });
    if (!(await saveIf(item, { status: from }))) return next(changedMeanwhile('This dispatch', 'updated'));
    res.json({ success: true, item: shape(item.toObject(), new Date()) });
  })
);

module.exports = router;
module.exports.queueOrder = queueOrder;

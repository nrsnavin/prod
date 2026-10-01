'use strict';

// ══════════════════════════════════════════════════════════════════
//  HOW AN ORDER FOLLOWS ITS JOBS
//
//  An order's status moves when something happens to one of its jobs:
//  raising the first job starts it, the last job finishing completes it,
//  the last live job being cancelled sends it back to waiting. Those
//  reactions used to be written inline in three different route handlers
//  in api/job.js, each beside unrelated job code, which is how an order
//  once came back from the dead (see domain/orderStatus.js).
//
//  They live here now, one function per event, so "what does an order do
//  when its job X?" has one answer in one file. Each:
//    • moves the status only through applyOrderStatus, which refuses a
//      move from a terminal state (a finished order is never reopened);
//    • stamps the order's own timeline;
//    • takes the caller's transaction session where the caller has one,
//      so the order and the job land together or not at all.
//
//  Synchronous by design: the job routes need the order's new state in
//  the same request (and, on completion, in the same transaction).
//  Notifications and other side effects that can happen later go through
//  the outbox (utils/outbox.js) instead.
// ══════════════════════════════════════════════════════════════════

const Order = require('../models/Order');
const { liveJobStatus } = require('../domain/jobStatus');
const JobOrder = require('../models/JobOrder');
const { applyOrderStatus } = require('../domain/orderStatus');
const { stampFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { releaseAllReservations } = require('./orderReservations');
const { recomputePending } = require('./orderPending');

/**
 * A job was raised on `order`. The order is running from now on — a
 * no-op when it already is, and refused for anything terminal: raising a
 * job must not be a way to reopen a finished order. Its timeline mirrors
 * the job, with any earmarked lots the replan trimmed or released.
 *
 * Changes `order` in memory; the caller saves it with its other changes.
 */
function jobRaised(order, { job, jobFp, actor, userId, elasticCount, earmarkChanges = { trimmed: [], dropped: [] } }) {
  applyOrderStatus(order, 'InProgress', userId);
  stampFingerprint(order, ACTION_CODES.JOB_CREATED, {
    actor,
    meta: {
      jobId:          job._id.toString(),
      jobOrderNo:     job.jobOrderNo,
      elasticCount,
      relatedHash:    jobFp.hash,
      relatedShortId: jobFp.shortId,
      // Only when there is something to say. A replan that shrank a
      // requirement below what was already promised cuts the surplus,
      // and yarn ceasing to be spoken for without anybody asking is
      // exactly the kind of thing a timeline exists to record.
      ...(earmarkChanges.trimmed.length ? { lotsTrimmed: earmarkChanges.trimmed } : {}),
      ...(earmarkChanges.dropped.length ? { lotsReleased: earmarkChanges.dropped } : {}),
    },
  });
}

/**
 * The last live job on its order has finished: complete the order, and
 * give back the stock it still has reserved.
 *
 * The release used to be missing here while POST /order/complete did it,
 * so an order finished by its last job kept holding Elastic.reservedStock
 * forever, and Completed is terminal, so nothing could recover it.
 *
 * Runs inside the caller's transaction (`session`): the release, the
 * order's status and the job's own status have to land together, or the
 * same units could be handed out twice. A cancelled or deleted order is
 * not completed by its jobs finishing. Returns whether the order closed,
 * so the caller saves the job in the same transaction only then.
 */
async function lastJobCompleted(session, job, { actor, userId, completionFp }) {
  const order = await Order.findById(job.order).session(session);
  if (!order || !applyOrderStatus(order, 'Completed', userId)) return false;

  const releasedRes = await releaseAllReservations(session, order, actor, 'order completed by its last job');
  stampFingerprint(order, ACTION_CODES.ORDER_COMPLETED, {
    actor,
    meta: {
      previousStatus:       'InProgress',
      newStatus:            'Completed',
      triggeredByJob:       job._id.toString(),
      triggerJobNo:         job.jobOrderNo,
      releasedReservations: releasedRes.length,
      relatedHash:          completionFp.hash,
      relatedShortId:       completionFp.shortId,
    },
  });
  await order.save({ session });
  return true;
}

/**
 * A job on the order was cancelled (and already saved as cancelled). Its
 * planned quantity returns to pending, and when nothing live is left the
 * running order goes back to waiting. Only from InProgress: a completed
 * or cancelled order stays where it is.
 */
async function jobCancelled(job, { userId }) {
  const order = await Order.findById(job.order);
  if (!order) return null;
  await recomputePending(order);
  const remainingJobs = await JobOrder.countDocuments({
    order: job.order, _id: { $ne: job._id }, status: liveJobStatus(),
  });
  if (remainingJobs === 0) applyOrderStatus(order, 'Approved', userId);
  await order.save();
  return order;
}

module.exports = { jobRaised, lastJobCompleted, jobCancelled };

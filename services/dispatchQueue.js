'use strict';
// ══════════════════════════════════════════════════════════════════
//  PUTTING THINGS ON THE DISPATCH QUEUE, AND TAKING THEM OFF
//
//  A job joins when it reaches packing — early enough for marketing to
//  say when the customer needs it before the goods are ready. A sample
//  request joins when it is completed. Each joins once: reaching the
//  stage again revives the same entry rather than adding a second.
//
//  Called inside the job's own transaction (pass `session`), so a status
//  change that fails leaves no queue entry behind, and one that succeeds
//  always has one.
// ══════════════════════════════════════════════════════════════════

const DispatchItem = require('../models/DispatchItem');
const { OPEN_STATUSES } = require('../models/DispatchItem');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Elastic = require('../models/Elastic');

const who = (actor) => ({ by: actor?.by ?? null, byName: actor?.byName ?? '' });

/** A cancelled entry back to waiting for an urgency; anything else left alone. */
async function revive(item, actor, session) {
  if (item.status !== 'cancelled') return item;
  item.status = 'awaiting_urgency';
  item.urgency = null;
  item.dueAt = null;
  item.urgencySetBy = null;
  item.urgencySetByName = '';
  item.urgencySetAt = null;
  item.cancelReason = '';
  item.readyAt = new Date();
  item.history.push({ action: 'reopened', ...who(actor), at: new Date() });
  await item.save({ session });
  return item;
}

/** A job has reached the dispatch stage. */
async function enqueueJob(job, { session = null, actor = null } = {}) {
  const existing = await DispatchItem.findOne({ job: job._id }).session(session);
  if (existing) return revive(existing, actor, session);

  const elasticIds = (job.elastics || []).map((e) => e.elastic).filter(Boolean);
  // One after another: a transaction's session takes one operation at a
  // time (tests/architecture/noParallelSessionOps.test.js).
  const customer = job.customer ? await Customer.findById(job.customer).select('name').session(session).lean() : null;
  const order = job.order ? await Order.findById(job.order).select('orderNo').session(session).lean() : null;
  const elastics = elasticIds.length
    ? await Elastic.find({ _id: { $in: elasticIds } }).select('name').session(session).lean()
    : [];
  const names = elastics.map((e) => e.name);

  const [item] = await DispatchItem.create([{
    kind: 'job',
    job: job._id,
    order: job.order,
    customer: job.customer,
    customerName: customer?.name || '',
    ref: job.jobOrderNo != null ? `J-${job.jobOrderNo}` : 'Job',
    title: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', '),
    quantity: (job.elastics || []).reduce((s, e) => s + (Number(e.quantity) || 0), 0),
    orderNo: order?.orderNo ?? null,
    history: [{ action: 'created', note: 'Reached packing', ...who(actor), at: new Date() }],
  }], { session });
  return item;
}

/** A sample request has been completed and is to be sent. */
async function enqueueSample(sample, { actor = null } = {}) {
  const existing = await DispatchItem.findOne({ sample: sample._id });
  if (existing) return revive(existing, actor, null);
  return DispatchItem.create({
    kind: 'sample',
    sample: sample._id,
    customer: sample.customer || undefined,
    customerName: sample.customerName || '',
    ref: `Sample #${sample.sampleNo}`,
    title: sample.title || '',
    quantity: Number(sample.quantity) || 0,
    history: [{ action: 'created', note: 'Sample completed', ...who(actor), at: new Date() }],
  });
}

/** Off the queue, unless it has already gone. */
async function cancelOpen(filter, reason, { session = null, actor = null } = {}) {
  return DispatchItem.updateOne(
    { ...filter, status: { $in: OPEN_STATUSES } },
    {
      $set: { status: 'cancelled', cancelReason: reason },
      $push: { history: { action: 'cancelled', note: reason, ...who(actor), at: new Date() } },
    },
    { session }
  );
}

const cancelForJob = (jobId, reason, opts) => cancelOpen({ job: jobId }, reason, opts);
const cancelForSample = (sampleId, reason, opts) => cancelOpen({ sample: sampleId }, reason, opts);

module.exports = { enqueueJob, enqueueSample, cancelForJob, cancelForSample };

'use strict';
//
// ORDER STATUS REPORT — the data behind the sheet.
//
// One order, answered end to end: what was ordered, what each job has
// reached, what has actually been produced and packed, and what is still
// owed against the supply date.
//
// Kept separate from the renderer so the JSON endpoint and the PDF are
// fed by the same computation — a report whose screen and paper versions
// can disagree is worse than having only one of them.

const mongoose = require('mongoose');
const Order = require('../models/Order');
const JobOrder = require('../models/JobOrder');
const Elastic = require('../models/Elastic');

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';

const num = (n) => Number(n) || 0;

/** Quantity for one elastic id out of an [{elastic, quantity}] array. */
const qtyFor = (rows, id) =>
  num((rows || []).find((r) => r?.elastic && String(r.elastic) === id)?.quantity);

/**
 * Whole days from today to `date`. Negative means overdue.
 * Both sides are floored to midnight, so "due today" is 0 rather than a
 * fraction that rounds the wrong way depending on the hour it is run.
 */
function daysUntil(date) {
  if (!date) return null;
  const midnight = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const diff = midnight(date) - midnight(new Date());
  return Math.round(diff / 86_400_000);
}

async function buildOrderStatusReport(orderId) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) return null;

  const order = await Order.findById(orderId)
    .populate('customer', 'name gstin address phoneNumber')
    .lean();
  if (!order) return null;

  // Jobs are read directly rather than through order.jobs[].job, so a job
  // whose back-reference was never written still appears. The order is
  // the thing being reported on; a job it does not know about is exactly
  // the kind of gap this report should surface, not hide.
  const jobs = await JobOrder.find({ order: order._id })
    .populate('machine', 'ID')
    .populate('warping', 'status completedDate')
    .populate('covering', 'status completedDate')
    .populate('elastics.elastic', 'name')
    .populate('producedElastic.elastic', 'name')
    .populate('packedElastic.elastic', 'name')
    .populate('shiftDetails', 'date shift productionMeters status')
    .sort({ jobOrderNo: 1 })
    .lean();

  // Names for every elastic the order touches. Resolved from a lookup
  // rather than populate: an elastic deleted since the order was placed
  // would come back null and take its ordered quantity with it.
  const elasticIds = [
    ...(order.elasticOrdered || []),
    ...(order.producedElastic || []),
    ...(order.packedElastic || []),
    ...(order.pendingElastic || []),
  ]
    .map((r) => r?.elastic)
    .filter(Boolean);
  const names = new Map(
    (await Elastic.find({ _id: { $in: elasticIds } }).select('name').lean())
      .map((e) => [String(e._id), e.name])
  );

  // ── Order lines ───────────────────────────────────────────────────
  const lines = (order.elasticOrdered || []).map((row) => {
    const id = String(row.elastic ?? '');
    const ordered = num(row.quantity);
    const produced = qtyFor(order.producedElastic, id);
    const packed = qtyFor(order.packedElastic, id);
    // `pendingElastic` is the authority — it is recomputed from the live
    // jobs on every change. Falling back to the ordered quantity is right
    // for an order with no jobs yet: nothing is planned, so all of it is
    // still pending.
    const pendingRow = (order.pendingElastic || []).find(
      (p) => p?.elastic && String(p.elastic) === id
    );
    const pending = pendingRow ? num(pendingRow.quantity) : ordered;
    return {
      elasticId: id || null,
      name: names.get(id) || 'Unknown elastic',
      ordered,
      produced,
      packed,
      pending,
      // Against what was ordered, so the columns add up on the page.
      packedPct: ordered > 0 ? Math.round((packed / ordered) * 100) : 0,
    };
  });

  const totals = lines.reduce(
    (t, l) => ({
      ordered: t.ordered + l.ordered,
      produced: t.produced + l.produced,
      packed: t.packed + l.packed,
      pending: t.pending + l.pending,
    }),
    { ordered: 0, produced: 0, packed: 0, pending: 0 }
  );
  totals.packedPct = totals.ordered > 0 ? Math.round((totals.packed / totals.ordered) * 100) : 0;

  // ── Job rows ──────────────────────────────────────────────────────
  const jobRows = jobs.map((j) => {
    const planned = (j.elastics || []).reduce((s, e) => s + num(e.quantity), 0);
    const produced = (j.producedElastic || []).reduce((s, e) => s + num(e.quantity), 0);
    const packed = (j.packedElastic || []).reduce((s, e) => s + num(e.quantity), 0);
    const shifts = j.shiftDetails || [];
    return {
      jobId: j._id,
      jobNo: j.jobOrderNo != null ? `J-${j.jobOrderNo}` : '—',
      date: fmtDate(j.date),
      status: j.status || 'preparatory',
      machine: j.machine?.ID || '—',
      elastics: (j.elastics || [])
        .map((e) => e.elastic?.name)
        .filter(Boolean)
        .join(', '),
      planned,
      produced,
      packed,
      warping: j.warping?.status || '—',
      covering: j.covering?.status || '—',
      shiftCount: shifts.length,
      // What the floor actually recorded, which is not the same as the
      // job's produced figure — the gap between them is worth seeing.
      shiftMeters: shifts.reduce((s, d) => s + num(d.productionMeters), 0),
      productionMode: j.productionMode || 'in_house',
      outsourceVendor: j.outsourceVendor || '',
    };
  });

  const jobTotals = jobRows.reduce(
    (t, j) => ({
      planned: t.planned + j.planned,
      produced: t.produced + j.produced,
      packed: t.packed + j.packed,
      shiftMeters: t.shiftMeters + j.shiftMeters,
    }),
    { planned: 0, produced: 0, packed: 0, shiftMeters: 0 }
  );

  // Ordered quantity with no job raised against it at all. Distinct from
  // "pending": pending covers work planned but unfinished, this is work
  // nobody has started to plan.
  const unplanned = Math.max(0, totals.ordered - jobTotals.planned);

  const days = daysUntil(order.supplyDate);
  const open = !['Completed', 'Cancelled'].includes(order.status);

  return {
    orderId: String(order._id),
    orderNo: order.orderNo ?? null,
    customerPo: order.po || '',
    customerName: order.customer?.name || '',
    customerGstin: order.customer?.gstin || '',
    customerAddress: order.customer?.address || '',
    orderDate: fmtDate(order.date),
    supplyDate: fmtDate(order.supplyDate),
    status: order.status || 'Open',
    lines,
    totals,
    jobs: jobRows,
    jobTotals,
    unplanned,
    // Delivery position. Only meaningful while the order is still open —
    // a completed order is not "overdue" because its date has passed.
    daysToSupply: days,
    overdue: open && days != null && days < 0,
    dueSoon: open && days != null && days >= 0 && days <= 7,
  };
}

module.exports = { buildOrderStatusReport, daysUntil };

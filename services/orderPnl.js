'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER-LEVEL P&L
//  File: services/orderPnl.js
//
//  What one order earned and what it cost to make, built from the
//  documents that already exist rather than a second set of numbers
//  someone has to keep in step.
//
//  REVENUE  — the rate agreed on the order's own lines
//             (Order.elasticOrdered[].rate × quantity). The delivery
//             challans' value is reported beside it as "invoiced so
//             far", never instead of it: an order that has not
//             dispatched yet has spent real money and would otherwise
//             read as a pure loss.
//
//  COST     — five lines, each traced to its source document:
//
//    Yarn            MaterialOutward rows for the order and its jobs,
//                    at the price captured when the material was
//                    issued (unitPrice), not today's price. Reversed
//                    rows are excluded — a cancelled draw was handed
//                    back.
//
//    Labour          Every shift run on the order's jobs, charged at
//                    the employee's hourly rate × the SCHEDULED shift
//                    length. The factory pays for the whole shift
//                    whether or not the loom ran, so the idle time
//                    belongs to the job that held the machine.
//                    Shifts still `open` are not charged — nobody has
//                    worked them yet — and are counted in `warnings`.
//
//    Job-work        For outsourced jobs, the vendor's rate × the
//                    meters that actually came back (not what was
//                    sent — the shortfall is not billable work).
//
//    Conversion      Finishing, checking and packing at the CostSettings
//                    ₹/meter rate card, applied to produced meters,
//                    unless the job carries an absolute override.
//
//    Overhead        Power, rent, depreciation at the same ₹/meter
//                    shape. Without it every order reads better than
//                    it is.
//
//  Nothing here writes. The P&L is derived on read, so correcting a
//  rate or a shift immediately corrects the margin, and there is no
//  stored figure to drift away from the documents it came from.
//
//  Every input that is MISSING is reported in `warnings` rather than
//  silently costed at zero — a confident ₹0 is how a P&L lies.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const Order            = require('../models/Order');
const JobOrder         = require('../models/JobOrder');
const ShiftDetail      = require('../models/ShiftDetail');
const MaterialOutward  = require('../models/MaterialOut.cjs');
const DeliveryChallan  = require('../models/DeliveryChallan');
const CostSettings     = require('../models/CostSettings');
const { shiftHours }   = require('../utils/shiftHours');

// `Math.round((Number(n) || 0) * 100) / 100` laundered a broken number
// into a plausible one: `NaN || 0` is 0, so an overflowed order reported
// a confident margin of exactly 0% instead of an obvious fault. r2 now
// returns null rather than inventing a figure — a backstop behind the
// input bounds in utils/money.js, not a substitute for them.
const { round2 } = require('../utils/money');
const r2 = (n) => round2(n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// A shift the factory has not paid for yet. `open` means the row was
// created by the plan and nothing has been submitted against it — the
// roster exists, the work does not.
const UNWORKED_SHIFT_STATUSES = new Set(['open']);

/** The singleton rate card, with defaults when it has never been saved. */
async function getCostSettings() {
  const doc = await CostSettings.findOne({ key: 'cost' }).lean();
  return {
    finishingRatePerMeter: num(doc?.finishingRatePerMeter),
    checkingRatePerMeter:  num(doc?.checkingRatePerMeter),
    packingRatePerMeter:   num(doc?.packingRatePerMeter),
    overheadRatePerMeter:  num(doc?.overheadRatePerMeter),
    configured: Boolean(doc),
  };
}

/**
 * Meters this job actually produced.
 *
 * In-house work cascades shift production into `producedElastic`. An
 * outsourced job runs no shifts here, so its output is the quantity the
 * vendor returned — using producedElastic for it would cost the entire
 * back half of the process at zero meters.
 */
function producedMetersFor(job) {
  const woven = (job.producedElastic || []).reduce((s, e) => s + num(e.quantity), 0);
  if (woven > 0) return r2(woven);
  if (job.productionMode === 'outsource') return r2(num(job.outsourcing?.qtyReceivedMeters));
  return 0;
}

/** override ?? (rate × meters) — null is "no override", 0 is an override of zero. */
function conversionLine(override, rate, meters) {
  if (override !== null && override !== undefined) {
    return { amount: r2(override), basis: 'override' };
  }
  return { amount: r2(num(rate) * meters), basis: 'rate' };
}

/**
 * Build the P&L for one order.
 *
 * @param {string|ObjectId} orderId
 * @returns {Promise<object|null>} null when the order does not exist
 */
async function orderPnl(orderId) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) return null;

  const order = await Order.findById(orderId)
    .populate('customer', 'name')
    .populate('elasticOrdered.elastic', 'name')
    .lean();
  if (!order) return null;

  const settings = await getCostSettings();
  const warnings = [];

  // ── Revenue ──────────────────────────────────────────────────
  const lines = (order.elasticOrdered || []).map((l) => {
    const quantity = num(l.quantity);
    const rate     = num(l.rate);
    return {
      elasticId: l.elastic?._id ? String(l.elastic._id) : String(l.elastic || ''),
      name:      l.elastic?.name || 'Unnamed elastic',
      quantity,
      rate,
      amount:    r2(quantity * rate),
    };
  });
  const orderValue = r2(lines.reduce((s, l) => s + l.amount, 0));

  const unpriced = lines.filter((l) => l.quantity > 0 && l.rate <= 0);
  if (unpriced.length > 0) {
    warnings.push(
      `No selling rate on ${unpriced.length} of ${lines.length} order line(s) ` +
      `(${unpriced.map((l) => l.name).join(', ')}) — revenue is understated.`
    );
  }

  // Invoiced-so-far, from the challans. Reported beside the order
  // value, not as a substitute for it.
  const challans = await DeliveryChallan.find({
    order:  order._id,
    status: { $ne: 'cancelled' },
  }).select('dcNumber dispatchDate status totalQuantity totalAmount').lean();

  const invoiced = {
    amount:   r2(challans.reduce((s, d) => s + num(d.totalAmount), 0)),
    quantity: r2(challans.reduce((s, d) => s + num(d.totalQuantity), 0)),
    challans: challans.length,
  };

  // ── Jobs ─────────────────────────────────────────────────────
  const jobs = await JobOrder.find({ order: order._id })
    .select(
      'jobOrderNo status date productionMode outsourceVendor producedElastic ' +
      'outsourcing costOverrides'
    )
    .sort({ jobOrderNo: 1 })
    .lean();
  const jobIds = jobs.map((j) => j._id);

  // ── Labour, per job ──────────────────────────────────────────
  // One query for every shift across the order's jobs; grouped in
  // memory rather than one query per job.
  const shifts = jobIds.length
    ? await ShiftDetail.find({ job: { $in: jobIds } })
        .select('job shift status employee date')
        .populate('employee', 'name hourlyRate')
        .lean()
    : [];

  const labourByJob = new Map();   // jobId → { cost, shifts, hours, unworked, unrated }
  for (const s of shifts) {
    const key = String(s.job);
    const acc = labourByJob.get(key) ||
      { cost: 0, shifts: 0, hours: 0, unworked: 0, unrated: 0 };

    if (UNWORKED_SHIFT_STATUSES.has(s.status)) {
      acc.unworked += 1;
      labourByJob.set(key, acc);
      continue;
    }

    const hours = shiftHours(s.shift);
    const rate  = num(s.employee?.hourlyRate);
    if (rate <= 0) acc.unrated += 1;

    acc.shifts += 1;
    acc.hours  += hours;
    acc.cost   += hours * rate;
    labourByJob.set(key, acc);
  }

  const unratedShifts = [...labourByJob.values()].reduce((s, a) => s + a.unrated, 0);
  if (unratedShifts > 0) {
    warnings.push(
      `${unratedShifts} shift(s) were run by employees with no hourly rate set — ` +
      `their labour is costed at ₹0.`
    );
  }
  const openShifts = [...labourByJob.values()].reduce((s, a) => s + a.unworked, 0);
  if (openShifts > 0) {
    warnings.push(`${openShifts} shift(s) are still open and not yet costed.`);
  }

  // ── Yarn issued ──────────────────────────────────────────────
  // Both shapes: drawn against the order at approval, and issued
  // against a job during the run. They are distinct movement types,
  // so summing both double-counts nothing.
  const outward = await MaterialOutward.find({
    $or: [
      { order: order._id },
      ...(jobIds.length ? [{ job: { $in: jobIds } }] : []),
    ],
    type:     { $in: ['ORDER_APPROVAL', 'JOB_CONSUMPTION'] },
    reversed: { $ne: true },
  })
    .select('rawMaterial quantity unitPrice type job outwardDate')
    .populate('rawMaterial', 'name unit')
    .lean();

  const materialLines = outward.map((m) => ({
    name:      m.rawMaterial?.name || 'Unnamed material',
    quantity:  r2(num(m.quantity)),
    unitPrice: r2(num(m.unitPrice)),
    amount:    r2(num(m.quantity) * num(m.unitPrice)),
    type:      m.type,
  }));
  const materialCost = r2(materialLines.reduce((s, m) => s + m.amount, 0));

  // Yarn issued at a zero price is the single biggest way this P&L can
  // flatter an order, so it is called out by name.
  const unpricedMaterial = materialLines.filter((m) => m.quantity > 0 && m.unitPrice <= 0);
  if (unpricedMaterial.length > 0) {
    warnings.push(
      `${unpricedMaterial.length} material issue(s) had no price recorded ` +
      `(${[...new Set(unpricedMaterial.map((m) => m.name))].join(', ')}) — yarn cost is understated.`
    );
  }
  // Material issued against a job that belongs to a DIFFERENT order
  // cannot be attributed here; but material with no order AND no job
  // is invisible to every order, so it is worth knowing it exists.
  if (materialLines.length === 0) {
    warnings.push('No raw material has been issued against this order — yarn cost is ₹0.');
  }

  // ── Per-job cost breakdown ───────────────────────────────────
  let labourCost = 0, jobWorkCost = 0;
  let finishingCost = 0, checkingCost = 0, packingCost = 0, overheadCost = 0;
  let producedMeters = 0;

  const jobRows = jobs.map((job) => {
    const meters = producedMetersFor(job);
    producedMeters += meters;

    const lab = labourByJob.get(String(job._id)) ||
      { cost: 0, shifts: 0, hours: 0, unworked: 0, unrated: 0 };

    // Outsourced job-work: the vendor bills for what came back.
    let work = 0;
    if (job.productionMode === 'outsource') {
      const rate = num(job.outsourcing?.ratePerMeter);
      const recv = num(job.outsourcing?.qtyReceivedMeters);
      work = r2(rate * recv);
      if (recv > 0 && rate <= 0) {
        warnings.push(
          `J-${job.jobOrderNo} is outsourced to ${job.outsourceVendor || 'a vendor'} ` +
          `with no rate per meter — job-work cost is ₹0.`
        );
      }
    }

    const ov  = job.costOverrides || {};
    const fin = conversionLine(ov.finishing, settings.finishingRatePerMeter, meters);
    const chk = conversionLine(ov.checking,  settings.checkingRatePerMeter,  meters);
    const pck = conversionLine(ov.packing,   settings.packingRatePerMeter,   meters);
    const ovh = conversionLine(ov.overhead,  settings.overheadRatePerMeter,  meters);

    labourCost    += lab.cost;
    jobWorkCost   += work;
    finishingCost += fin.amount;
    checkingCost  += chk.amount;
    packingCost   += pck.amount;
    overheadCost  += ovh.amount;

    const total = r2(lab.cost + work + fin.amount + chk.amount + pck.amount + ovh.amount);

    return {
      id:              String(job._id),
      jobOrderNo:      job.jobOrderNo ?? null,
      jobNo:           job.jobOrderNo != null ? `J-${job.jobOrderNo}` : '—',
      status:          job.status,
      productionMode:  job.productionMode || 'in_house',
      outsourceVendor: job.outsourceVendor || '',
      producedMeters:  meters,
      labour: {
        amount: r2(lab.cost), shifts: lab.shifts,
        hours: r2(lab.hours), openShifts: lab.unworked,
      },
      jobWork:   r2(work),
      finishing: fin,
      checking:  chk,
      packing:   pck,
      overhead:  ovh,
      // Yarn is drawn against the ORDER at approval, not the job, so
      // there is no honest per-job split of it — see the order total.
      total,
      costPerMeter: meters > 0 ? r2(total / meters) : null,
    };
  });

  if (jobs.length === 0) {
    warnings.push('This order has no jobs yet — production cost is ₹0.');
  }
  if (producedMeters === 0 && jobs.length > 0) {
    warnings.push(
      'No production recorded against this order, so the ₹/meter rate card ' +
      'charges nothing for finishing, checking, packing or overhead.'
    );
  }
  if (!settings.configured) {
    warnings.push(
      'The conversion rate card has never been set, so finishing, checking, ' +
      'packing and overhead are all ₹0. Set it at the top of the Order P&L page.'
    );
  }

  const costs = {
    material:  materialCost,
    labour:    r2(labourCost),
    jobWork:   r2(jobWorkCost),
    finishing: r2(finishingCost),
    checking:  r2(checkingCost),
    packing:   r2(packingCost),
    overhead:  r2(overheadCost),
  };
  costs.total = r2(
    costs.material + costs.labour + costs.jobWork +
    costs.finishing + costs.checking + costs.packing + costs.overhead
  );

  const profit = r2(orderValue - costs.total);

  return {
    order: {
      id:         String(order._id),
      orderNo:    order.orderNo ?? null,
      po:         order.po || '',
      status:     order.status,
      date:       order.date || null,
      supplyDate: order.supplyDate || null,
      customerName: order.customer?.name || '',
    },
    revenue: { lines, orderValue, invoiced },
    costs,
    jobs: jobRows,
    totals: {
      producedMeters: r2(producedMeters),
      orderedQuantity: r2(lines.reduce((s, l) => s + l.quantity, 0)),
      profit,
      // A margin on zero revenue is not 0% or -100%, it is unknown —
      // and an unpriced order showing "-100% margin" in a list is how
      // a real loss gets lost among the noise.
      // Not finite → UNKNOWN, which is the same answer an unpriced
      // order gets. Reporting 0% for a corrupted order is worse than
      // reporting nothing, because 0% looks like a figure.
      marginPct:      orderValue > 0 && Number.isFinite(orderValue) && Number.isFinite(profit)
        ? r2((profit / orderValue) * 100)
        : null,
      costPerMeter:   producedMeters > 0 ? r2(costs.total / producedMeters) : null,
      revenuePerMeter: producedMeters > 0 ? r2(orderValue / producedMeters) : null,
    },
    rateCard: {
      finishingRatePerMeter: settings.finishingRatePerMeter,
      checkingRatePerMeter:  settings.checkingRatePerMeter,
      packingRatePerMeter:   settings.packingRatePerMeter,
      overheadRatePerMeter:  settings.overheadRatePerMeter,
      configured:            settings.configured,
    },
    materialLines,
    warnings,
  };
}

module.exports = { orderPnl, getCostSettings, producedMetersFor, conversionLine };

'use strict';

// ══════════════════════════════════════════════════════════════════
//  RAISING A JOB ON AN ORDER
//
//  The rules for POST /job/create, moved out of the route handler
//  unchanged: which orders can take a job, how far a line may be planned
//  over what was ordered (and when that needs a reason), drawing the
//  yarn the excess needs (refusing, or putting it back, when it isn't
//  there), creating the job with its warping and covering programmes,
//  and recording all of it on the job's and the order's timelines.
//
//  The route parses the request and shapes the response; everything in
//  between is here, so the same rules can be called and tested without
//  HTTP. Refusals are thrown as ErrorHandler with the same status, code
//  and details the route used to return.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const Order = require('../models/Order');
const JobOrder = require('../models/JobOrder');
const Warping = require('../models/Warping');
const Covering = require('../models/Covering');
const Elastic = require('../models/Elastic');
const RawMaterial = require('../models/RawMaterial');
const MaterialOutward = require('../models/MaterialOut.cjs');
const { recomputePending } = require('./orderPending.js');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { carryEarmarksForward } = require('./lotAllocation');
const { appendStockMovement } = require('../utils/stockLedger');
const { costOf } = require('../utils/materialValuation');
const {
  FREE_EXCESS_PCT, assessLines, plannedFromJobs, excessMaterialRequirement,
  stockShortfalls, linesNeedingReason, reasonIsUsable, describeLine,
} = require('./excessPlanning');
const orderLifecycle = require('./orderLifecycle');

/** As a forced order approval asks for. */
const MIN_FORCE_REASON = 8;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * @param {object} body           { orderId, date, elastics: [{ elastic, quantity }], excessReason?,
 *                                  force?, forceReason? }
 *   force + forceReason: create the job though the excess yarn is short —
 *   what is in stock is drawn, the rest is recorded as short, as a forced
 *   order approval does. For stock that was never entered, mostly.
 * @param {object} ctx
 * @param {object} ctx.actor       who is raising it (utils/fingerprint actor)
 * @param {*}      ctx.userId      their user id, for the order's records
 * @returns {Promise<{ job, warping, covering, jobFp }>}
 */
async function raiseJob(body, ctx) {
    const { orderId, date, elastics } = body;
    if (!orderId) throw new ErrorHandler('orderId is required', 400);
    if (!date)    throw new ErrorHandler('date is required', 400);
    if (!Array.isArray(elastics) || elastics.length === 0)
      throw new ErrorHandler('elastics array must not be empty', 400);

    for (const e of elastics) {
      if (!e.elastic) throw new ErrorHandler('Each elastic entry must have an elastic ID', 400);
      if (typeof e.quantity !== 'number' || e.quantity <= 0)
        throw new ErrorHandler('Each elastic quantity must be a positive number', 400);
    }

    // ── One transaction, start to finish ────────────────────────────
    // The yarn draw, the job, its warping and covering programmes, the
    // ledger rows and the order all commit together or not at all. This
    // used to be a run of separate writes with hand-written refunds,
    // which a crash between them could not run: yarn left stock with no
    // job to explain it.
    //
    // It also closes a race. Two jobs raised on the same order at once
    // each read the jobs already planned, and both passed the excess
    // check that, together, they broke. Both now write the order, so the
    // second hits a write conflict, is retried from the top, sees the
    // first job, and is judged against it. The callback re-reads
    // everything, so a retry starts from the database, never from what
    // the failed attempt left in memory.
    const session = await mongoose.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        out = await raiseJobIn(session, body, ctx);
      });
      return out;
    } finally {
      await session.endSession();
    }
}

async function raiseJobIn(session, body, { actor, userId }) {
    const { orderId, date, elastics } = body;
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new ErrorHandler('Order not found', 404);
    // Approved or InProgress, not Open.
    //
    // This read `['Open', 'InProgress']`, which was backwards in both
    // directions. An APPROVED order — the one the UI offers "Create
    // job" on — was refused outright, so the normal path answered
    // "Cannot create job for order with status Approved". And an OPEN
    // one was accepted and pushed to InProgress below, skipping the
    // approval that debits raw material and runs the stock guard: an
    // order could reach the floor having consumed material nobody
    // deducted, simply by raising a job on it.
    if (!['Approved', 'InProgress'].includes(order.status)) {
      throw new ErrorHandler(
        order.status === 'Open'
          ? 'Approve the order before raising a job — approval is where raw material is deducted.'
          : `Cannot create job for order with status "${order.status}"`,
        400
      );
    }

    // ── Excess planning ─────────────────────────────────────────
    // A line may be planned up to 120% of what was ORDERED with no
    // comment; past that only with a reason. This replaced a flat
    // "requested must not exceed pending", which refused the ordinary
    // case of setting a loom for a round number of meters.
    const siblings = await JobOrder.find({
      order: order._id, status: { $ne: 'cancelled' },
    }).select('elastics').session(session).lean();

    const rows = assessLines(elastics, order, plannedFromJobs(siblings));

    const offOrder = rows.find((r) => !r.onOrder);
    if (offOrder) {
      throw new ErrorHandler(`Elastic ${offOrder.elastic} is not part of this order`, 400);
    }

    // Name the elastics in the messages — an id tells the planner nothing.
    const elasticDocs = await Elastic.find({ _id: { $in: rows.map((r) => r.elastic) } })
      .select('name').lean();
    const nameOf = (id) =>
      elasticDocs.find((d) => String(d._id) === String(id))?.name || 'Unnamed elastic';

    const excessRows = rows.filter((r) => r.excess > 0);
    const overAllowance = linesNeedingReason(rows);
    const excessReason = typeof body.excessReason === 'string' ? body.excessReason.trim() : '';

    if (overAllowance.length > 0 && !reasonIsUsable(excessReason)) {
      const err = new ErrorHandler(
        `Planning more than ${FREE_EXCESS_PCT}% over the ordered quantity needs a reason — `
        + overAllowance.map((r) => describeLine(r, nameOf)).join('; '),
        409
      );
      err.code = 'EXCESS_PLANNING_REASON_REQUIRED';
      err.details = {
        freeExcessPct: FREE_EXCESS_PCT,
        lines: overAllowance.map((r) => ({ ...r, name: nameOf(r.elastic) })),
      };
      throw err;
    }

    // ── The material the excess needs ───────────────────────────
    // Approval drew yarn for the ORDERED quantity and no more, so every
    // excess meter is yarn nobody has deducted. Compute it, refuse if
    // the stock is not there, and draw it below.
    let excessRequirement = [];
    let shortfalls = [];
    const priceById = new Map();
    if (excessRows.length > 0) {
      excessRequirement = await excessMaterialRequirement(rows);
      const materials = await RawMaterial.find({
        _id: { $in: excessRequirement.map((r) => r.rawMaterial) },
      }).select('name stock price avgCost').session(session).lean();
      const stockById = new Map(materials.map((m) => [String(m._id), m.stock]));
      // Price the draw from the same read. Writing the row at 0 and
      // correcting it afterwards leaves a window where the P&L values
      // this yarn at nothing.
      //
      // costOf, not `price`: the weighted average of what the stock
      // cost, falling back to the latest purchase price for material
      // that has not been received since averaging existed.
      for (const m of materials) priceById.set(String(m._id), costOf(m));

      shortfalls = stockShortfalls(excessRequirement, stockById);
      if (shortfalls.length > 0 && body.force !== true) {
        const err = new ErrorHandler(
          'Not enough raw material for the excess quantity — '
          + shortfalls.map((s) => `${s.name} short by ${s.short} kg`).join('; ')
          + '. Create it anyway with a reason to draw what is in stock.',
          409
        );
        err.code = 'INSUFFICIENT_STOCK_FOR_EXCESS';
        err.details = { shortfalls, requirement: excessRequirement };
        throw err;
      }
    }

    // ── Forcing through a shortfall ─────────────────────────────
    // Only when something is actually short, and only with a reason —
    // the same rule as a forced order approval. Stock is often short on
    // paper because it was never entered, not because the rack is empty.
    const forced = body.force === true && shortfalls.length > 0;
    const forceReason = typeof body.forceReason === 'string' ? body.forceReason.trim() : '';
    if (forced && forceReason.length < MIN_FORCE_REASON) {
      throw new ErrorHandler(
        `forceReason must be at least ${MIN_FORCE_REASON} characters when creating a job through a shortfall`,
        400
      );
    }

    // Deduct before the job exists, so a job can never reach the floor
    // on yarn that was not there. Each deduction is a conditional update,
    // `stock: { $gte: qty }`, inside the transaction: a shortfall throws
    // and the whole raise rolls back, draws already made included.
    //
    // Forced, a short material gives what it has and is left at 0 — the
    // draw records both what was wanted and what left, so the gap is on
    // the ledger rather than inferred from a balance. The filter on the
    // stock as read keeps that exact inside the transaction.
    const drawn = [];
    if (excessRequirement.length > 0) {
      for (const r of excessRequirement) {
        const qty = Number(r.requiredWeight) || 0;
        if (qty <= 0) continue;
        let updated;
        let applied = qty;
        if (forced) {
          const current = await RawMaterial.findById(r.rawMaterial).select('stock name').session(session).lean();
          if (!current) throw new ErrorHandler(`Raw material ${r.name || r.rawMaterial} not found`, 404);
          const have = Math.max(0, Number(current.stock) || 0);
          applied = r3(Math.min(qty, have));
          updated = await RawMaterial.findOneAndUpdate(
            { _id: r.rawMaterial, stock: current.stock },
            { $set: { stock: r3(Math.max(0, have - qty)) }, $inc: { totalConsumption: applied } },
            { new: true, session }
          );
        } else {
          updated = await RawMaterial.findOneAndUpdate(
            { _id: r.rawMaterial, stock: { $gte: qty } },
            { $inc: { stock: -qty, totalConsumption: qty } },
            { new: true, session }
          );
        }
        if (!updated) {
          const err = new ErrorHandler(
            `Raw material ran out while raising this job (${r.name || 'material'}) — nothing was deducted. Try again.`,
            409
          );
          err.code = 'INSUFFICIENT_STOCK_FOR_EXCESS';
          throw err;
        }
        drawn.push({
          rawMaterial: r.rawMaterial,
          name: r.name || updated.name || '',
          quantity: applied,
          requested: qty,
          balance: updated.stock,
        });
      }
    }

    const zeroed = elastics.map(e => ({ elastic: e.elastic, quantity: 0 }));

    const [job] = await JobOrder.create([{
      date: new Date(date), order: order._id, customer: order.customer,
      status: 'preparatory', elastics,
      producedElastic: zeroed, packedElastic: zeroed, wastageElastic: zeroed,
    }], { session });

    // ── Book the excess draw ────────────────────────────────────
    // The stock is already down (above); these are the records that
    // explain where it went. JOB_CONSUMPTION, not ORDER_APPROVAL: it
    // belongs to this job, and the order P&L already counts that type,
    // so excess yarn lands on the order's cost without further wiring.
    //
    // Immediately after the job exists, and before anything else. This
    // ran at the end of the route, so a failure creating the warping
    // programme — or saving the order — left stock drawn with no
    // outward row, no ledger row and no refund: yarn gone from the
    // system with nothing anywhere to say where. Everything below this
    // point can now fail without the stock figure lying.
    // A material that had nothing to give leaves no outward row (there
    // is no quantity to record), but still has its ledger line saying
    // what was asked of it.
    if (drawn.length > 0) {
      const withQty = drawn.filter((d) => d.quantity > 0);
      if (withQty.length) {
        await MaterialOutward.create(withQty.map((d) => ({
          rawMaterial: d.rawMaterial,
          quantity:    d.quantity,
          job:         job._id,
          type:        'JOB_CONSUMPTION',
          outwardDate: new Date(),
          unitPrice:   priceById.get(String(d.rawMaterial)) ?? 0,
          remarks:     `Excess planning on J-${job.jobOrderNo} (order #${order.orderNo})`
            + (d.quantity < d.requested ? ` (forced — requested ${d.requested}, short ${r3(d.requested - d.quantity)})` : ''),
        })), { session, ordered: true });
      }
      for (const d of drawn) {
        await appendStockMovement(d.rawMaterial, {
          type: 'JOB_CONSUMPTION',
          refNo: job.jobOrderNo != null ? String(job.jobOrderNo) : '',
          quantity: d.quantity > 0 ? -d.quantity : 0, // never -0 on the ledger
          ...(d.quantity !== d.requested ? { requested: -d.requested } : {}),
          balance: d.balance,
          unitCost: priceById.get(String(d.rawMaterial)) ?? 0,
        }, session);
      }
    }

    // One after the other: a session runs one operation at a time.
    const [warping] = await Warping.create([{ date: new Date(), job: job._id, elasticOrdered: elastics }], { session });
    const [covering] = await Covering.create([{ date: new Date(), job: job._id, elasticPlanned: elastics }], { session });

    job.warping  = warping._id;
    job.covering = covering._id;

    // 🪪 Fingerprint: JOB_CREATED on the job itself
    const jobFp = buildFingerprint(ACTION_CODES.JOB_CREATED, {
      entityId: job._id,
      actor,
      meta: {
        orderId:       order._id.toString(),
        orderNo:       order.orderNo,
        jobOrderNo:    job.jobOrderNo,
        elasticCount:  elastics.length,
        totalQuantity: elastics.reduce((s, e) => s + (e.quantity || 0), 0),
        excessLines:   excessRows.length,
        excessQuantity: excessRows.reduce((s, r) => s + r.excess, 0),
        excessReason:  excessReason || undefined,
        excessMaterialDrawn: drawn.map((d) => `${d.name} ${d.quantity}`),
        ...(forced ? { forced: true, forceReason, shortfalls } : {}),
      },
    });
    job.fingerprints.push(jobFp);
    await job.save({ session });

    // ── Record the excess on the order ──────────────────────────
    // Appended, never replaced: two jobs can each over-plan the same
    // elastic and both are worth seeing on the order detail page.
    for (const r of excessRows) {
      const forThisLine = r.needsReason ? excessReason : '';
      order.excessPlanning.push({
        elastic:         r.elastic,
        elasticName:     nameOf(r.elastic),
        job:             job._id,
        jobOrderNo:      job.jobOrderNo,
        orderedQuantity: r.ordered,
        plannedQuantity: r.totalPlanned,
        excessQuantity:  r.excess,
        excessPct:       Number.isFinite(r.excessPct) ? r.excessPct : 0,
        reason:          forThisLine,
        // The whole draw is attributed to the job, not split per line —
        // the requirement was computed from all the excess lines at once
        // and there is no honest way to divide a shared material back out.
        materialsDrawn:  drawn.map((d) => ({
          rawMaterial: d.rawMaterial, name: d.name, quantity: d.quantity,
          ...(d.quantity !== d.requested ? { requested: d.requested } : {}),
        })),
        forced,
        forceReason:     forced ? forceReason : '',
        recordedBy:      userId || null,
        recordedAt:      new Date(),
      });
    }

    order.jobs.push({ job: job._id, no: job.jobOrderNo });
    // Pending = ordered − planned, recomputed from the order's live jobs
    // (now including the one just created) rather than decremented in
    // place, so every path agrees and a re-run can't double-count.
    await recomputePending(order, session);

    // "Recalculate materials required": the order's requirement was
    // computed for the ordered quantity. Now that more is being made,
    // it is restated for what is actually PLANNED, so the requirement
    // sheet and the yarn that left stock tell the same story.
    let earmarkChanges = { trimmed: [], dropped: [] };
    if (excessRows.length > 0) {
      const plannedLines = (order.elasticOrdered || []).map((l) => {
        const row = rows.find((r) => r.elastic === String(l.elastic));
        return {
          elastic: l.elastic,
          quantity: row ? Math.max(row.ordered, row.totalPlanned) : Number(l.quantity) || 0,
        };
      });
      // Carried, not assigned. computeMaterialRequirement returns rows
      // with no `lots` field, so assigning its result straight onto the
      // order threw away every dye lot the order had set aside — with
      // nothing failing and nothing logged. See carryEarmarksForward.
      const recomputed = await computeMaterialRequirement(plannedLines);
      const carried = carryEarmarksForward(order.rawMaterialRequired, recomputed);
      order.rawMaterialRequired = carried.rows;
      order.updatedItemsAt = new Date();
      earmarkChanges = carried;
    }
    // The order starts running and its timeline mirrors the job
    // (services/orderLifecycle.js). Saved here with the changes above.
    orderLifecycle.jobRaised(order, {
      job, jobFp, actor, userId: userId, elasticCount: elastics.length, earmarkChanges,
    });
    await order.save({ session });

    return { job, warping, covering, jobFp };
}

module.exports = { raiseJob, MIN_FORCE_REASON };

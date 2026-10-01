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

/**
 * @param {object} body           { orderId, date, elastics: [{ elastic, quantity }], excessReason? }
 * @param {object} ctx
 * @param {object} ctx.actor       who is raising it (utils/fingerprint actor)
 * @param {*}      ctx.userId      their user id, for the order's records
 * @returns {Promise<{ job, warping, covering, jobFp }>}
 */
async function raiseJob(body, { actor, userId }) {
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

    const order = await Order.findById(orderId);
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
    }).select('elastics').lean();

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
    const priceById = new Map();
    if (excessRows.length > 0) {
      excessRequirement = await excessMaterialRequirement(rows);
      const materials = await RawMaterial.find({
        _id: { $in: excessRequirement.map((r) => r.rawMaterial) },
      }).select('name stock price avgCost').lean();
      const stockById = new Map(materials.map((m) => [String(m._id), m.stock]));
      // Price the draw from the same read. Writing the row at 0 and
      // correcting it afterwards leaves a window where the P&L values
      // this yarn at nothing.
      //
      // costOf, not `price`: the weighted average of what the stock
      // cost, falling back to the latest purchase price for material
      // that has not been received since averaging existed.
      for (const m of materials) priceById.set(String(m._id), costOf(m));

      const shortfalls = stockShortfalls(excessRequirement, stockById);
      if (shortfalls.length > 0) {
        const err = new ErrorHandler(
          'Not enough raw material for the excess quantity — '
          + shortfalls.map((s) => `${s.name} short by ${s.short} kg`).join('; '),
          409
        );
        err.code = 'INSUFFICIENT_STOCK_FOR_EXCESS';
        err.details = { shortfalls, requirement: excessRequirement };
        throw err;
      }
    }

    // Deduct BEFORE the job exists, so a job can never reach the floor
    // on yarn that was not there. Each deduction is a single atomic
    // conditional update — `stock: { $gte: qty }` is the real guard
    // against a concurrent draw, not the read above. This route is not
    // transactional (it runs on a standalone mongod in test), so a
    // failure part-way compensates the deductions already applied.
    const drawn = [];

    // Put back everything drawn so far. Used both when a later line
    // finds no stock and when the job itself fails to be created — the
    // yarn must never be left down with nothing to explain it, and a
    // half-applied draw is exactly how a stock figure becomes a number
    // nobody can account for. Best-effort per material: one failed
    // refund must not stop the others, but it does get said out loud,
    // because at that point the figure IS wrong and only a person can
    // put it right.
    const refundDraw = async (rows) => {
      const stranded = [];
      for (const back of rows) {
        try {
          await RawMaterial.updateOne(
            { _id: back.rawMaterial },
            { $inc: { stock: back.quantity, totalConsumption: -back.quantity } }
          );
        } catch (refundErr) {
          stranded.push(`${back.name || back.rawMaterial} ${back.quantity}`);
          console.error(
            `[job/create] could not refund ${back.quantity} of ${back.rawMaterial}:`,
            refundErr.message
          );
        }
      }
      if (stranded.length > 0) {
        console.error(
          `[job/create] STOCK LEFT SHORT with no job to explain it: ${stranded.join('; ')}`
        );
      }
    };

    if (excessRequirement.length > 0) {
      for (const r of excessRequirement) {
        const qty = Number(r.requiredWeight) || 0;
        if (qty <= 0) continue;
        const updated = await RawMaterial.findOneAndUpdate(
          { _id: r.rawMaterial, stock: { $gte: qty } },
          { $inc: { stock: -qty, totalConsumption: qty } },
          { new: true }
        );
        if (!updated) {
          await refundDraw(drawn);
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
          quantity: qty,
          balance: updated.stock,
        });
      }
    }

    const zeroed = elastics.map(e => ({ elastic: e.elastic, quantity: 0 }));

    // The stock is already down. Until the job exists there is nothing
    // to attribute it to, so a failure here has to put it back — the
    // draw loop above compensates itself, but everything from this line
    // on used to be outside that guard, and a job that failed to save
    // took the yarn with it silently.
    let job;
    try {
      job = await JobOrder.create({
        date: new Date(date), order: order._id, customer: order.customer,
        status: 'preparatory', elastics,
        producedElastic: zeroed, packedElastic: zeroed, wastageElastic: zeroed,
      });
    } catch (err) {
      await refundDraw(drawn);
      throw err;
    }

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
    if (drawn.length > 0) {
      await MaterialOutward.create(drawn.map((d) => ({
        rawMaterial: d.rawMaterial,
        quantity:    d.quantity,
        job:         job._id,
        type:        'JOB_CONSUMPTION',
        outwardDate: new Date(),
        unitPrice:   priceById.get(String(d.rawMaterial)) ?? 0,
        remarks:     `Excess planning on J-${job.jobOrderNo} (order #${order.orderNo})`,
      })));
      for (const d of drawn) {
        await appendStockMovement(d.rawMaterial, {
          type: 'JOB_CONSUMPTION',
          refNo: job.jobOrderNo != null ? String(job.jobOrderNo) : '',
          quantity: -d.quantity,
          balance: d.balance,
          unitCost: priceById.get(String(d.rawMaterial)) ?? 0,
        });
      }
    }

    const [warping, covering] = await Promise.all([
      Warping.create({ date: new Date(), job: job._id, elasticOrdered: elastics }),
      Covering.create({ date: new Date(), job: job._id, elasticPlanned: elastics }),
    ]);

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
      },
    });
    job.fingerprints.push(jobFp);
    await job.save();

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
        })),
        recordedBy:      userId || null,
        recordedAt:      new Date(),
      });
    }

    order.jobs.push({ job: job._id, no: job.jobOrderNo });
    // Pending = ordered − planned, recomputed from the order's live jobs
    // (now including the one just created) rather than decremented in
    // place, so every path agrees and a re-run can't double-count.
    await recomputePending(order);

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
    await order.save();

    return { job, warping, covering, jobFp };
}

module.exports = { raiseJob };

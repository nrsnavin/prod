'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHANGING WHAT A RUNNING JOB MAKES — THE EXCEPTIONAL CASE
//
//  A job's lines are set when it is raised, from the order, and that is
//  where they stay: the yarn was drawn for them and the beam was made
//  for them. Sometimes the loom cannot keep to that — the beam comes up
//  short of its metres, say — and the floor has to put another of the
//  order's elastics on, mid-run, rather than stop the job.
//
//  This is that one move, with a reason, and it changes two things:
//
//    • the elastic that is leaving is FROZEN: its line stays on the job,
//      its planned quantity comes down to what was actually woven, so
//      nothing more is produced, packed or counted against it, and the
//      metres it did not reach go back to the order's pending;
//
//    • the elastic that is coming in is ADDED to the job — it must be on
//      the order, and no more of it than the order still has unplanned —
//      and, if asked, put on the loom's heads in place of the frozen
//      one, so production counts for it from the next verified shift.
//
//  With nothing coming in — the beam ran out and the job carries on
//  with its other elastics — the frozen elastic's heads are simply
//  freed. And a job past weaving (finishing, checking) can still be
//  set straight the same way: nothing more is produced on it, but its
//  lines should say what was actually made.
//
//  Nothing is erased. The job's lines are the record of what the loom
//  actually ran; the fingerprint says who changed it and why.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const JobOrder = require('../models/JobOrder');
const Order = require('../models/Order');
const Elastic = require('../models/Elastic');
const Machine = require('../models/Machine');
const ErrorHandler = require('../utils/ErrorHandler');
const { assertVersion } = require('../utils/versioning');
const { stampFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { recomputePending } = require('./orderPending');
const { assessLines, plannedFromJobs } = require('./excessPlanning');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { carryEarmarksForward } = require('./lotAllocation');
const { refreshOpenShiftHeads } = require('../utils/machineHeads');
const { checkHookFit, hookFitError } = require('../utils/machineFit');

/** An exceptional change needs a reason that says something. */
const MIN_REASON = 8;

/** The job stages the lines can be changed in. */
const CHANGEABLE = ['preparatory', 'weaving', 'finishing', 'checking'];

const qtyOf = (rows, id) => rows.find((r) => String(r.elastic) === String(id))?.quantity || 0;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The order's elastics as candidates for this job: what was ordered,
 * what every live job has planned, what is still unplanned, and whether
 * this job already carries it.
 */
async function orderElasticsForJob(jobId) {
  const job = await JobOrder.findById(jobId).select('order elastics status').lean();
  if (!job) throw new ErrorHandler('Job not found', 404);
  const order = await Order.findById(job.order)
    .select('orderNo elasticOrdered').populate('elasticOrdered.elastic', 'name').lean();
  if (!order) throw new ErrorHandler('Order not found for this job', 404);
  const live = await JobOrder.find({ order: order._id, status: { $ne: 'cancelled' } })
    .select('elastics').lean();
  const planned = plannedFromJobs(live);
  const onJob = new Map((job.elastics || []).map((e) => [String(e.elastic), e]));

  return {
    orderNo: order.orderNo,
    elastics: (order.elasticOrdered || []).filter((l) => l?.elastic).map((l) => {
      const id = String(l.elastic._id ?? l.elastic);
      const ordered = Number(l.quantity) || 0;
      const totalPlanned = planned.get(id) ?? 0;
      const mine = onJob.get(id);
      return {
        elasticId: id,
        elasticName: l.elastic.name ?? 'Unknown',
        ordered,
        planned: r3(totalPlanned),
        pending: r3(Math.max(0, ordered - totalPlanned)),
        onJob: !!mine,
        frozen: !!mine?.frozen,
      };
    }),
  };
}

/**
 * @param {object} input
 *   jobId
 *   elastic        the elastic coming in (must be on the order, not on the
 *                  job), or null: nothing comes in, the frozen lines just close
 *   quantity       metres planned for it — at most what the order has unplanned
 *   freeze         ids of this job's lines to freeze at what was woven
 *   heads          'frozen' (default): the new elastic takes the heads the
 *                  frozen elastics were on (freed, when nothing comes in);
 *                  'all': every running head; 'none': leave the head map
 *   confirmHooks   go ahead although the loom has too few hooks for it
 * @param {object} req   for the reason, the version and the fingerprint
 */
async function changeElasticMidRun({ jobId, elastic = null, quantity, freeze = [], heads = 'frozen', confirmHooks = false }, req) {
  if (!mongoose.isValidObjectId(jobId)) throw new ErrorHandler('Job not found', 404);
  const incomingId = elastic ? String(elastic) : null;
  if (incomingId && !mongoose.isValidObjectId(incomingId)) throw new ErrorHandler('Choose the elastic to put on', 400);
  const qty = incomingId ? Number(quantity) : 0;
  if (incomingId && (!Number.isFinite(qty) || qty <= 0)) throw new ErrorHandler('quantity must be a positive number', 400);
  if (!incomingId && !(Array.isArray(freeze) && freeze.length)) {
    throw new ErrorHandler('Choose an elastic to put on, or at least one line to freeze.', 400);
  }
  const reason = String(req.body?.auditReason ?? req.body?.reason ?? '').trim();
  if (reason.length < MIN_REASON) {
    throw new ErrorHandler(`This is an exceptional change: give the reason (at least ${MIN_REASON} characters).`, 400);
  }
  if (!Array.isArray(freeze) || freeze.some((id) => !mongoose.isValidObjectId(id))) {
    throw new ErrorHandler('freeze must list elastic ids', 400);
  }
  if (!['frozen', 'all', 'none'].includes(heads)) throw new ErrorHandler('heads must be frozen, all or none', 400);
  const freezeIds = [...new Set(freeze.map(String))];

  const incoming = incomingId ? await Elastic.findById(incomingId).select('name noOfHook').lean() : null;
  if (incomingId && !incoming) throw new ErrorHandler('Elastic not found', 404);

  let job;
  let order;
  let frozenRows = [];
  let headsChanged = 0;
  let hookNote = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      frozenRows = [];
      headsChanged = 0;
      job = await JobOrder.findById(jobId).session(session);
      if (!job) throw new ErrorHandler('Job not found', 404);
      assertVersion(job, req);
      if (!CHANGEABLE.includes(job.status)) {
        throw new ErrorHandler(`The elastic can be changed until the job reaches packing (it is ${job.status}).`, 400);
      }
      if (incomingId && (job.elastics || []).some((e) => String(e.elastic) === incomingId)) {
        throw new ErrorHandler(`${incoming.name} is already on this job.`, 400);
      }

      order = await Order.findById(job.order).session(session);
      if (!order) throw new ErrorHandler('Order not found for this job', 404);
      const onOrder = !incomingId || (order.elasticOrdered || []).some((l) => String(l.elastic) === incomingId);
      if (!onOrder) {
        throw new ErrorHandler(
          `${incoming.name} is not on order #${order.orderNo}. Only an elastic the customer ordered can be put on mid-run.`, 400
        );
      }

      // ── Freeze what is leaving ──────────────────────────────────
      // Brought down to what was woven — produced is gross, off the loom —
      // so the line is complete as it stands and the rest returns to the
      // order's pending. Never below what was packed.
      const now = new Date();
      for (const id of freezeIds) {
        const line = (job.elastics || []).find((e) => String(e.elastic) === String(id));
        if (!line) throw new ErrorHandler('An elastic to freeze is not on this job.', 400);
        if (line.frozen) continue;
        const woven = Math.max(qtyOf(job.producedElastic, id), qtyOf(job.packedElastic, id));
        frozenRows.push({ elastic: String(id), plannedBefore: line.quantity, frozenAt: r3(woven) });
        line.plannedBeforeFreeze = line.quantity;
        line.quantity = r3(woven);
        line.frozen = true;
        line.frozenAt = now;
        line.frozenReason = reason;
      }

      // ── No more than the order still has unplanned ──────────────
      // Everything live on the order, this job's lines as they now stand
      // (a frozen line has already given its shortfall back).
      const siblings = await JobOrder.find({
        order: order._id, status: { $ne: 'cancelled' }, _id: { $ne: job._id },
      }).select('elastics').session(session).lean();
      const planned = plannedFromJobs([...siblings, { elastics: job.elastics }]);
      const [row] = incomingId ? assessLines([{ elastic: incomingId, quantity: qty }], order, planned) : [null];
      const pending = row ? r3(Math.max(0, row.ordered - row.alreadyPlanned)) : 0;
      if (row && qty > pending) {
        const err = new ErrorHandler(
          pending > 0
            ? `Order #${order.orderNo} has only ${pending} m of ${incoming.name} not yet planned (${row.ordered} ordered, ${r3(row.alreadyPlanned)} on jobs). Plan up to ${pending} m here, or raise a job for the rest.`
            : `Order #${order.orderNo} has none of ${incoming.name} left to plan: all ${row.ordered} m is on jobs already.`,
          409
        );
        err.code = 'JOB_ELASTIC_OVER_ORDER';
        err.details = { ordered: row.ordered, planned: r3(row.alreadyPlanned), pending };
        throw err;
      }

      // ── Add what is coming in, if anything ──────────────────────
      if (incomingId) {
        job.elastics.push({ elastic: incomingId, quantity: qty, addedMidRun: true, addedAt: now, addedReason: reason });
        // A row each, at zero: wastage only adds to a row that exists.
        for (const key of ['producedElastic', 'packedElastic', 'wastageElastic']) {
          if (!job[key].some((e) => String(e.elastic) === incomingId)) job[key].push({ elastic: incomingId, quantity: 0 });
        }
      } else if (!frozenRows.length) {
        throw new ErrorHandler('Nothing to change: the lines named are frozen already.', 400);
      }

      const frozenNames = frozenRows.length
        ? await Elastic.find({ _id: { $in: frozenRows.map((f) => f.elastic) } }).select('name').session(session).lean()
        : [];
      const nameOf = (id) => frozenNames.find((n) => String(n._id) === String(id))?.name ?? null;
      stampFingerprint(job, ACTION_CODES.JOB_ELASTIC_CHANGED, {
        req,
        meta: {
          auditReason: reason,
          jobStage: job.status,
          added: incomingId ? { elastic: incomingId, name: incoming.name, quantity: qty } : null,
          frozen: frozenRows.map((f) => ({ ...f, name: nameOf(f.elastic) })),
        },
      });
      job.markModified('fingerprints');
      job.increment();
      await job.save({ session });

      // ── The order: pending and the requirement, as update-elastics does ──
      await recomputePending(order, session);
      const allRows = assessLines(job.elastics, order, plannedFromJobs(siblings));
      const plannedLines = (order.elasticOrdered || []).map((l) => {
        const r = allRows.find((x) => String(x.elastic) === String(l.elastic));
        return { elastic: l.elastic, quantity: r ? Math.max(r.ordered, r.totalPlanned) : Number(l.quantity) || 0 };
      });
      const recomputed = await computeMaterialRequirement(plannedLines);
      order.rawMaterialRequired = carryEarmarksForward(order.rawMaterialRequired, recomputed).rows;
      order.updatedItemsAt = now;
      await order.save({ session });

      // ── The loom ────────────────────────────────────────────────
      if (heads !== 'none' && job.machine) {
        const machine = await Machine.findOne({ _id: job.machine, orderRunning: job._id }).session(session);
        if (machine) {
          if (incomingId) {
            const fit = await checkHookFit(machine, [incomingId]);
            if (!fit.fits && !confirmHooks) throw hookFitError(machine, fit, ErrorHandler);
            if (!fit.fits) hookNote = `${machine.ID} has ${machine.NoOfHooks} hooks per head; ${incoming.name} needs ${incoming.noOfHook}.`;
          }
          const frozenSet = new Set(freezeIds);
          // Nothing coming in: the heads the frozen elastic was on are
          // freed, so nothing is counted for them (utils/machineHeads.js).
          const next = (machine.elastics || []).map((h) => {
            const cur = h.elastic ? String(h.elastic._id ?? h.elastic) : null;
            const take = cur && (heads === 'all' || frozenSet.has(cur));
            if (take) headsChanged += 1;
            return { head: h.head, elastic: take ? incomingId : h.elastic };
          });
          if (headsChanged) {
            await Machine.updateOne({ _id: machine._id }, { $set: { elastics: next } }, { session });
            machine.elastics = next;
            await refreshOpenShiftHeads(machine, job._id, session, { allowEmpty: true });
          }
        }
      }
    });
  } finally {
    await session.endSession();
  }

  const parts = [];
  if (incomingId) parts.push(`${incoming.name} added to J-${job.jobOrderNo} for ${qty} m`);
  if (frozenRows.length) parts.push(`${frozenRows.length} line${frozenRows.length === 1 ? '' : 's'} of J-${job.jobOrderNo} frozen at what was woven`);
  if (headsChanged) parts.push(incomingId ? `put on ${headsChanged} head${headsChanged === 1 ? '' : 's'}` : `${headsChanged} head${headsChanged === 1 ? '' : 's'} freed`);
  else if (heads !== 'none' && job.machine) parts.push('no head changed — set the head map on the machine');
  return {
    message: parts.join('; ') + '.' + (hookNote ? ` ${hookNote}` : ''),
    job,
    frozen: frozenRows,
    headsChanged,
  };
}

module.exports = { changeElasticMidRun, orderElasticsForJob, MIN_REASON };

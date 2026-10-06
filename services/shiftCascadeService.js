"use strict";
// ═════════════════════════════════════════════════════════════════
//  Shift production cascade + anomaly detection.
//
//  Extracted verbatim from api/shift.js (Phase 4 god-file split). This
//  is the write path that fans an admin-verified shift's per-head
//  production out into JobOrder / Order / ShiftPlan, updates the
//  Bayesian ETA posterior, and fires the low-output / machine-anomaly
//  owner alerts. It runs INSIDE the verify transaction, so every model
//  write takes the caller's session.
//
//  Guarded by tests/api/shiftCascade.characterization.test.js — the
//  contract asserted there is the contract this module must preserve.
// ═════════════════════════════════════════════════════════════════

const ErrorHandler = require("../utils/ErrorHandler");
const Machine      = require("../models/Machine");
const Order        = require("../models/Order");
const ShiftDetail  = require("../models/ShiftDetail");
const ShiftPlan    = require("../models/ShiftPlan");
const JobOrder     = require("../models/JobOrder");
const { buildFingerprint, ACTION_CODES, actorFromRequest, stampFingerprint } = require("../utils/fingerprint");
const { updatePairPosterior } = require("../utils/etaPosterior.js");
const { recomputePending } = require("../services/orderPending.js");
const { notify } = require("../utils/notify");
const { enqueue } = require("../utils/outbox");

// ────────────────────────────────────────────────────────────────
//  applyProductionCascade
//
//  Shared helper for cascading admin-verified shift production
//  numbers into JobOrder.producedElastic / Order.producedElastic
//  / Order.pendingElastic / ShiftPlan.totalProduction.
//
//  Worker write paths now ONLY land submitted* values and flip the
//  status to 'pending_verification' — they do not call this. Only
//  the admin verify endpoint cascades, using the admin's final
//  numbers.
// ────────────────────────────────────────────────────────────────
async function applyProductionCascade(
  session,
  { shift, machine, productionMeters, timer, feedback, req }
) {
  // `productionMeters` here is the per-head value the admin entered.
  // The historical cascade multiplies by `machine.NoOfHead` for the
  // job/order/plan totals, mirroring the original /enter-shift-production.
  const prodValue = Number(productionMeters);
  if (!Number.isFinite(prodValue) || prodValue < 0) {
    throw new ErrorHandler("productionMeters must be a non-negative number", 400);
  }

  const machineDoc = machine
    ? machine
    : await Machine.findById(shift.machine).session(session);

  if (!machineDoc?.orderRunning) {
    throw new ErrorHandler("Machine has no running job", 400);
  }

  const job = await JobOrder.findById(machineDoc.orderRunning._id || machineDoc.orderRunning).session(session);
  if (!job) throw new ErrorHandler("Job not found", 404);

  // The cascade fans production across every elastic head on the
  // running machine. An empty heads array means nothing was actually
  // produced this shift — fail loudly instead of silently writing zero.
  if (!Array.isArray(machineDoc.elastics) || machineDoc.elastics.length === 0) {
    throw new ErrorHandler(
      "Machine has no elastics configured — cannot record production",
      400
    );
  }

  const elasticProductionMap = {};
  for (const head of machineDoc.elastics) {
    const eid = head.elastic.toString();
    elasticProductionMap[eid] = (elasticProductionMap[eid] || 0) + prodValue;
  }

  for (const [elasticId, qty] of Object.entries(elasticProductionMap)) {
    const idx = job.producedElastic.findIndex((e) => e.elastic.toString() === elasticId);
    if (idx >= 0) job.producedElastic[idx].quantity += qty;
    else job.producedElastic.push({ elastic: elasticId, quantity: qty });
  }

  // Cap each elastic's produced count at its planned quantity. Match
  // by elastic id, not by array index — producedElastic and elastics
  // can be in different orders (and producedElastic can have entries
  // pushed onto it above without a matching elastics slot).
  for (const e of job.elastics) {
    const planned    = e.quantity;
    const elasticId  = e.elastic.toString();
    const producedRow = job.producedElastic.find(
      (p) => p.elastic.toString() === elasticId
    );
    if (producedRow && producedRow.quantity > planned) {
      producedRow.quantity = planned;
    }
  }

  const fp = buildFingerprint(ACTION_CODES.SHIFT_PRODUCTION_VERIFIED, {
    entityId: job._id,
    actor:    actorFromRequest(req),
    meta: {
      jobStage: job.status,
      shiftId: shift._id.toString(),
      shiftLabel: shift.shift || null,
      productionMeters: prodValue * (machineDoc?.NoOfHead || 1),
      production: prodValue,
      timer: timer || null,
      machineId: machineDoc?._id?.toString() || null,
      machineName: machineDoc?.ID || null,
      feedback: feedback || undefined,
    },
  });
  job.fingerprints.push(fp);
  await job.save({ session });

  const order = await Order.findById(job.order).session(session);
  if (order) {
    // Recompute the order's produced rollup from the SUM of all its jobs.
    // (Previously this did `orderItem.quantity += p.quantity` with p iterating
    // the *cumulative* job total on every shift verify, which over-counted the
    // order's produced meters as more shifts landed.) Summing the jobs is
    // idempotent and correct regardless of how many shifts/jobs contribute.
    const jobs = await JobOrder.find({ order: order._id }).session(session);
    const producedSum = {};
    for (const j of jobs) {
      for (const p of j.producedElastic || []) {
        const eid = p.elastic.toString();
        producedSum[eid] = (producedSum[eid] || 0) + (p.quantity || 0);
      }
    }
    for (const row of order.producedElastic) {
      row.quantity = producedSum[row.elastic.toString()] || 0;
    }
    // Pending is ordered MINUS PLANNED, not minus produced — production
    // must not move it (see services/orderPending.js). Recomputing it from
    // produced here used to undo the job's planning deduction.
    await recomputePending(order, session);

    await order.save({ session });
  }

  const sp = await ShiftPlan.findById(shift.shiftPlan).session(session);
  if (sp) {
    sp.totalProduction = (sp.totalProduction || 0) + prodValue * (machineDoc?.NoOfHead || 1);
    await sp.save({ session });
  }

  // Bayesian ETA posterior: one observation per (elastic, machine)
  // pair touched by this shift. Wrapped so a posterior failure can
  // never break the cascade — the ETA layer is a forecasting hint,
  // not a correctness gate. Audit-only on failure.
  try {
    await updatePairPosterior(session, {
      shift,
      machine: machineDoc,
      productionMeters: prodValue,
    });
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "[eta-posterior] update failed for shift",
        shift?._id?.toString?.(),
        err?.message
      );
    }
  }

  // Low-output and machine-anomaly alerts (owner WhatsApp), queued in
  // the outbox INSIDE this transaction and delivered after it commits
  // (utils/outboxHandlers.js "shift.outputChecks").
  //
  // They used to be sent from right here, mid-transaction. A retried
  // transaction sent them twice, one that rolled back had already sent
  // them about a shift that was never verified, and the network call
  // held the transaction open for as long as WhatsApp took to answer.
  // Queued, they go out exactly when the verification is real.
  await enqueue(session, "shift.outputChecks", {
    shiftId:   String(shift._id),
    machineId: machineDoc?._id ? String(machineDoc._id) : null,
    perHead:   prodValue,
    actor:     { id: req?.user?._id ? String(req.user._id) : null, name: req?.user?.name || "system" },
  });

  return { job, fingerprint: fp, machine: machineDoc };
}

// ── Low-output shift alert ──────────────────────────────────────
// Compares this shift's per-head meters to the trailing 30-day
// per-head average across all closed shifts. Fires a real-time
// owner ping when ratio < 50% — that's the "bad day, look into it
// now" signal.
async function _checkLowOutputShift(shift, machine, prodValue, req) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  // Per head on both sides. `prodValue` is the per-head figure entered;
  // `productionMeters` is stored as per head × the machine's heads, and
  // averaging those totals compared a per-head figure with machine
  // totals: an ordinary shift on a six-head loom read as ~17% of normal.
  // This shift is left out of its own baseline (it runs after commit).
  const rows = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: since }, _id: { $ne: shift?._id } } },
    { $lookup: { from: Machine.collection.collectionName, localField: "machine", foreignField: "_id", as: "m" } },
    { $project: { perHead: { $divide: [
      "$productionMeters",
      { $max: [1, { $ifNull: [{ $arrayElemAt: ["$m.NoOfHead", 0] }, 1] }] },
    ] } } },
    { $group: { _id: null, total: { $sum: "$perHead" }, n: { $sum: 1 } } },
  ]);
  const r = rows[0] || {};
  if (!r.n || r.n < 5) return; // not enough data
  const baseline = r.total / r.n;
  if (!(baseline > 0)) return;
  const pct = (prodValue / baseline) * 100;
  if (pct >= 50) return; // healthy enough

  const result = await notify("shiftBelowThreshold", {
    machineId: machine?.ID,
    shift:     shift?.shift,
    date:      shift?.date,
    produced:          Math.round(prodValue),
    baseline:          Math.round(baseline),
    percentOfBaseline: pct,
    _entity: { type: "ShiftDetail", id: shift?._id },
    _actor:  { id: req?.user?._id, name: req?.user?.name || "system" },
  });
  console.log(`[notify:shiftBelowThreshold] shift=${shift?._id} →`, JSON.stringify(result));
}

// ── Machine anomaly ─────────────────────────────────────────────
// Compares this shift's per-head output to the trailing 30-day
// average FOR THIS MACHINE (not plant-wide; that's
// shiftBelowThreshold). Fires when under 40% of the machine's own
// normal. Throttled to once per hour per machine via the orchestrator's
// (event, entity.id) throttle (default throttleSeconds=3600 on the
// event). The brainstorm called for "if 5 anomalies fire in an hour,
// batch into one message" — the throttle achieves that.
async function _checkMachineAnomaly(shift, machine, prodValue, req) {
  if (!machine?._id) return;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await ShiftDetail.aggregate([
    { $match: { status: "closed", machine: machine._id, date: { $gte: since }, _id: { $ne: shift?._id } } },
    { $group: { _id: null, total: { $sum: "$productionMeters" }, n: { $sum: 1 } } },
  ]);
  const r = rows[0] || {};
  if (!r.n || r.n < 3) return; // not enough machine history
  // The stored figures are machine totals (per head × heads); this
  // shift's figure is per head. Compared per head.
  const avg = r.total / r.n / Math.max(1, Number(machine.NoOfHead) || 1);
  if (!(avg > 0)) return;
  const pct = (prodValue / avg) * 100;
  if (pct >= 40) return; // not an anomaly

  const result = await notify("anomalyDetected", {
    machineId: machine.ID,
    shift:     shift?.shift,
    date:      shift?.date,
    produced:  Math.round(prodValue),
    average:   Math.round(avg),
    percent:   pct,
    // entity.id = machine so the orchestrator throttles per machine.
    _entity: { type: "Machine", id: machine._id },
    _actor:  { id: req?.user?._id, name: req?.user?.name || "system" },
  });
  console.log(`[notify:anomalyDetected] machine=${machine.ID} →`, JSON.stringify(result));
}

// ═════════════════════════════════════════════════════════════════
//  _rederiveShiftProduction — the CORRECTION path.
//
//  applyProductionCascade ADDS a freshly-verified shift's output. When
//  an admin later corrects (PUT /production-entry) or deletes a shift's
//  production, this re-derives the job/order/plan rollups from the
//  per-head DELTA between the old and new totals, instead of double
//  counting. Runs inside the correction transaction (takes `session`).
// ═════════════════════════════════════════════════════════════════
async function _rederiveShiftProduction(session, { shift, newTotalMeters, req, auditReason, code }) {
  const heads = Array.isArray(shift.elastics) && shift.elastics.length > 0 ? shift.elastics.length : 1;
  const oldTotal = Number(shift.productionMeters) || 0;
  const oldPerHead = oldTotal / heads;
  const newPerHead = Number(newTotalMeters) / heads;
  const deltaPerHead = newPerHead - oldPerHead;

  // shift.job is captured at row creation from the machine's running job.
  // In rare cases (a shift row created for a machine with no running job) it
  // may not resolve to a JobOrder — fail cleanly rather than corrupt state.
  const job = shift.job ? await JobOrder.findById(shift.job).session(session) : null;
  if (!job) throw new ErrorHandler(
    "This shift isn't linked to a job order, so its production can't be re-derived. " +
    "Correct it via the shift verification flow instead.", 400);

  // Fan the per-head delta across the shift's elastic snapshot.
  const deltaByElastic = {};
  for (const head of shift.elastics || []) {
    if (!head.elastic) continue;
    const eid = head.elastic.toString();
    deltaByElastic[eid] = (deltaByElastic[eid] || 0) + deltaPerHead;
  }

  const before = { productionMeters: oldTotal };

  for (const [eid, d] of Object.entries(deltaByElastic)) {
    const idx = job.producedElastic.findIndex((e) => e.elastic.toString() === eid);
    if (idx >= 0) job.producedElastic[idx].quantity = Math.max(0, (job.producedElastic[idx].quantity || 0) + d);
    else if (d > 0) job.producedElastic.push({ elastic: eid, quantity: d });
  }
  // Clamp each produced elastic to its planned quantity.
  for (const e of job.elastics) {
    const row = job.producedElastic.find((p) => p.elastic.toString() === e.elastic.toString());
    if (row && row.quantity > e.quantity) row.quantity = e.quantity;
  }

  stampFingerprint(job, code, {
    req,
    meta: { shiftId: shift._id.toString(), auditReason, before, after: { productionMeters: Number(newTotalMeters) }, heads },
  });
  await job.save({ session });

  // Recompute the parent order's produced rollup from the sum of ALL its
  // jobs, then pending from ordered − produced. Correct regardless of how
  // many shifts/jobs contributed.
  const order = await Order.findById(job.order).session(session);
  if (order) {
    const jobs = await JobOrder.find({ order: order._id }).session(session);
    const producedSum = {};
    for (const j of jobs) {
      for (const p of j.producedElastic || []) {
        const eid = p.elastic.toString();
        producedSum[eid] = (producedSum[eid] || 0) + (p.quantity || 0);
      }
    }
    for (const row of order.producedElastic) {
      row.quantity = producedSum[row.elastic.toString()] || 0;
    }
    // Pending is ordered MINUS PLANNED, not minus produced — production
    // must not move it (see services/orderPending.js). Recomputing it from
    // produced here used to undo the job's planning deduction.
    await recomputePending(order, session);
    await order.save({ session });
  }

  const sp = await ShiftPlan.findById(shift.shiftPlan).session(session);
  if (sp) {
    sp.totalProduction = Math.max(0, (sp.totalProduction || 0) + deltaPerHead * heads);
    await sp.save({ session });
  }
}

module.exports = {
  applyProductionCascade,
  _checkLowOutputShift,
  _checkMachineAnomaly,
  _rederiveShiftProduction,
};

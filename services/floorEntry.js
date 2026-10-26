'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FLOOR-ENTRY SCREEN — a shift's production, loom by loom
//
//  A supervisor with the floor tablet opens one shift with its PIN
//  (models/ShiftPin.js), sees every loom with its job and head map,
//  puts an operator on each (the shift plan, if nobody made one), then
//  scans a loom's QR label and enters what it made: the run time (read
//  off a photo of the display if they like), the metres a head, a note.
//
//  Nothing here bypasses the rules the signed-in screens follow:
//
//    • an entry becomes a SUBMISSION, pending verification, through the
//      same service as every other entry (services/shiftSubmit.js);
//    • a loading loom, a verified shift, a finalised plan and a job past
//      weaving are all refused here as they are everywhere else;
//    • the plan made here is a draft, for an admin to confirm.
//
//  The PIN opens one date and shift only. The token it issues carries
//  the PIN's generation, so rotating the PIN ends every session opened
//  with the old one.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const moment = require('moment');
const mongoose = require('mongoose');
const ShiftPin = require('../models/ShiftPin');
const ShiftPlan = require('../models/ShiftPlan');
const ShiftDetail = require('../models/ShiftDetail');
const Machine = require('../models/Machine');
const Employee = require('../models/Employee');
const { assertCanWork, employedFrom } = require('../utils/employeeStatus');
require('../models/JobOrder');
require('../models/Elastic');
const ErrorHandler = require('../utils/ErrorHandler');
const { createShiftPlan, addMachineToPlan } = require('./shiftPlanCreate');
const { submitProduction } = require('./shiftSubmit');
const { isProductionLocked } = require('../utils/productionLock');
const { currentShift } = require('./machineLoading');

const TOKEN_HOURS = 14;
const SURFACE = 'floor-entry';
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isDateKey = (s) => DATE_KEY.test(String(s || '')) && moment(s, 'YYYY-MM-DD', true).isValid();
const isShift = (s) => s === 'DAY' || s === 'NIGHT';
const shiftLabel = (s) => (s === 'NIGHT' ? 'Night' : 'Day');
const dateLabel = (k) => moment(k, 'YYYY-MM-DD').format('D MMM YYYY');

// ── The PIN ───────────────────────────────────────────────────────

function newPin() {
  // Four digits, never a run like 0000 or 1234 that a thumb lands on.
  for (;;) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '4321') continue;
    return pin;
  }
}

/** The shift's PIN, made the first time it is asked for. */
async function pinFor(dateKey, shift, { createdBy = null } = {}) {
  if (!isDateKey(dateKey) || !isShift(shift)) throw new ErrorHandler('date (YYYY-MM-DD) and shift (DAY or NIGHT) are required', 400);
  const existing = await ShiftPin.findOne({ dateKey, shift });
  if (existing) return existing;
  try {
    return await ShiftPin.create({ dateKey, shift, pin: newPin(), createdBy });
  } catch (err) {
    if (err?.code === 11000) return ShiftPin.findOne({ dateKey, shift });
    throw err;
  }
}

/** A new PIN; every floor session opened with the old one ends. */
async function rotatePin(dateKey, shift, { by = null } = {}) {
  const doc = await pinFor(dateKey, shift, { createdBy: by });
  doc.pin = newPin();
  doc.generation += 1;
  doc.rotatedAt = new Date();
  doc.rotatedBy = by;
  doc.failedAttempts = 0;
  await doc.save();
  return doc;
}

const shapePin = (p) => ({
  dateKey: p.dateKey, shift: p.shift, pin: p.pin, generation: p.generation,
  createdAt: p.createdAt, rotatedAt: p.rotatedAt,
  opens: (p.opens || []).slice(-10).reverse().map((o) => ({ at: o.at, name: o.name })),
  failedAttempts: p.failedAttempts || 0,
});

// ── Opening the floor ─────────────────────────────────────────────

function issueToken({ dateKey, shift, pinId, generation, name }) {
  return jwt.sign(
    { scope: 'floor', dateKey, shift, pin: String(pinId), gen: generation, name },
    process.env.JWT_SECRET_KEY,
    { expiresIn: `${TOKEN_HOURS}h` }
  );
}

/** The session a floor token stands for, or a 401 saying why not. */
async function sessionFromToken(token) {
  let payload;
  try {
    payload = jwt.verify(String(token || ''), process.env.JWT_SECRET_KEY);
  } catch (_) {
    throw new ErrorHandler('This floor session has ended. Enter the shift PIN again.', 401);
  }
  if (payload.scope !== 'floor' || !isDateKey(payload.dateKey) || !isShift(payload.shift)) {
    throw new ErrorHandler('This floor session has ended. Enter the shift PIN again.', 401);
  }
  const pin = await ShiftPin.findById(payload.pin).select('generation').lean();
  if (!pin || pin.generation !== payload.gen) {
    throw new ErrorHandler('The shift PIN was changed. Enter the new PIN to carry on.', 401);
  }
  return { dateKey: payload.dateKey, shift: payload.shift, name: payload.name || '', pinId: String(payload.pin) };
}

/**
 * Open a shift with its PIN.
 * @returns {{ token, session, state }}
 */
async function openFloor({ dateKey, shift, pin, name, ip = '' }) {
  if (!isDateKey(dateKey) || !isShift(shift)) throw new ErrorHandler('Choose the date and the shift.', 400);
  const who = String(name || '').trim();
  if (who.length < 2) throw new ErrorHandler('Type your name, so the entries say who made them.', 400);
  const typed = String(pin || '').trim();
  if (!/^\d{4}$/.test(typed)) throw new ErrorHandler('The PIN is four digits.', 400);

  const doc = await ShiftPin.findOne({ dateKey, shift });
  if (!doc || doc.pin !== typed) {
    if (doc) await ShiftPin.updateOne({ _id: doc._id }, { $inc: { failedAttempts: 1 } });
    throw new ErrorHandler(
      doc
        ? `That is not the PIN for the ${shiftLabel(shift).toLowerCase()} shift of ${dateLabel(dateKey)}.`
        : `No PIN has been made for the ${shiftLabel(shift).toLowerCase()} shift of ${dateLabel(dateKey)} yet. Ask the admin to open that shift on Shift Plans.`,
      401
    );
  }
  await ShiftPin.updateOne(
    { _id: doc._id },
    { $push: { opens: { $each: [{ at: new Date(), name: who, ip }], $slice: -50 } } }
  );
  const session = { dateKey, shift, name: who, pinId: String(doc._id) };
  const token = issueToken({ ...session, generation: doc.generation });
  return { token, session, state: await shiftState(session) };
}

// ── The shift as it stands ────────────────────────────────────────

/** The plan for a date and shift, however its date was stored. */
async function findPlan(dateKey, shift) {
  const centre = moment.utc(dateKey, 'YYYY-MM-DD');
  const candidates = await ShiftPlan.find({
    shift,
    date: { $gte: centre.clone().subtract(36, 'hours').toDate(), $lte: centre.clone().add(36, 'hours').toDate() },
  }).select('_id date shift status finalized description plan').lean();
  return candidates.find((p) => moment(p.date).format('YYYY-MM-DD') === dateKey)
    || candidates.find((p) => new Date(p.date).toISOString().slice(0, 10) === dateKey)
    || null;
}

const MACHINE_FIELDS = 'ID manufacturer NoOfHead NoOfHooks status loading orderRunning elastics';

function headMapOf(m) {
  return (m.elastics || [])
    .filter((h) => h && h.head != null)
    .sort((a, b) => a.head - b.head)
    .map((h) => ({
      head: h.head,
      elastic: h.elastic ? { id: String(h.elastic._id ?? h.elastic), name: h.elastic.name ?? null } : null,
    }));
}

/**
 * One loom, with what the floor can do on it this shift.
 *
 *   entry: 'free'        no job — nothing to enter
 *          'loading'     being loaded — nothing to enter
 *          'unplanned'   runs a job but is not on this shift's plan yet
 *          'ready'       on the plan, nothing entered yet
 *          'entered'     entered, waiting to be verified (can be corrected)
 *          'verified'    verified — locked
 *          'locked'      job past weaving, or plan finalised
 */
function machineState(m, detail, plan) {
  const job = m.orderRunning && typeof m.orderRunning === 'object' ? m.orderRunning : null;
  const headMap = headMapOf(m);
  const headsRunning = headMap.filter((h) => h.elastic).length;
  const loading = m.status === 'running' && !!m.loading;

  let entry;
  let why = null;
  if (plan?.finalized) { entry = 'locked'; why = 'This shift is finalised.'; }
  else if (detail?.status === 'closed') { entry = 'verified'; why = 'Verified already.'; }
  else if (detail?.status === 'loading' || (loading && !detail)) { entry = 'loading'; why = 'The loom is being loaded for its job — nothing to enter.'; }
  else if (m.status === 'maintenance') { entry = 'free'; why = 'Under maintenance — nothing to enter.'; }
  else if (!job || m.status !== 'running') { entry = 'free'; why = 'No job on this loom.'; }
  else if (isProductionLocked(job.status)) { entry = 'locked'; why = `Its job is ${job.status}; production is closed.`; }
  else if (!detail) entry = 'unplanned';
  else if (detail.status === 'pending_verification') entry = 'entered';
  else entry = 'ready';

  return {
    id: String(m._id),
    ID: m.ID,
    manufacturer: m.manufacturer || '',
    hooks: m.NoOfHooks ?? null,
    heads: m.NoOfHead ?? null,
    headsRunning,
    status: m.status,
    loading,
    job: job ? { id: String(job._id), no: job.jobOrderNo != null ? `J-${job.jobOrderNo}` : 'Job', status: job.status } : null,
    headMap,
    detail: detail ? {
      id: String(detail._id),
      status: detail.status,
      operator: detail.employee ? { id: String(detail.employee._id ?? detail.employee), name: detail.employee.name ?? null } : null,
      submitted: detail.status === 'pending_verification' || detail.status === 'closed' ? {
        production: detail.status === 'closed' ? (detail.productionMeters ?? null) : (detail.submittedProductionMeters ?? null),
        timer: detail.status === 'closed' ? (detail.timer || null) : (detail.submittedTimer || null),
        feedback: detail.submittedFeedback || detail.feedback || '',
        at: detail.submittedAt || detail.verifiedAt || null,
        byName: detail.submittedByName || '',
      } : null,
    } : null,
    entry,
    why,
  };
}

/** Everything the screen shows for the open shift. */
async function shiftState({ dateKey, shift }) {
  const plan = await findPlan(dateKey, shift);
  const [machines, details, operators] = [
    await Machine.find().select(MACHINE_FIELDS)
      .populate({ path: 'orderRunning', select: 'jobOrderNo status' })
      .populate({ path: 'elastics.elastic', select: 'name' })
      .lean(),
    plan ? await ShiftDetail.find({ _id: { $in: plan.plan || [] } })
      .select('machine employee status submittedProductionMeters submittedTimer submittedFeedback submittedAt submittedByName productionMeters timer feedback verifiedAt')
      .populate({ path: 'employee', select: 'name department' }).lean() : [],
    // The operators to pick from: whoever is still here on this shift's date.
    await Employee.find(employedFrom(dateKey)).select('name department').sort({ name: 1 }).lean(),
  ];
  machines.sort((a, b) => String(a.ID).localeCompare(String(b.ID), undefined, { numeric: true, sensitivity: 'base' }));
  const detailByMachine = new Map(details.map((d) => [String(d.machine), d]));
  const rows = machines.map((m) => machineState(m, detailByMachine.get(String(m._id)) || null, plan));
  const counts = rows.reduce((c, r) => { c[r.entry] = (c[r.entry] || 0) + 1; return c; }, {});
  const now = currentShift();
  return {
    dateKey, shift,
    label: `${shiftLabel(shift)} shift · ${dateLabel(dateKey)}`,
    // Said on the screen when the shift opened is not the one running now.
    isCurrent: now.dateKey === dateKey && now.shift === shift,
    plan: plan ? { id: String(plan._id), status: plan.status, finalized: !!plan.finalized, description: plan.description || '' } : null,
    machines: rows,
    // Weavers first: they are who runs looms. Everyone is offered.
    operators: operators
      .sort((a, b) => (a.department === 'weaving' ? 0 : 1) - (b.department === 'weaving' ? 0 : 1) || String(a.name).localeCompare(String(b.name)))
      .map((e) => ({ id: String(e._id), name: e.name, department: e.department || '' })),
    counts: {
      total: rows.length,
      toEnter: (counts.ready || 0) + (counts.unplanned || 0),
      entered: (counts.entered || 0) + (counts.verified || 0),
      ...counts,
    },
  };
}

/** A machine, by its QR payload ("MACHINE|<id>|<ID>"), its id, or its ID as typed. */
async function resolveMachine(code) {
  const raw = String(code || '').trim();
  if (!raw) throw new ErrorHandler('Scan a machine label, or type the machine ID.', 400);
  const parts = raw.split('|');
  if (parts[0].toUpperCase() === 'MACHINE' && parts[1] && mongoose.isValidObjectId(parts[1])) {
    const m = await Machine.findById(parts[1]).select('_id').lean();
    if (m) return m._id;
  }
  if (/^SHIFTROW\|/i.test(raw) || /^FLOORROW\|/i.test(raw)) {
    // A row off a printed sheet names its machine third.
    const id = raw.split('|').find((p) => /^M:/i.test(p))?.slice(2);
    if (id) {
      const m = await Machine.findOne({ ID: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
      if (m) return m._id;
    }
    throw new ErrorHandler('That is a row off a production sheet, not a machine label. Scan the label on the loom.', 404);
  }
  if (/^J-?\d+$/i.test(raw) || /^JOB\|/i.test(raw)) {
    throw new ErrorHandler('That is a job label, not a machine label. Scan the label on the loom.', 404);
  }
  if (mongoose.isValidObjectId(raw)) {
    const m = await Machine.findById(raw).select('_id').lean();
    if (m) return m._id;
  }
  const byId = await Machine.findOne({ ID: new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
  if (byId) return byId._id;
  throw new ErrorHandler(`No machine called "${raw}". Check the label, or pick the loom from the list.`, 404);
}

/** One loom's state for the open shift. */
async function machineForShift({ dateKey, shift }, code) {
  const machineId = await resolveMachine(code);
  const plan = await findPlan(dateKey, shift);
  const m = await Machine.findById(machineId).select(MACHINE_FIELDS)
    .populate({ path: 'orderRunning', select: 'jobOrderNo status' })
    .populate({ path: 'elastics.elastic', select: 'name' })
    .lean();
  const detail = plan
    ? await ShiftDetail.findOne({ shiftPlan: plan._id, machine: m._id })
      .select('machine employee status submittedProductionMeters submittedTimer submittedFeedback submittedAt submittedByName productionMeters timer feedback verifiedAt')
      .populate({ path: 'employee', select: 'name department' }).lean()
    : null;
  return { plan: plan ? { id: String(plan._id), finalized: !!plan.finalized } : null, machine: machineState(m, detail, plan) };
}

// ── Planning from the floor ───────────────────────────────────────

/** The plan, from the operators the supervisor put on each loom. */
async function planFromFloor(session, rows) {
  const existing = await findPlan(session.dateKey, session.shift);
  if (existing) {
    const err = new ErrorHandler('This shift has a plan already — it was made meanwhile. Carry on with it.', 409);
    err.code = 'PLAN_EXISTS';
    throw err;
  }
  const machines = (rows || []).filter((r) => r && r.machine && r.operator);
  if (!machines.length) throw new ErrorHandler('Put an operator on at least one loom.', 400);
  const seen = new Set();
  for (const r of machines) {
    if (seen.has(String(r.machine))) throw new ErrorHandler('A loom is listed twice.', 400);
    seen.add(String(r.machine));
  }
  const { shiftPlan, detailCount } = await createShiftPlan({
    date: session.dateKey, shiftType: session.shift,
    description: `From the floor (${session.name})`,
    machines: machines.map((r) => ({ machine: r.machine, operator: r.operator })),
  });
  return { planId: String(shiftPlan._id), planned: detailCount };
}

/** An operator on a loom: added to the plan, or changed on an entry not yet verified. */
async function setOperator(session, { machine, operator }) {
  if (!mongoose.isValidObjectId(String(machine)) || !mongoose.isValidObjectId(String(operator))) {
    throw new ErrorHandler('Choose the loom and the operator.', 400);
  }
  const plan = await findPlan(session.dateKey, session.shift);
  if (!plan) throw new ErrorHandler('Make the shift plan first.', 409);
  if (plan.finalized) throw new ErrorHandler('This shift is finalised.', 409);
  const emp = await Employee.findById(operator).select('_id').lean();
  if (!emp) throw new ErrorHandler('That operator is not on record.', 404);
  await assertCanWork([operator], session.dateKey);

  const detail = await ShiftDetail.findOne({ shiftPlan: plan._id, machine }).select('status').lean();
  if (!detail) {
    const created = await addMachineToPlan(plan._id, { machine, operator });
    return { detailId: String(created._id), added: true };
  }
  if (detail.status === 'closed') throw new ErrorHandler('That entry is verified; its operator cannot change now.', 409);
  await ShiftDetail.updateOne({ _id: detail._id, status: { $ne: 'closed' } }, { $set: { employee: operator } });
  return { detailId: String(detail._id), added: false };
}

// ── Entering production ───────────────────────────────────────────

async function enterProduction(session, { detailId, production, timer, feedback, operator }) {
  if (!mongoose.isValidObjectId(String(detailId))) throw new ErrorHandler('Scan the loom again.', 400);
  const plan = await findPlan(session.dateKey, session.shift);
  if (!plan) throw new ErrorHandler('Make the shift plan first.', 409);
  const detail = await ShiftDetail.findOne({ _id: detailId, shiftPlan: plan._id }).select('status machine').lean();
  if (!detail) throw new ErrorHandler('That loom is not on this shift. Scan it again.', 404);
  if (detail.status === 'loading') throw new ErrorHandler('The loom was being loaded this shift — there is no production to enter.', 409);
  if (detail.status === 'closed') throw new ErrorHandler('This entry is verified already; it cannot be changed from the floor.', 409);
  if (plan.finalized) throw new ErrorHandler('This shift is finalised.', 409);

  const metres = Number(production);
  if (!Number.isFinite(metres) || metres < 0) throw new ErrorHandler('Enter the metres produced a head, 0 or more.', 400);
  let runTime = timer == null || timer === '' ? null : String(timer).trim();
  if (runTime) {
    const m = runTime.match(/^(\d{1,2})[:.]([0-5]?\d)(?::([0-5]?\d))?$/);
    if (!m) throw new ErrorHandler('Write the run time like 7:30 or 7:30:00.', 400);
    runTime = `${Number(m[1])}:${m[2].padStart(2, '0')}:${(m[3] ?? '00').padStart(2, '0')}`;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (minutes > 12 * 60) throw new ErrorHandler('A shift is 12 hours; the run time cannot be more.', 400);
  }

  if (operator && mongoose.isValidObjectId(String(operator))) {
    await assertCanWork([operator], session.dateKey);
    await ShiftDetail.updateOne({ _id: detail._id, status: { $ne: 'closed' } }, { $set: { employee: operator } });
  }
  const out = await submitProduction(
    [{ id: String(detail._id), production: metres, ...(runTime ? { timer: runTime } : {}), feedback: String(feedback || '').slice(0, 500) }],
    { userId: null, surface: SURFACE }
  );
  if (out.skipped.length) throw new ErrorHandler(out.skipped[0].reason, 409);
  await ShiftDetail.updateOne({ _id: detail._id }, { $set: { submittedByName: session.name } });
  return { detailId: String(detail._id), machineId: String(detail.machine) };
}

module.exports = {
  pinFor, rotatePin, shapePin,
  openFloor, sessionFromToken, issueToken,
  shiftState, machineForShift, resolveMachine, findPlan,
  planFromFloor, setOperator, enterProduction,
  SURFACE, TOKEN_HOURS,
};

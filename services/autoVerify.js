'use strict';
// ══════════════════════════════════════════════════════════════════
//  VERIFYING A SHIFT ENTRY WITHOUT A PERSON
//
//  The office checks each entry against two things: the photo of the
//  loom's timer, and what that loom should have made. When both already
//  agree, there is nothing for a person to add. An entry is verified by
//  the rule only when every one of these holds:
//
//    • an admin has turned it on (models/ProductionSettings.js)
//    • it is waiting for verification, and no remark was left with it —
//      a remark is something someone wanted a person to read
//    • its run time is the one read off a photo of the timer, and was
//      used from that photo (a typed run time has nothing behind it)
//    • the loom's own rate is known, learned from at least `minShifts`
//      of its verified shifts (a plant-wide guess is not enough)
//    • the metres a head are within `tolerancePct` of what the loom makes
//      in that run time, at the pick of the elastics on its heads
//
//  Anything else waits for the office as before, with the reasons kept.
//  The verification itself is the office's own path
//  (api/shift.js verifyShiftProduction): same cascade, same attendance,
//  same refusals (a finalised plan, a job past weaving). It records what
//  it was checked against, and the office sees every auto-verified entry.
// ══════════════════════════════════════════════════════════════════

const ShiftDetail = require('../models/ShiftDetail');
const TimerPhoto = require('../models/TimerPhoto');
const Machine = require('../models/Machine');
const ProductionSettings = require('../models/ProductionSettings');
const pm = require('./productionModel');

const r1 = (n) => Math.round(Number(n) * 10) / 10;

async function settings() {
  return ProductionSettings.findOneAndUpdate({ key: 'production' }, { $setOnInsert: { key: 'production' } }, { upsert: true, new: true }).lean();
}

/** What the loom's sensor says it ran on the entry's shift, or null. */
async function sensorRunFor(d) {
  const plan = d.shiftPlan && typeof d.shiftPlan === 'object' ? d.shiftPlan : null;
  const date = plan?.date || d.date;
  const shift = plan?.shift || d.shift;
  if (!date || !shift) return null;
  return require('./loomSensor').shiftRun(d.machine, { dateKey: factoryClockKey(date), shift }).catch(() => null);
}

/** A plan's date (UTC midnight, or older ones local midnight) as its factory-day key. */
function factoryClockKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.FACTORY_TZ || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}

/** The run time as minutes, whatever way it was written. */
const minutesOf = (t) => pm.runMinutes(t);

/**
 * @returns { ok, reasons: string[], auto?: { expected, low, high, tolerancePct, shifts, photo } }
 */
async function check(detailId, s = null) {
  const cfg = (s || (await settings())).autoVerify || {};
  const reasons = [];
  if (!cfg.enabled) return { ok: false, reasons: ['auto-verification is off'] };
  const d = await ShiftDetail.findById(detailId).select('status submittedProductionMeters submittedTimer submittedFeedback machine shiftPlan date shift').populate({ path: 'shiftPlan', select: 'date shift' }).lean();
  if (!d) return { ok: false, reasons: ['entry not found'] };
  if (d.status !== 'pending_verification') return { ok: false, reasons: ['not waiting for verification'] };
  if (String(d.submittedFeedback || '').trim()) reasons.push('a remark was left with it');
  const minutes = minutesOf(d.submittedTimer);
  if (!minutes) reasons.push('no run time');
  else if (minutes > 12 * 60) reasons.push('run time longer than a shift');

  // The run time's evidence: a photo of the timer it was read from, or
  // else the loom's own sensor agreeing with it (within 5 min or 3%).
  const photo = await TimerPhoto.findOne({ shift: d._id, used: true }).sort({ createdAt: -1 }).select('runTimeUsed').lean();
  let sensorRunTime = null;
  if (!photo) {
    const sensor = await sensorRunFor(d);
    if (!sensor) reasons.push('run time not read from a photo of the timer, and no loom sensor to check it');
    else if (!minutes || Math.abs(sensor.seconds / 60 - minutes) > Math.max(5, minutes * 0.03)) reasons.push(`run time differs from the loom sensor's ${sensor.runTime}`);
    else sensorRunTime = sensor.runTime;
  } else if (!minutes || Math.abs((minutesOf(photo.runTimeUsed) || -1) - minutes) > 0.5) reasons.push('run time differs from the one read off the photo');

  let auto = null;
  if (minutes) {
    const machine = await Machine.findById(d.machine).select('elastics').lean();
    const elasticIds = (machine?.elastics || []).filter((h) => h && h.elastic).map((h) => h.elastic);
    const out = await pm.expectFor({ machineId: d.machine, elasticIds, minutes });
    const p = out?.prediction;
    if (!p) reasons.push(out?.reason || out?.pickProblem ? `no expected output (${out?.reason ? 'model not trained yet' : out.pickProblem})` : 'no expected output for this loom');
    else if (p.basis !== 'machine' || p.shifts < (cfg.minShifts || 8)) reasons.push(`this loom's rate is not learned yet (${p.shifts || 0} of ${cfg.minShifts || 8} shifts)`);
    else {
      const tol = (cfg.tolerancePct || 10) / 100;
      const low = r1(p.perHead * (1 - tol));
      const high = r1(p.perHead * (1 + tol));
      const entered = Number(d.submittedProductionMeters);
      if (!(entered >= low && entered <= high)) reasons.push(`${entered} m a head is outside ${low}–${high} m expected`);
      auto = { expected: p.perHead, low, high, tolerancePct: cfg.tolerancePct || 10, shifts: p.shifts, photo: photo?._id, ...(sensorRunTime ? { sensorRunTime } : {}) };
    }
  }
  return reasons.length ? { ok: false, reasons, ...(auto ? { expected: auto } : {}) } : { ok: true, reasons: [], auto };
}

/** The auto-verifier's stand-in for a request: who the fingerprints say did it. */
const SYSTEM_REQ = { user: { _id: null, name: 'Auto-verify', role: 'system' }, body: {} };

/**
 * Verify the entry by the rule when it qualifies. Never throws: an entry
 * that cannot be verified simply waits for the office.
 * @returns { verified: boolean, reasons: string[] }
 */
async function tryAutoVerify(detailId) {
  try {
    const c = await check(detailId);
    if (!c.ok) return { verified: false, reasons: c.reasons };
    const d = await ShiftDetail.findById(detailId).select('submittedProductionMeters submittedTimer').lean();
    const { verifyShiftProduction } = require('../api/shift');
    await verifyShiftProduction({ shiftId: detailId, productionMeters: d.submittedProductionMeters, timer: d.submittedTimer, feedback: '' }, SYSTEM_REQ, { auto: c.auto });
    return { verified: true, reasons: [], expected: c.auto.expected };
  } catch (err) {
    return { verified: false, reasons: [err.message || 'could not verify'] };
  }
}

module.exports = { settings, check, tryAutoVerify };

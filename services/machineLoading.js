'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOOM BEING LOADED FOR ITS JOB
//
//  When a job is put on a machine, the loom is loaded first — beam up,
//  heads drawn in — and weaves nothing. Counting those shifts as zero
//  production dragged the floor's efficiency down for work that was
//  never meant to produce, so:
//
//    • the machine carries `loading: true` (it is still the job's,
//      status "running");
//    • its shifts from the current one on are marked status "loading":
//      no production can be entered on them, and every production and
//      efficiency figure — which reads verified ("closed") shifts —
//      leaves them out;
//    • marking the machine running puts its shifts from the current one
//      on back to "open", and production counts from there.
//
//  A shift that has already ended stays as it was: a night of loading
//  stays loading after the loom is marked running next morning.
// ══════════════════════════════════════════════════════════════════

const moment = require('moment');
const Machine = require('../models/Machine');
const ShiftDetail = require('../models/ShiftDetail');
const ErrorHandler = require('../utils/ErrorHandler');

/** Day shift runs 08:00–20:00, night 20:00–08:00, factory time. */
const DAY_STARTS = 8;
const NIGHT_STARTS = 20;
const FACTORY_TZ = process.env.FACTORY_TZ || 'Asia/Kolkata';

/** { dateKey: 'YYYY-MM-DD', hour } of an instant in factory time, whatever the server's zone. */
function factoryClock(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: FACTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant)).map((p) => [p.type, p.value])
  );
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The shift running at `now`: { dateKey, shift }. A night belongs to the day it started. */
function currentShift(now = new Date()) {
  const { dateKey, hour } = factoryClock(now);
  if (hour >= DAY_STARTS && hour < NIGHT_STARTS) return { dateKey, shift: 'DAY' };
  if (hour >= NIGHT_STARTS) return { dateKey, shift: 'NIGHT' };
  return { dateKey: moment(dateKey, 'YYYY-MM-DD').subtract(1, 'day').format('YYYY-MM-DD'), shift: 'NIGHT' };
}

/**
 * A shift detail's own date. Plans store UTC midnight (older ones the
 * server's local midnight); both fall on the right day in factory time.
 */
const shiftDateKey = (date) => factoryClock(date).dateKey;

/** Is this shift the current one or later? */
function isCurrentOrLater(sd, cur) {
  const key = shiftDateKey(sd.date);
  if (key !== cur.dateKey) return key > cur.dateKey;
  return sd.shift === cur.shift || (cur.shift === 'DAY' && sd.shift === 'NIGHT');
}

/**
 * Mark the machine's shifts from the current one on as loading (or back
 * to open). Only shifts nobody has entered production on are marked
 * loading. Returns how many changed.
 */
async function retagShifts(machineId, toLoading, { session = null, now = new Date() } = {}) {
  const from = toLoading ? 'open' : 'loading';
  const to = toLoading ? 'loading' : 'open';
  const docs = await ShiftDetail.find({ machine: machineId, status: from })
    .select('_id date shift submittedProductionMeters').session(session).lean();
  const cur = currentShift(now);
  const ids = docs
    .filter((d) => isCurrentOrLater(d, cur) && (!toLoading || d.submittedProductionMeters == null))
    .map((d) => d._id);
  if (!ids.length) return 0;
  const res = await ShiftDetail.updateMany(
    { _id: { $in: ids }, status: from },
    { $set: { status: to } },
    { session }
  );
  return res.modifiedCount ?? ids.length;
}

/**
 * Mark a running machine as loading, or loaded and running.
 * @returns {{ machine, shiftsChanged }}
 */
async function setMachineLoading(machineId, loading, { session = null, now = new Date() } = {}) {
  const machine = await Machine.findById(machineId).session(session);
  if (!machine) throw new ErrorHandler('Machine not found.', 404);
  if (loading && machine.status !== 'running') {
    throw new ErrorHandler(`${machine.ID} is ${machine.status}; only a machine with a job on it can be loading.`, 400);
  }
  if (!!machine.loading === !!loading) return { machine, shiftsChanged: 0 };

  await Machine.updateOne(
    { _id: machine._id },
    { $set: { loading: !!loading, loadingSince: loading ? now : null } },
    { session }
  );
  const shiftsChanged = await retagShifts(machine._id, !!loading, { session, now });
  machine.loading = !!loading;
  machine.loadingSince = loading ? now : null;
  return { machine, shiftsChanged };
}

/** The status a new shift on this machine starts in. */
const startingStatus = (machine) => (machine?.status === 'running' && machine?.loading ? 'loading' : 'open');

module.exports = { setMachineLoading, retagShifts, startingStatus, currentShift, isCurrentOrLater };

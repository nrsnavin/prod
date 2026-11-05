'use strict';
// ══════════════════════════════════════════════════════════════════
//  LOOM SENSORS — what a loom's own board says it ran
//
//  A board on each loom (tools/loom-sensor/) counts the seconds the loom
//  runs, from its run signal, and posts the running total about once a
//  minute — with its own key, sent as "<keyId>.<secret>". Posts are
//  kept as readings; a shift's run time is the rise in the total across
//  the shift (08:00–20:00 day, 20:00–08:00 night, factory time):
//
//    • a lost post loses nothing: the next total carries it;
//    • a board that restarts counts from zero again: a drop is a restart,
//      and the new total is all run since it;
//    • a rise can never be more than the time between the two posts
//      (a garbled total does not become hours of running);
//    • a rise that straddles the shift's start or end is shared by time.
//
//  The floor is offered the sensor's run time beside the photo, and
//  auto-verification takes it as the run time's evidence.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const mongoose = require('mongoose');
const LoomDevice = require('../models/LoomDevice');
const LoomReading = require('../models/LoomReading');
const Machine = require('../models/Machine');
const ErrorHandler = require('../utils/ErrorHandler');

const FACTORY_TZ = process.env.FACTORY_TZ || 'Asia/Kolkata';
const MAX_BATCH = 500;
const SLACK_S = 90;
const LIVE_MS = 10 * 60_000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function retentionExpiry(now = new Date()) {
  const days = Number(process.env.LOOM_READING_RETENTION_DAYS ?? 120);
  return Number.isFinite(days) && days > 0 ? new Date(now.getTime() + days * 86_400_000) : null;
}

/** A new key: the id is public, the secret is shown once and kept only as a hash. */
function newKey() {
  const keyId = `ld_${crypto.randomBytes(6).toString('hex')}`;
  const secret = crypto.randomBytes(24).toString('base64url');
  return { keyId, secret, key: `${keyId}.${secret}`, keyHash: sha(secret) };
}

const shape = (d, machine) => ({
  id: String(d._id),
  machine: machine ? { id: String(machine._id), ID: machine.ID } : { id: String(d.machine), ID: null },
  name: d.name || '',
  keyId: d.keyId,
  active: !!d.active,
  lastSeenAt: d.lastSeenAt || null,
  live: !!(d.active && d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < LIVE_MS),
  lastReading: d.lastReading?.at ? d.lastReading : null,
  firmware: d.firmware || '',
});

// ── Devices (admin) ───────────────────────────────────────────────

async function listDevices() {
  const devices = await LoomDevice.find({}).sort({ active: -1, createdAt: 1 }).lean();
  const machines = await Machine.find({ _id: { $in: devices.map((d) => d.machine) } }).select('ID').lean();
  const byId = new Map(machines.map((m) => [String(m._id), m]));
  return devices.map((d) => shape(d, byId.get(String(d.machine))));
}

async function addDevice({ machine, name = '' }, userId = null) {
  if (!mongoose.isValidObjectId(String(machine))) throw new ErrorHandler('Choose the loom', 400);
  const m = await Machine.findById(machine).select('ID').lean();
  if (!m) throw new ErrorHandler('Loom not found', 404);
  if (await LoomDevice.exists({ machine: m._id, active: true })) {
    throw new ErrorHandler(`${m.ID} has a sensor already — replace its key, or remove it first`, 409);
  }
  const k = newKey();
  const d = await LoomDevice.create({ machine: m._id, name: String(name || '').slice(0, 80), keyId: k.keyId, keyHash: k.keyHash, createdBy: userId || undefined });
  return { device: shape(d.toObject(), m), key: k.key };
}

async function rotateKey(id) {
  if (!mongoose.isValidObjectId(String(id))) throw new ErrorHandler('Sensor not found', 404);
  const k = newKey();
  const d = await LoomDevice.findOneAndUpdate({ _id: id }, { $set: { keyId: k.keyId, keyHash: k.keyHash, active: true } }, { new: true }).lean();
  if (!d) throw new ErrorHandler('Sensor not found', 404);
  const m = await Machine.findById(d.machine).select('ID').lean();
  return { device: shape(d, m), key: k.key };
}

async function removeDevice(id) {
  if (!mongoose.isValidObjectId(String(id))) throw new ErrorHandler('Sensor not found', 404);
  const d = await LoomDevice.findOneAndUpdate({ _id: id }, { $set: { active: false } }, { new: true }).lean();
  if (!d) throw new ErrorHandler('Sensor not found', 404);
  return shape(d, await Machine.findById(d.machine).select('ID').lean());
}

// ── The device posting ────────────────────────────────────────────

/** The active device a key belongs to, or null. Constant-time on the secret. */
async function deviceForKey(raw) {
  const [keyId, secret] = String(raw || '').trim().split('.', 2);
  if (!keyId || !secret) return null;
  const d = await LoomDevice.findOne({ keyId, active: true }).select('+keyHash').lean();
  if (!d) return null;
  const a = Buffer.from(sha(secret), 'hex');
  const b = Buffer.from(String(d.keyHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? d : null;
}

/**
 * Readings from a device: one `{ runSecondsTotal, picksTotal?, running?, at? }`
 * or `{ readings: [...] }` (what a board buffered while offline). `at`
 * is epoch seconds; missing, it is now. Readings from the future or
 * more than a week old are refused one by one; a repeat is ignored.
 */
async function ingest(device, body, now = new Date()) {
  const list = Array.isArray(body?.readings) ? body.readings : [body];
  if (!list.length || list.length > MAX_BATCH) throw new ErrorHandler(`Send 1 to ${MAX_BATCH} readings`, 400);
  const rows = [];
  const refused = [];
  list.forEach((r, i) => {
    const total = Number(r?.runSecondsTotal);
    const at = r?.at == null ? now : new Date(Number(r.at) * 1000);
    const why = !Number.isFinite(total) || total < 0 ? 'runSecondsTotal must be 0 or more'
      : Number.isNaN(at.getTime()) ? 'at must be epoch seconds'
        : at.getTime() > now.getTime() + 5 * 60_000 ? 'at is in the future — set the board\'s clock'
          : at.getTime() < now.getTime() - 7 * 86_400_000 ? 'at is more than a week old'
            : null;
    if (why) { refused.push({ index: i, why }); return; }
    const picks = Number(r?.picksTotal);
    rows.push({
      device: device._id, machine: device.machine, at, runSecondsTotal: Math.floor(total),
      picksTotal: Number.isFinite(picks) && picks >= 0 ? Math.floor(picks) : null,
      running: typeof r?.running === 'boolean' ? r.running : null,
      expiresAt: retentionExpiry(now),
    });
  });
  let stored = 0;
  if (rows.length) {
    try {
      const out = await LoomReading.insertMany(rows, { ordered: false });
      stored = out.length;
    } catch (err) {
      // Repeats (the unique device+at index) are expected after a lost reply.
      stored = err?.insertedDocs?.length ?? err?.result?.insertedCount ?? 0;
      if (err?.code !== 11000 && !(err?.writeErrors || []).every((w) => (w.code ?? w.err?.code) === 11000)) throw err;
    }
    const latest = rows.reduce((a, b) => (b.at > a.at ? b : a));
    await LoomDevice.updateOne(
      { _id: device._id, $or: [{ 'lastReading.at': { $lt: latest.at } }, { 'lastReading.at': { $exists: false } }, { 'lastReading.at': null }] },
      { $set: { lastReading: { at: latest.at, runSecondsTotal: latest.runSecondsTotal, picksTotal: latest.picksTotal, running: latest.running } } },
    );
  }
  await LoomDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: now, ...(body?.firmware ? { firmware: String(body.firmware).slice(0, 40) } : {}) } });
  return { stored, refused };
}

// ── A shift's run time ────────────────────────────────────────────

/** The instant a factory-time hour starts on a day ("2026-10-21", 8). */
function factoryInstant(dateKey, hour) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FACTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asUtc - guess));
}

function shiftWindow({ dateKey, shift }) {
  const start = factoryInstant(dateKey, shift === 'NIGHT' ? 20 : 8);
  return { start, end: new Date(start.getTime() + 12 * 3600_000) };
}

/** Seconds run between `start` and `end`, from readings in time order (with the one before `start`). */
function runSecondsBetween(readings, start, end) {
  let total = 0;
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1];
    const cur = readings[i];
    const t0 = new Date(prev.at).getTime();
    const t1 = new Date(cur.at).getTime();
    if (t1 <= t0) continue;
    let rise = cur.runSecondsTotal - prev.runSecondsTotal;
    if (rise < 0) rise = cur.runSecondsTotal; // the board restarted
    rise = Math.min(rise, (t1 - t0) / 1000 + SLACK_S);
    const from = Math.max(t0, start.getTime());
    const to = Math.min(t1, end.getTime());
    if (to <= from) continue;
    total += rise * ((to - from) / (t1 - t0));
  }
  return Math.max(0, Math.round(total));
}

const hms = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/**
 * What the loom's sensor says it ran on a shift, or null with no sensor
 * or no readings. `complete` once a reading at or after the shift's end
 * is in; `coverage` the share of the shift the readings span.
 */
async function shiftRun(machineId, { dateKey, shift }) {
  if (!mongoose.isValidObjectId(String(machineId))) return null;
  const { start, end } = shiftWindow({ dateKey, shift });
  const before = await LoomReading.findOne({ machine: machineId, at: { $lt: start, $gte: new Date(start.getTime() - 3 * 3600_000) } }).sort({ at: -1 }).lean();
  const inside = await LoomReading.find({ machine: machineId, at: { $gte: start, $lte: new Date(end.getTime() + 15 * 60_000) } }).sort({ at: 1 }).lean();
  const rows = [...(before ? [before] : []), ...inside];
  if (rows.length < 2) return null;
  const seconds = runSecondsBetween(rows, start, end);
  const first = Math.max(new Date(rows[0].at).getTime(), start.getTime());
  const last = Math.min(new Date(rows[rows.length - 1].at).getTime(), end.getTime());
  return {
    seconds,
    runTime: hms(seconds),
    complete: new Date(rows[rows.length - 1].at).getTime() >= end.getTime(),
    coverage: Math.max(0, Math.min(1, (last - first) / (end.getTime() - start.getTime()))),
    lastAt: rows[rows.length - 1].at,
  };
}

module.exports = {
  listDevices, addDevice, rotateKey, removeDevice,
  deviceForKey, ingest, shiftRun, shiftWindow, runSecondsBetween, factoryInstant, newKey,
};

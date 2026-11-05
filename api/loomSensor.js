'use strict';
// ══════════════════════════════════════════════════════════════════
//  LOOM SENSORS — services/loomSensor.js
//
//  From the board on the loom (its own key, no login):
//    POST /api/v2/loom-sensor/reading     X-Device-Key: <keyId>.<secret>
//         { runSecondsTotal, picksTotal?, running?, at?, firmware? }
//         or { readings: [ … ], firmware? } — what it buffered offline
//
//  For the admin:
//    GET    /api/v2/loom-sensor/devices             every sensor, live or not
//    POST   /api/v2/loom-sensor/devices             { machine, name } → the key, once
//    POST   /api/v2/loom-sensor/devices/:id/key     a new key, once; the old stops
//    DELETE /api/v2/loom-sensor/devices/:id         stops taking its posts
//    GET    /api/v2/loom-sensor/run?machine=&date=&shift=   what it ran that shift
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/ErrorHandler');
const sensors = require('../services/loomSensor');

/** The board's route: authenticated by its key alone. */
const device = express.Router();
device.post('/', catchAsyncErrors(async (req, res, next) => {
  const key = req.get('X-Device-Key') || String(req.get('Authorization') || '').replace(/^Device\s+/i, '');
  const d = await sensors.deviceForKey(key);
  if (!d) return next(new ErrorHandler('Unknown or retired device key', 401));
  const out = await sensors.ingest(d, req.body || {});
  // The board sets its clock from this when it has no other.
  res.json({ success: true, ...out, serverTime: Math.floor(Date.now() / 1000) });
}));

/** The admin's routes (mounted behind the admin gate). */
const admin = express.Router();
admin.get('/devices', catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, devices: await sensors.listDevices() });
}));
admin.post('/devices', catchAsyncErrors(async (req, res) => {
  res.status(201).json({ success: true, ...(await sensors.addDevice(req.body || {}, req.user?._id)) });
}));
admin.post('/devices/:id/key', catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await sensors.rotateKey(req.params.id)) });
}));
admin.delete('/devices/:id', catchAsyncErrors(async (req, res) => {
  res.json({ success: true, device: await sensors.removeDevice(req.params.id) });
}));
admin.get('/run', catchAsyncErrors(async (req, res, next) => {
  const { machine, date, shift } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !['DAY', 'NIGHT'].includes(shift)) return next(new ErrorHandler('date (YYYY-MM-DD) and shift (DAY or NIGHT) are needed', 400));
  res.json({ success: true, run: await sensors.shiftRun(machine, { dateKey: date, shift }) });
}));

module.exports = { device, admin };

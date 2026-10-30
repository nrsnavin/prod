'use strict';
// ══════════════════════════════════════════════════════════════════
//  FLOOR ENTRY — opened with a shift PIN, not a login
//
//    POST /api/v2/floor/open            { dateKey, shift, pin, name } → token + state
//    GET  /api/v2/floor/shift            the shift: looms, plan, operators
//    GET  /api/v2/floor/machine?code=…   one loom, by QR label / ID
//    POST /api/v2/floor/operator         { machine, operator } — puts the loom on the
//                                        shift; the first one makes the plan when
//                                        nobody did
//    POST /api/v2/floor/entry            { detailId, production, timer, feedback, operator }
//    POST /api/v2/floor/complete         { force? } — "Create shift plan": the looms noted
//                                        become the plan, free looms written on it; refused
//                                        with looms still to enter unless forced
//    POST /api/v2/floor/timer-photo      multipart photo + detailId → reading
//    POST /api/v2/floor/timer-photo/:photoId/use { runTime }
//    GET  /api/v2/floor/previous-timer-photo?machine=<id>
//                                        the loom's timer photo from the shift before
//    GET  /api/v2/floor/timer-photo/:photoId/file  the photo (this shift's or the one before);
//                                        takes the token as ?floorToken= too, for an <img>
//
//  Every route but /open takes the token in `X-Floor-Token`, scoped to
//  one date and shift. See services/floorEntry.js.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/ErrorHandler');
const { validate, z } = require('../middleware/validate');
const floor = require('../services/floorEntry');
const { keepAndReadTimerPhoto, markPhotoUsed, asRunTime } = require('../services/timerPhotoRead');
const ShiftDetail = require('../models/ShiftDetail');
const TimerPhoto = require('../models/TimerPhoto');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

/** The floor session, from the header; 401 with the reason otherwise. */
const floorAuth = catchAsyncErrors(async (req, res, next) => {
  const token = req.get('X-Floor-Token') || req.query.floorToken;
  req.floor = await floor.sessionFromToken(token);
  next();
});

router.post(
  '/open',
  validate({ body: z.object({
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shift: z.enum(['DAY', 'NIGHT']),
    pin: z.string().max(8),
    name: z.string().max(60),
  }) }),
  catchAsyncErrors(async (req, res) => {
    const out = await floor.openFloor({ ...req.body, ip: req.ip || '' });
    res.json({ success: true, token: out.token, session: out.session, state: out.state });
  })
);

router.use(floorAuth);

router.get('/shift', catchAsyncErrors(async (req, res) => {
  res.json({ success: true, session: req.floor, state: await floor.shiftState(req.floor) });
}));

router.get('/machine', catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await floor.machineForShift(req.floor, req.query.code)) });
}));

router.post(
  '/operator',
  validate({ body: z.object({ machine: z.string(), operator: z.string() }) }),
  catchAsyncErrors(async (req, res) => {
    const out = await floor.setOperator(req.floor, req.body);
    res.json({ success: true, ...out });
  })
);

router.post(
  '/entry',
  validate({ body: z.object({
    detailId: z.string(),
    production: z.union([z.number(), z.string()]),
    timer: z.string().max(12).nullable().optional(),
    feedback: z.string().max(500).optional(),
    operator: z.string().nullable().optional(),
  }) }),
  catchAsyncErrors(async (req, res) => {
    const out = await floor.enterProduction(req.floor, req.body);
    const { plan, machine } = await floor.machineForShift(req.floor, out.machineId);
    res.json({ success: true, ...out, machine, plan });
  })
);

router.post(
  '/complete',
  validate({ body: z.object({ force: z.boolean().optional() }) }),
  catchAsyncErrors(async (req, res) => {
    const out = await floor.completeFloorPlan(req.floor, { force: !!req.body.force });
    res.json({ success: true, ...out });
  })
);

/** The entry this photo is for has to be on the open shift. */
async function detailOnShift(session, detailId) {
  if (!mongoose.isValidObjectId(String(detailId))) return null;
  const plan = await floor.findPlan(session.dateKey, session.shift);
  if (!plan) return null;
  return ShiftDetail.findOne({ _id: detailId, shiftPlan: plan._id }).select('_id').lean();
}

router.post(
  '/timer-photo',
  (req, res, next) => upload.single('photo')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new ErrorHandler('That photo is too large (over 8 MB). Try again with a smaller one.', 400));
    return next(err);
  }),
  catchAsyncErrors(async (req, res, next) => {
    let shiftId = null;
    if (req.body?.detailId) {
      const d = await detailOnShift(req.floor, req.body.detailId);
      if (!d) return next(new ErrorHandler('That loom is not on this shift. Scan it again.', 404));
      shiftId = d._id;
    }
    const out = await keepAndReadTimerPhoto({ file: req.file, shiftId, uploadedBy: null, uploadedByName: req.floor.name, refId: null });
    res.json({ success: true, available: true, ...out });
  })
);

router.post(
  '/timer-photo/:photoId/use',
  validate({ body: z.object({ runTime: z.string().max(12) }) }),
  catchAsyncErrors(async (req, res, next) => {
    const runTime = asRunTime(req.body.runTime);
    if (!runTime) return next(new ErrorHandler('runTime must look like 7:45:00', 400));
    if (!mongoose.isValidObjectId(req.params.photoId)) return next(new ErrorHandler('Photo not found', 404));
    const photo = await TimerPhoto.findById(req.params.photoId).select('shift').lean();
    if (!photo || !(await detailOnShift(req.floor, photo.shift))) return next(new ErrorHandler('Photo not found', 404));
    await markPhotoUsed(photo._id, runTime, { decidedBy: null });
    res.json({ success: true });
  })
);

router.get('/previous-timer-photo', catchAsyncErrors(async (req, res) => {
  res.json({ success: true, previous: await floor.previousTimerPhoto(req.floor, req.query.machine) });
}));

router.get(
  '/timer-photo/:photoId/file',
  catchAsyncErrors(async (req, res, next) => {
    const photo = await floor.photoOnFloor(req.floor, req.params.photoId);
    if (!photo) return next(new ErrorHandler('Photo not found', 404));
    const buffer = Buffer.from(String(photo.data).split(',', 2)[1] || '', 'base64');
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  })
);

module.exports = router;

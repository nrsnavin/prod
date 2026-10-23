'use strict';

// ══════════════════════════════════════════════════════════════════
//  PHOTO READINGS FOR PRODUCTION ENTRY
//
//    POST /api/v2/ocr/timer               multipart "photo" (+ "shiftId")
//      → { available, reading: { displays, primary, problem }, suggestionId, photoId }
//    POST /api/v2/ocr/timer/:id/settle    { runTime: "H:MM:SS" }
//      → records what the person actually used, against what was read
//    POST /api/v2/ocr/timer/photo/:photoId/use   { runTime }
//      → marks the photo the run time was filled from, and settles its reading
//    GET  /api/v2/ocr/timer/shift/:shiftId/photos
//      → the timer photos kept for a shift, newest first (no bytes)
//    GET  /api/v2/ocr/timer/photo/:photoId/file
//      → the photo itself
//
//  Open to anyone who enters production: a worker on their own shift, a
//  supervisor on the floor (mounted behind the production/accounts role
//  gate in app.js; reading a photo is limited per person per hour). A
//  worker only ever reaches their own shifts' photos.
//
//  With a shiftId, the photo is KEPT with the shift (models/TimerPhoto.js)
//  so the person verifying the entry can see the display the run time
//  came from. It is saved before it is read, so a photo taken while
//  reading is unavailable is still there for the supervisor. Nothing
//  about the shift's own figures changes here: those are saved by the
//  shift's own routes, after the person confirms them.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/ErrorHandler');
const ledger = require('../services/aiLedger');
const { keepAndReadTimerPhoto, markPhotoUsed, asRunTime } = require('../services/timerPhotoRead');
const { validate, z } = require('../middleware/validate');
const { isSelfServiceOnly } = require('../utils/features');
const ShiftDetail = require('../models/ShiftDetail');
const TimerPhoto = require('../models/TimerPhoto');

const router = express.Router();
const SURFACE = 'timer-ocr';

// The web app shrinks a photo to ~1600 px before sending (a few hundred
// KB); the limit is for a phone that sends the original.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});


/**
 * The shift, if this person may attach photos to it or see its photos:
 * a worker their own shifts only, anyone else who enters production any
 * shift. Someone else's shift is "not found", like one that doesn't exist.
 */
async function reachableShift(req, shiftId) {
  if (!mongoose.isValidObjectId(String(shiftId))) return null;
  const q = { _id: shiftId };
  if (isSelfServiceOnly(req.user)) q.employee = req.user.employee;
  return ShiftDetail.findOne(q).select('_id').lean();
}

const photoMeta = (p) => ({
  id: String(p._id),
  takenAt: p.createdAt,
  takenBy: p.uploadedByName || null,
  size: p.size,
  readText: p.readText,
  readKind: p.readKind,
  readProblem: p.readProblem,
  used: !!p.used,
  runTimeUsed: p.runTimeUsed,
});

router.post(
  '/timer',
  (req, res, next) => upload.single('photo')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new ErrorHandler('That photo is too large (over 8 MB). Try again with a smaller one.', 400));
    return next(err);
  }),
  catchAsyncErrors(async (req, res, next) => {
    if (!req.file) return next(new ErrorHandler('Attach a photo of the timer', 400));

    // The shift, if given, has to be one this person may reach.
    let shiftId = null;
    if (req.body?.shiftId) {
      const shift = await reachableShift(req, req.body.shiftId);
      if (!shift) return next(new ErrorHandler('Shift not found', 404));
      shiftId = shift._id;
    }
    let out;
    try {
      out = await keepAndReadTimerPhoto({
        file: req.file, shiftId, uploadedBy: req.user?._id ?? null, uploadedByName: req.user?.name ?? '', refId: req.user?._id,
      });
    } catch (err) {
      return next(err);
    }
    const { reading, suggestionId, photoId } = out;
    res.json({ success: true, available: true, reading, suggestionId, photoId });
  })
);

router.post(
  '/timer/:id/settle',
  validate({ body: z.object({ runTime: z.string().max(12) }) }),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new ErrorHandler('Unknown reading', 404));
    if (!asRunTime(req.body.runTime)) return next(new ErrorHandler('runTime must look like 7:45:00', 400));
    await ledger.settle(req.params.id, {
      accepted: { runTime: asRunTime(req.body.runTime) },
      decidedBy: req.user?._id,
      expectSurface: SURFACE,
      // Only the run time is compared: the display's raw text and kind
      // were never something the person was asked to accept.
      ignoreMissing: true,
    });
    res.json({ success: true });
  })
);

router.post(
  '/timer/photo/:photoId/use',
  validate({ body: z.object({ runTime: z.string().max(12) }) }),
  catchAsyncErrors(async (req, res, next) => {
    const runTime = asRunTime(req.body.runTime);
    if (!runTime) return next(new ErrorHandler('runTime must look like 7:45:00', 400));
    if (!mongoose.isValidObjectId(req.params.photoId)) return next(new ErrorHandler('Photo not found', 404));
    const photo = await TimerPhoto.findById(req.params.photoId).select('shift suggestion').lean();
    if (!photo || !(await reachableShift(req, photo.shift))) return next(new ErrorHandler('Photo not found', 404));

    await markPhotoUsed(photo._id, runTime, { decidedBy: req.user?._id });
    res.json({ success: true });
  })
);

router.get(
  '/timer/shift/:shiftId/photos',
  catchAsyncErrors(async (req, res, next) => {
    const shift = await reachableShift(req, req.params.shiftId);
    if (!shift) return next(new ErrorHandler('Shift not found', 404));
    const photos = await TimerPhoto.find({ shift: shift._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ success: true, photos: photos.map(photoMeta) });
  })
);

router.get(
  '/timer/photo/:photoId/file',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.photoId)) return next(new ErrorHandler('Photo not found', 404));
    const photo = await TimerPhoto.findById(req.params.photoId).select('+data shift contentType').lean();
    if (!photo || !(await reachableShift(req, photo.shift))) return next(new ErrorHandler('Photo not found', 404));
    const base64 = String(photo.data).split(',', 2)[1] || '';
    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Content-Length', buffer.length);
    // A photo never changes once taken; private, since it is behind a login.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  })
);

module.exports = router;
module.exports._asRunTime = asRunTime;

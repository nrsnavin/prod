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
const { readTimerPhoto } = require('../utils/timerOcr');
const { PROMPTS } = require('../utils/aiPrompts');
const ledger = require('../services/aiLedger');
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

/** "7:45" / "07:45:12" → "H:MM:SS"; anything else (a meter's 1234.6) → null. */
function asRunTime(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
  return m ? `${Number(m[1])}:${m[2]}:${m[3] ?? '00'}` : null;
}

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

    // Kept with the shift first, so it is there for verification
    // whatever happens to the reading.
    let photo = null;
    const shiftId = req.body?.shiftId;
    if (shiftId) {
      const shift = await reachableShift(req, shiftId);
      if (!shift) return next(new ErrorHandler('Shift not found', 404));
      if (!TimerPhoto.ALLOWED_CONTENT_TYPES.includes(req.file.mimetype)) {
        return next(new ErrorHandler('Use a JPEG, PNG or WEBP photo.', 400));
      }
      photo = await TimerPhoto.create({
        shift: shift._id,
        contentType: req.file.mimetype,
        size: req.file.size,
        data: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
        uploadedBy: req.user?._id ?? null,
        uploadedByName: req.user?.name ?? '',
        expiresAt: TimerPhoto.expiryFrom(),
      });
    }
    const photoId = photo ? String(photo._id) : null;
    const keep = (err) => {
      // The caller can say the photo was kept even though it wasn't read.
      if (photoId) {
        if (typeof err.code !== 'string') err.code = 'NOT_READ';
        err.details = { ...(err.details || {}), photoId };
      }
      return err;
    };

    let result;
    try {
      result = await readTimerPhoto(req.file.buffer, req.file.mimetype);
    } catch (err) {
      if (photo) await TimerPhoto.updateOne({ _id: photo._id }, { readProblem: 'not_read' });
      return next(keep(err));
    }
    if (!result.available) {
      if (photo) await TimerPhoto.updateOne({ _id: photo._id }, { readProblem: 'not_set_up' });
      const err = new ErrorHandler("Reading photos isn't set up on this server. Type the run time instead.", 503);
      err.code = 'AI_UNAVAILABLE';
      return next(keep(err));
    }

    const { reading } = result;
    const primary = reading.primary != null ? reading.displays[reading.primary] : null;
    const suggestionId = await ledger.record({
      surface: SURFACE,
      model: result.model,
      promptVersion: PROMPTS[SURFACE]?.version,
      refType: 'user',
      refId: req.user?._id,
      // What the field would be filled with if nobody changed anything.
      proposed: { runTime: asRunTime(primary?.text), text: primary?.text ?? null, kind: primary?.kind ?? null },
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
    if (photo) {
      await TimerPhoto.updateOne({ _id: photo._id }, {
        readText: primary?.text ?? null,
        readKind: primary?.kind ?? null,
        readProblem: reading.problem ?? null,
        suggestion: suggestionId && mongoose.isValidObjectId(String(suggestionId)) ? suggestionId : null,
      });
    }

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

    // One photo per shift is the one the run time came from: the latest used.
    await TimerPhoto.updateMany({ shift: photo.shift, _id: { $ne: photo._id }, used: true }, { used: false });
    await TimerPhoto.updateOne({ _id: photo._id }, { used: true, runTimeUsed: runTime, usedAt: new Date() });
    if (photo.suggestion) {
      await ledger.settle(String(photo.suggestion), {
        accepted: { runTime },
        decidedBy: req.user?._id,
        expectSurface: SURFACE,
        ignoreMissing: true,
      });
    }
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

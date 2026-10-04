'use strict';

// ══════════════════════════════════════════════════════════════════
//  PHOTO READINGS FOR PRODUCTION ENTRY
//
//    POST /api/v2/ocr/timer               multipart "photo"
//      → { available, reading: { displays, primary, problem }, suggestionId }
//    POST /api/v2/ocr/timer/:id/settle    { runTime: "H:MM:SS" }
//      → records what the person actually used, against what was read
//
//  Open to anyone who enters production: a worker on their own shift, a
//  supervisor on the floor (mounted behind the production/accounts role
//  gate and a per-person hourly limit in app.js). Nothing is saved to a
//  shift here: the reading only fills a field the person then confirms,
//  and the shift is saved by its own route. The photo itself is not
//  kept; only the reading is recorded, for the AI accuracy report.
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

router.post(
  '/timer',
  (req, res, next) => upload.single('photo')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new ErrorHandler('That photo is too large (over 8 MB). Try again with a smaller one.', 400));
    return next(err);
  }),
  catchAsyncErrors(async (req, res, next) => {
    if (!req.file) return next(new ErrorHandler('Attach a photo of the timer', 400));

    const result = await readTimerPhoto(req.file.buffer, req.file.mimetype);
    if (!result.available) {
      const err = new ErrorHandler("Reading photos isn't set up on this server. Type the run time instead.", 503);
      err.code = 'AI_UNAVAILABLE';
      return next(err);
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

    res.json({ success: true, available: true, reading, suggestionId });
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

module.exports = router;
module.exports._asRunTime = asRunTime;

'use strict';
// ══════════════════════════════════════════════════════════════════
//  KEEP A TIMER PHOTO WITH ITS SHIFT, AND READ IT
//
//  Shared by the signed-in route (api/timerOcr.js) and the floor-entry
//  screen (api/floor.js), which opens with a shift PIN rather than a
//  login. Both keep the photo with the shift first — so it is there for
//  verification whatever happens to the reading — then read it, and
//  record the reading on the ledger and on the photo.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const { readTimerPhoto } = require('../utils/timerOcr');
const { PROMPTS } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');
const TimerPhoto = require('../models/TimerPhoto');

const SURFACE = 'timer-ocr';

/** "7:45" / "07:45:12" → "H:MM:SS"; anything else (a meter's 1234.6) → null. */
function asRunTime(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
  return m ? `${Number(m[1])}:${m[2]}:${m[3] ?? '00'}` : null;
}

/**
 * @param {object} input
 *   file          multer file: buffer, mimetype, size
 *   shiftId       the shift to keep the photo with, already checked reachable; or null
 *   uploadedBy    user id or null
 *   uploadedByName
 *   refId         who the ledger row is about (a user id, or null for the floor)
 * @returns {{ reading, suggestionId, photoId }}
 * @throws ErrorHandler — with details.photoId when the photo was kept but not read
 */
async function keepAndReadTimerPhoto({ file, shiftId = null, uploadedBy = null, uploadedByName = '', refId = null }) {
  if (!file) throw new ErrorHandler('Attach a photo of the timer', 400);

  let photo = null;
  if (shiftId) {
    if (!TimerPhoto.ALLOWED_CONTENT_TYPES.includes(file.mimetype)) {
      throw new ErrorHandler('Use a JPEG, PNG or WEBP photo.', 400);
    }
    photo = await TimerPhoto.create({
      shift: shiftId,
      contentType: file.mimetype,
      size: file.size,
      data: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
      uploadedBy,
      uploadedByName,
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
    result = await readTimerPhoto(file.buffer, file.mimetype);
  } catch (err) {
    if (photo) await TimerPhoto.updateOne({ _id: photo._id }, { readProblem: 'not_read' });
    throw keep(err);
  }
  if (!result.available) {
    if (photo) await TimerPhoto.updateOne({ _id: photo._id }, { readProblem: 'not_set_up' });
    const err = new ErrorHandler("Reading photos isn't set up on this server. Type the run time instead.", 503);
    err.code = 'AI_UNAVAILABLE';
    throw keep(err);
  }

  const { reading } = result;
  const primary = reading.primary != null ? reading.displays[reading.primary] : null;
  const suggestionId = await ledger.record({
    surface: SURFACE,
    model: result.model,
    promptVersion: PROMPTS[SURFACE]?.version,
    refType: 'user',
    refId,
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
  return { reading, suggestionId, photoId };
}

/** The photo the run time came from; settles its reading too. */
async function markPhotoUsed(photoId, runTime, { decidedBy = null } = {}) {
  const photo = await TimerPhoto.findById(photoId).select('shift suggestion').lean();
  if (!photo) return null;
  // One photo per shift is the one the run time came from: the latest used.
  await TimerPhoto.updateMany({ shift: photo.shift, _id: { $ne: photo._id }, used: true }, { used: false });
  await TimerPhoto.updateOne({ _id: photo._id }, { used: true, runTimeUsed: runTime, usedAt: new Date() });
  if (photo.suggestion) {
    await ledger.settle(String(photo.suggestion), {
      accepted: { runTime }, decidedBy, expectSurface: SURFACE, ignoreMissing: true,
    });
  }
  return photo;
}

module.exports = { keepAndReadTimerPhoto, markPhotoUsed, asRunTime, SURFACE };

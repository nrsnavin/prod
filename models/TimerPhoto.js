'use strict';
// ══════════════════════════════════════════════════════════════════
//  TIMER PHOTO
//  File: models/TimerPhoto.js
//
//  A photo of a loom's timer taken while entering a shift's production
//  (api/timerOcr.js), kept with the shift so whoever verifies the entry
//  can see the display the run time was read from, instead of taking
//  the number on trust.
//
//  Every photo taken for a shift is kept, not only the one whose reading
//  was used: a retake is part of the story ("the first was blurry"),
//  and a photo taken when reading wasn't available is still evidence.
//  `used` marks the one the run time came from.
//
//  Its own collection with the bytes as a base64 data URL, like
//  SamplePhoto and MachineServiceBill: this deployment has no object
//  storage, and a shift document must not grow by a photo each retake.
//  The web app shrinks a photo to ~1600 px before sending, a few hundred
//  KB. `expiresAt` lets MongoDB drop old photos on its own (TTL index);
//  how long they are kept is TIMER_PHOTO_RETENTION_DAYS (default 180,
//  0 = forever), long after any shift is verified.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const TimerPhotoSchema = new mongoose.Schema(
  {
    shift: { type: mongoose.Types.ObjectId, ref: 'ShiftDetail', required: true, index: true },

    contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, required: true },
    /** Bytes of the file as received, before base64 inflation. */
    size: { type: Number, required: true, min: 0 },
    /** data:<mime>;base64,<payload> */
    data: { type: String, required: true, select: false },

    uploadedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },

    /** What was read off the display, if reading was available. */
    readText: { type: String, default: null },
    readKind: { type: String, default: null },
    /** Why nothing could be read: a photo problem, or reading not set up. */
    readProblem: { type: String, default: null },
    /** The AI ledger entry for the reading, to settle when it is used. */
    suggestion: { type: mongoose.Types.ObjectId, ref: 'AiSuggestion', default: null },

    /** The run time filled in from this photo ("Use this"). */
    used: { type: Boolean, default: false },
    runTimeUsed: { type: String, default: null },
    usedAt: { type: Date, default: null },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TimerPhotoSchema.index({ shift: 1, createdAt: -1 });
// MongoDB deletes a photo once expiresAt passes; null never expires.
TimerPhotoSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** When a photo taken now should be dropped, or null to keep it. */
function expiryFrom(now = new Date(), days = process.env.TIMER_PHOTO_RETENTION_DAYS) {
  const n = days === undefined || days === '' ? 180 : Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() + n * 86_400_000);
}

const TimerPhoto = mongoose.model('TimerPhoto', TimerPhotoSchema);

module.exports = TimerPhoto;
module.exports.ALLOWED_CONTENT_TYPES = ALLOWED_CONTENT_TYPES;
module.exports.expiryFrom = expiryFrom;

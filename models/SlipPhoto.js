'use strict';
// A photo of a production slip, kept with the slip so whoever checks
// the values can see what was read. Bytes live here rather than on the
// slip so listing slips never drags photos along.

const mongoose = require('mongoose');

const SlipPhotoSchema = new mongoose.Schema(
  {
    slip: { type: mongoose.Types.ObjectId, ref: 'SlipIngest', required: true, index: true },
    page: { type: Number, required: true, min: 0 },
    contentType: { type: String, required: true },
    /** Bytes of the file as received, before base64 inflation. */
    size: { type: Number, required: true, min: 0 },
    /** Base64 of the file. */
    data: { type: String, required: true, select: false },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SlipPhotoSchema.index({ slip: 1, page: 1 }, { unique: true });
SlipPhotoSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** When a photo kept now should be dropped, or null to keep it. */
function expiryFrom(now = new Date(), days = process.env.SLIP_PHOTO_RETENTION_DAYS) {
  let n = days === undefined || days === '' ? 365 : Number(days);
  if (!Number.isFinite(n)) n = 365;
  if (n <= 0) return null;
  return new Date(now.getTime() + n * 86_400_000);
}

module.exports = mongoose.model('SlipPhoto', SlipPhotoSchema);
module.exports.expiryFrom = expiryFrom;

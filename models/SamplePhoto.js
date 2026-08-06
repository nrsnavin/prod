'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAMPLE PHOTO
//  File: models/SamplePhoto.js
//
//  A photo attached to a sample request — the shade card, the trial off
//  the loom, the customer's own swatch held next to ours. Half of what a
//  sample file is for cannot be written in words.
//
//  Its OWN collection, not an array on the request, for the same reason
//  MachineServiceBill is its own: with the bytes inline, a sample that
//  goes through a dozen trials marches toward MongoDB's 16 MB document
//  limit and starts failing saves on an unrelated write — and every list
//  query drags megabytes it never displays. Out here the blob is bounded
//  per PHOTO, and the request stays a document you can read.
//
//  Stored as a base64 data URL, matching QcRecord photos, the document
//  logo and the service bills: this deployment has no object storage. If
//  S3 arrives, `data` becomes a key and only this model plus the file
//  route change.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/** Phone photos and screenshots. Not a general file drop. */
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
];

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SamplePhotoSchema = new mongoose.Schema(
  {
    sample: {
      type: mongoose.Types.ObjectId,
      ref: 'SampleRequest',
      required: true,
      index: true,
    },
    /** _id of the log entry this photo arrived with. */
    logEntry: { type: mongoose.Types.ObjectId, default: null },

    caption: { type: String, trim: true, default: '' },
    filename: { type: String, trim: true, default: '' },
    contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, required: true },
    /** Bytes of the original file, before base64 inflation. */
    size: { type: Number, required: true, min: 0 },
    /** data:<mime>;base64,<payload> — emptied when the photo is removed. */
    data: { type: String, default: '' },

    uploadedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },

    // Removal is a tombstone, never a delete. The log said a photo was
    // put here; erasing the row would make that entry point at nothing
    // and quietly rewrite what the file says happened.
    removedAt: { type: Date, default: null },
    removedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    removalReason: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

SamplePhotoSchema.index({ sample: 1, createdAt: 1 });

const SamplePhoto = mongoose.model('SamplePhoto', SamplePhotoSchema);

module.exports = SamplePhoto;
module.exports.ALLOWED_CONTENT_TYPES = ALLOWED_CONTENT_TYPES;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;

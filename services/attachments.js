'use strict';
// Attaching a file to an accounts document and reading it back. New
// files go to their own AccountFile document; older ones carried their
// bytes inline as a data URL and are still read from there.

const AccountFile = require('../models/AccountFile');
const ErrorHandler = require('../utils/ErrorHandler');
const { ATTACHMENT_TYPES } = require('../models/accountsShared');

const MAX_PER_DOC = 5;

/** @returns the attachment's public fields */
async function attach(Model, kind, id, file) {
  if (!file) throw new ErrorHandler('Attach a file (image or PDF)', 400);
  if (!ATTACHMENT_TYPES.includes(file.mimetype)) throw new ErrorHandler('Only JPEG, PNG, WebP or PDF', 400);
  const doc = await Model.findById(id).select('attachments').lean();
  if (!doc) throw new ErrorHandler('Not found', 404);
  if ((doc.attachments || []).length >= MAX_PER_DOC) throw new ErrorHandler(`At most ${MAX_PER_DOC} attachments`, 400);
  const stored = await AccountFile.create({ contentType: file.mimetype, size: file.size, filename: file.originalname || '', data: file.buffer, owner: { kind, id } });
  const meta = { filename: file.originalname || '', contentType: file.mimetype, size: file.size, file: stored._id, uploadedAt: new Date() };
  // Conditional on the count, so two uploads at once cannot make six.
  const res = await Model.findOneAndUpdate(
    { _id: id, [`attachments.${MAX_PER_DOC - 1}`]: { $exists: false } },
    { $push: { attachments: meta } },
    { new: true, projection: { attachments: { $slice: -1 } } }
  ).lean();
  if (!res) { await AccountFile.deleteOne({ _id: stored._id }); throw new ErrorHandler(`At most ${MAX_PER_DOC} attachments`, 400); }
  const a = res.attachments[res.attachments.length - 1];
  return { _id: a._id, filename: a.filename, contentType: a.contentType, size: a.size, uploadedAt: a.uploadedAt };
}

/** @returns { contentType, filename, buffer } or null */
async function read(Model, id, aid) {
  const doc = await Model.findById(id).select('attachments').lean();
  const a = doc?.attachments?.find((x) => String(x._id) === String(aid));
  if (!a) return null;
  if (a.file) {
    const f = await AccountFile.findById(a.file).lean();
    if (!f) return null;
    return { contentType: f.contentType, filename: a.filename, buffer: Buffer.from(f.data.buffer || f.data) };
  }
  const base64 = String(a.data || '').split(',')[1] || '';
  return { contentType: a.contentType, filename: a.filename, buffer: Buffer.from(base64, 'base64') };
}

module.exports = { attach, read, MAX_PER_DOC };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAMPLE REQUEST API  —  /api/v2/sample
//
//  Reading:
//    GET  /sample            paged list + a count per status for the tabs
//    GET  /sample/:id        one request with its whole log
//
//  Writing:
//    POST /sample            raise a request (opens the log)
//    POST /sample/:id/log    append an update
//    POST /sample/:id/photo  attach a photo (multipart, field "photo")
//    PUT  /sample/:id/status ADMIN — completed / closed / reopen
//    DELETE /sample/photo/:photoId  ADMIN — tombstone a photo, with a reason
//
//  Photos:
//    GET  /sample/photo/:photoId/file   the bytes
//
//  The request itself is written once and never edited. Everything that
//  happens to it afterwards is an appended log entry carrying its author
//  and time, because the question a sample file has to answer months
//  later is "what did we tell them, and when" — and a record whose
//  fields can be rewritten in place cannot answer it.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
// multer finishes from a stream event, which loses the request's
// AsyncLocalStorage stores — the database it routes to and the user
// it audits as. See middleware/userContext.js.
const { keepRequestContext } = require("../middleware/userContext.js");
const router = express.Router();

const catchAsyncErrors = require('../middleware/catchAsyncErrors.js');
const ErrorHandler = require('../utils/ErrorHandler.js');
const { isAdmin } = require('../middleware/auth.js');
const { escapeRegex } = require('../utils/escapeRegex.js');
const { requireReason } = require('../utils/auditReason.js');
const { nextNumber } = require('../utils/sequence.js');
const Customer = require('../models/Customer.js');
const SampleRequest = require('../models/SampleRequest.js');
const SamplePhoto = require('../models/SamplePhoto.js');

const {
  SAMPLE_STATUSES,
  TERMINAL_STATUSES,
  PRIORITIES,
} = SampleRequest;

const { ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES } = SamplePhoto;

// Buffered in memory, then written to the photo document as a data URL.
// multer's own limit is the first line of defence, so an oversized file
// is refused before it is fully read.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

/** multer reports its limits as a MulterError, which is a 400, not a 500. */
function handlePhotoUpload(req, res, next) {
  keepRequestContext(photoUpload.single('photo'))(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `That photo is too large — the limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`
        : `Upload rejected: ${err.message}`;
      return next(new ErrorHandler(message, 400));
    }
    return next(err);
  });
}

/** Extension → type, for clients that do not label the part. */
const EXTENSION_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
};

/**
 * The type of an uploaded photo, or null if it is not one we take.
 *
 * multer reports whatever content type the client put on the multipart
 * part, and plenty of clients put nothing — Dio's MultipartFile defaults
 * every part to application/octet-stream unless the caller passes a
 * media type, and which class that is moved between Dio releases. A
 * mobile app that cannot name its own JPEG is not a reason to refuse the
 * photo, so an unlabelled part falls back to its extension. Both routes
 * end at the same allow-list, and an unrecognised extension is still
 * refused.
 */
function resolveImageType(file) {
  const declared = String(file.mimetype || '').toLowerCase();
  if (ALLOWED_CONTENT_TYPES.includes(declared)) return declared;

  const unlabelled = !declared
    || declared === 'application/octet-stream'
    || declared === 'binary/octet-stream';
  if (!unlabelled) return null;

  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  return EXTENSION_TYPES[ext] ?? null;
}

/** Metadata only — the bytes are never in a list response. */
const photoMeta = (p) => ({
  _id: p._id,
  caption: p.caption || '',
  filename: p.filename || '',
  contentType: p.contentType,
  size: p.size,
  uploadedByName: p.uploadedByName || '',
  createdAt: p.createdAt,
  removed: Boolean(p.removedAt),
  removedAt: p.removedAt ?? null,
  removalReason: p.removalReason || '',
});

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

/** Long enough to hold a spec, short enough not to be an upload channel. */
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
/** A sample nobody would ever ask for — catches a slipped decimal point. */
const MAX_QUANTITY = 1_000_000;

const actor = (req) => ({
  by: req.user?._id,
  byName: req.user?.name || req.user?.username || '',
});

/** Trim, reject empties, and cap — one place, so no field escapes it. */
function text(value, { label, max = MAX_TEXT, required = false }) {
  if (value === undefined || value === null || value === '') {
    if (required) return { ok: false, reason: `${label} is required` };
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false, reason: `${label} must be text` };
  const t = value.trim();
  if (required && t.length === 0) return { ok: false, reason: `${label} is required` };
  if (t.length > max) return { ok: false, reason: `${label} is too long (max ${max} characters)` };
  return { ok: true, value: t };
}

/** What the client sees. The log is ordered oldest-first — it is a story. */
function shape(doc) {
  return {
    _id: doc._id,
    sampleNo: doc.sampleNo,
    title: doc.title,
    customer: doc.customer && typeof doc.customer === 'object'
      ? { _id: doc.customer._id, name: doc.customer.name }
      : (doc.customer || null),
    customerName: doc.customerName || (typeof doc.customer === 'object' ? doc.customer?.name : '') || '',
    details: doc.details,
    quantity: doc.quantity ?? 0,
    targetDate: doc.targetDate ?? null,
    priority: doc.priority,
    status: doc.status,
    raisedByName: doc.raisedByName || '',
    closedAt: doc.closedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    logCount: (doc.log || []).length,
    // Counted off the log rather than joined from the photo collection:
    // the list would otherwise pay a lookup per row for a badge.
    photoCount: (doc.log || []).filter((e) => e.kind === 'photo').length
      - (doc.log || []).filter((e) => e.kind === 'photo_removed').length,
    // The last thing that happened, so a list row can say something more
    // useful than a date.
    lastEntry: (doc.log || []).length
      ? (() => {
        const e = doc.log[doc.log.length - 1];
        return { kind: e.kind, note: e.note, status: e.status, byName: e.byName, at: e.at };
      })()
      : null,
  };
}

function shapeDetail(doc, photos = []) {
  return {
    ...shape(doc),
    photos: photos.map(photoMeta),
    log: (doc.log || []).map((e) => ({
      _id: e._id,
      kind: e.kind,
      note: e.note,
      status: e.status ?? null,
      fromStatus: e.fromStatus ?? null,
      // The entry names its photo; the bytes are fetched by id from the
      // file route, so a log with fifty photos is still one small JSON.
      photo: e.photo ?? null,
      byName: e.byName || '',
      at: e.at,
    })),
  };
}

/** The photos of one sample, oldest first — the order they were taken. */
const photosOf = (sampleId) =>
  SamplePhoto.find({ sample: sampleId }).select('-data').sort({ createdAt: 1 }).lean();

// ── Raise a request ──────────────────────────────────────────────
router.post(
  '/',
  catchAsyncErrors(async (req, res, next) => {
    const title = text(req.body.title, { label: 'Title', max: MAX_TITLE, required: true });
    if (!title.ok) return next(new ErrorHandler(title.reason, 400));

    const details = text(req.body.details, { label: 'Details', required: true });
    if (!details.ok) return next(new ErrorHandler(details.reason, 400));

    const customerName = text(req.body.customerName, { label: 'Customer name', max: MAX_TITLE });
    if (!customerName.ok) return next(new ErrorHandler(customerName.reason, 400));

    const note = text(req.body.note, { label: 'Note' });
    if (!note.ok) return next(new ErrorHandler(note.reason, 400));

    let customer = null;
    let nameSnapshot = customerName.value;
    if (req.body.customerId) {
      if (!mongoose.Types.ObjectId.isValid(String(req.body.customerId))) {
        return next(new ErrorHandler('customerId is not a valid id', 400));
      }
      const found = await Customer.findById(req.body.customerId, 'name').lean();
      if (!found) return next(new ErrorHandler('Customer not found', 404));
      customer = found._id;
      // The snapshot follows the customer record when there is one, so a
      // renamed customer does not leave the sample naming somebody else.
      nameSnapshot = found.name || nameSnapshot;
    }

    // A sample for nobody in particular is a real thing (a trade fair
    // piece), so neither a customer nor a name is required — but one of
    // the two is worth having, and silence here is usually an omission.
    const quantity = req.body.quantity === undefined || req.body.quantity === null || req.body.quantity === ''
      ? 0
      : Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return next(new ErrorHandler('quantity must be a number of metres', 400));
    }
    if (quantity > MAX_QUANTITY) {
      return next(new ErrorHandler(`quantity looks wrong — over ${MAX_QUANTITY} m`, 400));
    }

    const priority = req.body.priority ?? 'normal';
    if (!PRIORITIES.includes(priority)) {
      return next(new ErrorHandler(`priority must be one of: ${PRIORITIES.join(', ')}`, 400));
    }

    let targetDate = null;
    if (req.body.targetDate) {
      targetDate = new Date(req.body.targetDate);
      if (Number.isNaN(targetDate.getTime())) {
        return next(new ErrorHandler('targetDate is not a valid date', 400));
      }
    }

    const sampleNo = await nextNumber('sampleNo', async () => {
      const last = await SampleRequest.findOne({}, 'sampleNo').sort({ sampleNo: -1 }).lean();
      return last?.sampleNo ?? 0;
    });

    const who = actor(req);
    const doc = await SampleRequest.create({
      sampleNo,
      title: title.value,
      customer: customer || undefined,
      customerName: nameSnapshot,
      details: details.value,
      quantity,
      targetDate,
      priority,
      status: 'open',
      raisedBy: who.by,
      raisedByName: who.byName,
      // The log opens with the raising itself, so entry one is never a
      // reply to something that is not there.
      log: [{
        kind: 'created',
        note: note.value,
        status: 'open',
        fromStatus: null,
        by: who.by,
        byName: who.byName,
        at: new Date(),
      }],
    });

    res.status(201).json({ success: true, sample: shapeDetail(doc.toObject()) });
  })
);

// ── The list ─────────────────────────────────────────────────────
router.get(
  '/',
  catchAsyncErrors(async (req, res, next) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));

    const filter = {};
    const status = req.query.status;
    if (status === 'active') filter.status = { $nin: TERMINAL_STATUSES };
    else if (SAMPLE_STATUSES.includes(status)) filter.status = status;

    const q = String(req.query.q ?? '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const or = [{ title: rx }, { customerName: rx }, { details: rx }];
      // "42" should find sample 42, not just the ones that mention it.
      if (/^\d+$/.test(q)) or.push({ sampleNo: Number(q) });
      filter.$or = or;
    }

    // ── One customer's samples ────────────────────────────────────
    // Matches on the LINK, not the name snapshot. A sample raised for
    // a prospect who was later added to the customer master keeps the
    // name it was typed with and has no link, so it is not this
    // customer's — matching on name would claim it, and would also
    // sweep up anybody whose name merely resembled theirs.
    //
    // An unparseable id returns nothing rather than everything: a
    // filter that silently stops filtering is how a screen ends up
    // showing one customer another customer's enquiries.
    const customerId = String(req.query.customerId ?? '').trim();
    let customerFilter = null;
    if (customerId) {
      if (!mongoose.Types.ObjectId.isValid(customerId)) {
        return next(new ErrorHandler('customerId is not a valid id', 400));
      }
      customerFilter = new mongoose.Types.ObjectId(customerId);
      filter.customer = customerFilter;
    }

    const [total, docs, byStatus] = await Promise.all([
      SampleRequest.countDocuments(filter),
      SampleRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('customer', 'name')
        .lean(),
      // Counts for the tabs ignore the SEARCH, deliberately — a tab that
      // reads 0 because the text query excluded it is a lie.
      //
      // They do NOT ignore the customer, and that distinction matters.
      // A search narrows which of a set you are looking at; a customer
      // filter changes WHICH SET. On a customer's own page, tabs
      // counting every sample in the mill would describe somebody
      // else's work, and "3 open" beside a customer with none is worse
      // than no number at all.
      SampleRequest.aggregate([
        ...(customerFilter ? [{ $match: { customer: customerFilter } }] : []),
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    const counts = { open: 0, in_progress: 0, completed: 0, closed: 0 };
    for (const row of byStatus) {
      if (row._id in counts) counts[row._id] = row.n;
    }

    res.status(200).json({
      success: true,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts,
      samples: docs.map(shape),
    });
  })
);

// ── One request, with its log ────────────────────────────────────
router.get(
  '/:id',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return next(new ErrorHandler('Sample request not found', 404));
    }
    const doc = await SampleRequest.findById(req.params.id)
      .populate('customer', 'name')
      .lean();
    if (!doc) return next(new ErrorHandler('Sample request not found', 404));
    res.status(200).json({ success: true, sample: shapeDetail(doc, await photosOf(doc._id)) });
  })
);

// ── Append an update ─────────────────────────────────────────────
router.post(
  '/:id/log',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return next(new ErrorHandler('Sample request not found', 404));
    }
    const note = text(req.body.note, { label: 'Update', required: true });
    if (!note.ok) return next(new ErrorHandler(note.reason, 400));

    const who = actor(req);
    const entry = {
      kind: 'update',
      note: note.value,
      status: null,
      fromStatus: null,
      by: who.by,
      byName: who.byName,
      at: new Date(),
    };

    // Appending is conditional on the request still being live, in the
    // same write that appends: a check-then-write would let an update
    // land a moment after an admin closed it.
    const doc = await SampleRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $nin: TERMINAL_STATUSES } },
      { $push: { log: entry } },
      { new: true }
    ).populate('customer', 'name').lean();

    if (!doc) {
      const exists = await SampleRequest.findById(req.params.id, 'status').lean();
      if (!exists) return next(new ErrorHandler('Sample request not found', 404));
      return next(new ErrorHandler(
        `This sample is ${exists.status}. Ask an admin to reopen it before adding an update.`,
        409
      ));
    }

    res.status(201).json({ success: true, sample: shapeDetail(doc, await photosOf(doc._id)) });
  })
);

// ── Attach a photo ───────────────────────────────────────────────
//
// Uploading is itself a log entry: a photo that arrives without a place
// in the story is a file nobody can date or attribute six weeks later.
router.post(
  '/:id/photo',
  handlePhotoUpload,
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return next(new ErrorHandler('Sample request not found', 404));
    }
    if (!req.file) {
      return next(new ErrorHandler('No photo uploaded (field name must be "photo").', 400));
    }
    const contentType = resolveImageType(req.file);
    if (!contentType) {
      return next(new ErrorHandler(
        `Unsupported file type "${req.file.mimetype}". Upload a photo (JPEG, PNG, WebP or HEIC).`,
        400
      ));
    }
    const caption = text(req.body.caption, { label: 'Caption', max: MAX_TITLE });
    if (!caption.ok) return next(new ErrorHandler(caption.reason, 400));

    const sample = await SampleRequest.findById(req.params.id, 'status').lean();
    if (!sample) return next(new ErrorHandler('Sample request not found', 404));
    if (TERMINAL_STATUSES.includes(sample.status)) {
      return next(new ErrorHandler(
        `This sample is ${sample.status}. Ask an admin to reopen it before adding photos.`,
        409
      ));
    }

    const who = actor(req);
    const photo = await SamplePhoto.create({
      sample: req.params.id,
      caption: caption.value,
      filename: req.file.originalname || '',
      contentType,
      size: req.file.size,
      data: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
      uploadedBy: who.by,
      uploadedByName: who.byName,
    });

    // The entry is appended conditionally, so a close landing between the
    // check above and this write cannot be written through.
    const doc = await SampleRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $nin: TERMINAL_STATUSES } },
      {
        $push: {
          log: {
            kind: 'photo',
            note: caption.value,
            status: null,
            fromStatus: null,
            photo: photo._id,
            by: who.by,
            byName: who.byName,
            at: new Date(),
          },
        },
      },
      { new: true }
    ).populate('customer', 'name').lean();

    if (!doc) {
      // Nothing points at those bytes now, and an orphan photo would show
      // up in the gallery of a sample whose log never mentions it.
      await SamplePhoto.findByIdAndDelete(photo._id);
      return next(new ErrorHandler(
        'This sample was closed while the photo was uploading. Ask an admin to reopen it.',
        409
      ));
    }

    // Link the photo back to the entry it arrived with.
    const entry = doc.log[doc.log.length - 1];
    await SamplePhoto.updateOne({ _id: photo._id }, { $set: { logEntry: entry._id } });

    res.status(201).json({
      success: true,
      photo: photoMeta(photo.toObject()),
      sample: shapeDetail(doc, await photosOf(doc._id)),
    });
  })
);

// ── The bytes ────────────────────────────────────────────────────
router.get(
  '/photo/:photoId/file',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.photoId))) {
      return next(new ErrorHandler('Photo not found', 404));
    }
    const photo = await SamplePhoto.findById(req.params.photoId).lean();
    if (!photo) return next(new ErrorHandler('Photo not found', 404));
    if (photo.removedAt || !photo.data) {
      return next(new ErrorHandler('This photo was removed', 410));
    }

    const base64 = String(photo.data).split(',')[1] ?? '';
    const buffer = Buffer.from(base64, 'base64');
    const safeName = (photo.filename || `sample-photo-${photo._id}`).replace(/["\\\r\n]/g, '');
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.send(buffer);
  })
);

// ── Admin: take a photo down ─────────────────────────────────────
//
// A tombstone, not a delete. The log said a photo was put here; erasing
// the row would leave that entry pointing at nothing and quietly rewrite
// what the file says happened. The bytes go, the fact does not.
router.delete(
  '/photo/:photoId',
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.photoId))) {
      return next(new ErrorHandler('Photo not found', 404));
    }
    // A DELETE carries its reason in the query string from the web client
    // and in the body from the mobile one; requireReason takes either.
    const reason = text(requireReason(req), { label: 'Reason', max: MAX_TITLE, required: true });
    if (!reason.ok) return next(new ErrorHandler('Say why this photo is being removed', 400));

    const photo = await SamplePhoto.findById(req.params.photoId);
    if (!photo) return next(new ErrorHandler('Photo not found', 404));
    if (photo.removedAt) return next(new ErrorHandler('This photo was already removed', 409));

    const who = actor(req);
    photo.data = '';
    photo.removedAt = new Date();
    photo.removedBy = who.by;
    photo.removalReason = reason.value;
    await photo.save();

    await SampleRequest.updateOne(
      { _id: photo.sample },
      {
        $push: {
          log: {
            kind: 'photo_removed',
            note: reason.value,
            status: null,
            fromStatus: null,
            photo: photo._id,
            by: who.by,
            byName: who.byName,
            at: new Date(),
          },
        },
      }
    );

    const doc = await SampleRequest.findById(photo.sample).populate('customer', 'name').lean();
    res.status(200).json({
      success: true,
      sample: doc ? shapeDetail(doc, await photosOf(doc._id)) : null,
    });
  })
);

// ── Admin: complete, close, or reopen ────────────────────────────
router.put(
  '/:id/status',
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return next(new ErrorHandler('Sample request not found', 404));
    }
    const status = req.body.status;
    if (!SAMPLE_STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${SAMPLE_STATUSES.join(', ')}`, 400));
    }
    const note = text(req.body.note, { label: 'Note' });
    if (!note.ok) return next(new ErrorHandler(note.reason, 400));

    const doc = await SampleRequest.findById(req.params.id);
    if (!doc) return next(new ErrorHandler('Sample request not found', 404));

    if (doc.status === status) {
      return next(new ErrorHandler(`This sample is already ${status}`, 409));
    }

    // Closing something says it is finished, so say why. Reopening is
    // held to the same standard — it undoes a decision somebody made.
    const isTerminal = TERMINAL_STATUSES.includes(status);
    const isReopen = TERMINAL_STATUSES.includes(doc.status) && !isTerminal;
    if ((isTerminal || isReopen) && !note.value) {
      return next(new ErrorHandler(
        isReopen ? 'Say why this sample is being reopened' : `Say why this sample is being ${status}`,
        400
      ));
    }

    const who = actor(req);
    const from = doc.status;
    doc.status = status;
    doc.closedBy = isTerminal ? who.by : undefined;
    doc.closedAt = isTerminal ? new Date() : null;
    doc.log.push({
      kind: 'status',
      note: note.value,
      status,
      fromStatus: from,
      by: who.by,
      byName: who.byName,
      at: new Date(),
    });
    await doc.save();

    const fresh = await SampleRequest.findById(doc._id).populate('customer', 'name').lean();
    res.status(200).json({ success: true, sample: shapeDetail(fresh, await photosOf(doc._id)) });
  })
);

module.exports = router;

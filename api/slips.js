'use strict';

// ══════════════════════════════════════════════════════════════════
//  PRODUCTION SLIPS — the web side of reading slips from photos
//
//    GET  /api/v2/slips?status=open|applied|discarded|all&page=1
//    GET  /api/v2/slips/:id                 the slip, its rows, its photos (no bytes)
//    GET  /api/v2/slips/:id/photo/:page     a photo
//    POST /api/v2/slips/upload              multipart "photos" (+ caption, dateKey, shift)
//    POST /api/v2/slips/:id/shift           { dateKey, shift } — it is this shift
//    POST /api/v2/slips/:id/apply           { rows: [{ index, include, production, timer, remarks }], expectedVersion }
//    POST /api/v2/slips/:id/discard
//
//  Slips arrive mostly over WhatsApp (api/notify.js); this is where the
//  ones held for a check are corrected and saved. Saving submits the
//  values for verification — see services/slipIngest.js.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/ErrorHandler');
const { keepRequestContext } = require('../middleware/userContext');
const { validate, z } = require('../middleware/validate');
const SlipIngest = require('../models/SlipIngest');
const SlipPhoto = require('../models/SlipPhoto');
const slips = require('../services/slipIngest');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

const PAGE_SIZE = 20;

const counts = (s) => {
  const rows = s.rows || [];
  return {
    rows: rows.length,
    ready: rows.filter((r) => r.state === 'ready' && !r.applied).length,
    check: rows.filter((r) => r.state === 'check' && !r.applied).length,
    skip: rows.filter((r) => r.state === 'skip').length,
    applied: rows.filter((r) => r.applied).length,
    unmatched: (s.unmatched || []).length,
  };
};

function shape(s, photos) {
  return {
    id: String(s._id),
    version: s.__v,
    confirmCode: s.confirmCode,
    source: s.source,
    sentByName: s.sentByName,
    from: s.from || null,
    caption: s.caption,
    status: s.status,
    problem: s.problem,
    format: s.format,
    dateKey: s.dateKey,
    shift: s.shift,
    dateFrom: s.dateFrom,
    createdAt: s.createdAt,
    readAt: s.readAt,
    appliedAt: s.appliedAt,
    appliedByName: s.appliedByName,
    counts: counts(s),
    ...(photos !== undefined ? {
      rows: (s.rows || []).map((r, index) => ({
        index,
        shiftDetail: r.shiftDetail ? String(r.shiftDetail) : null,
        machineID: r.machineID,
        machineRead: r.machineRead,
        code: r.code,
        operator: r.operator,
        jobNo: r.jobNo,
        production: r.production,
        timer: r.timer,
        remarks: r.remarks,
        confidence: r.confidence,
        state: r.state,
        notes: r.notes,
        expected: r.expected?.low != null ? r.expected : null,
        applied: !!r.applied,
        appliedProduction: r.appliedProduction,
      })),
      unmatched: s.unmatched || [],
      photos: photos.map((p) => ({ page: p.page, contentType: p.contentType, size: p.size })),
    } : {}),
  };
}

const idParam = (req, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    next(new ErrorHandler('Slip not found', 404));
    return false;
  }
  return true;
};

router.get('/', catchAsyncErrors(async (req, res) => {
  const status = String(req.query.status || 'open');
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = status === 'all' ? {}
    : status === 'open' ? { status: { $in: SlipIngest.OPEN_STATUSES } }
      : { status };
  const [items, total] = await Promise.all([
    SlipIngest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
      .select('-read').lean(),
    SlipIngest.countDocuments(filter),
  ]);
  res.json({ success: true, slips: items.map((s) => shape(s)), total, page, pageSize: PAGE_SIZE });
}));

router.get('/:id', catchAsyncErrors(async (req, res, next) => {
  if (!idParam(req, next)) return;
  const slip = await SlipIngest.findById(req.params.id).select('-read').lean();
  if (!slip) return next(new ErrorHandler('Slip not found', 404));
  const photos = await SlipPhoto.find({ slip: slip._id }).select('page contentType size').sort({ page: 1 }).lean();
  res.json({ success: true, slip: shape(slip, photos) });
}));

router.get('/:id/photo/:page', catchAsyncErrors(async (req, res, next) => {
  if (!idParam(req, next)) return;
  const photo = await SlipPhoto.findOne({ slip: req.params.id, page: Number(req.params.page) || 0 })
    .select('+data contentType').lean();
  if (!photo) return next(new ErrorHandler('Photo not found', 404));
  res.setHeader('Content-Type', photo.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(photo.data, 'base64'));
}));

router.post(
  '/upload',
  keepRequestContext(upload.array('photos', 10)),
  validate({ body: z.object({
    caption: z.string().max(200).optional(),
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    shift: z.enum(['DAY', 'NIGHT', '']).optional(),
  }).passthrough() }),
  catchAsyncErrors(async (req, res) => {
    const slip = await slips.receiveUpload({
      files: req.files,
      caption: req.body.caption,
      dateKey: req.body.dateKey || null,
      shift: req.body.shift || null,
      user: req.user,
    });
    res.status(201).json({ success: true, slip: shape(slip) });
  })
);

router.post(
  '/:id/shift',
  validate({ body: z.object({
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shift: z.enum(['DAY', 'NIGHT']),
  }) }),
  catchAsyncErrors(async (req, res, next) => {
    if (!idParam(req, next)) return;
    const slip = await slips.setShift(req.params.id, req.body);
    const photos = await SlipPhoto.find({ slip: slip._id }).select('page contentType size').sort({ page: 1 }).lean();
    res.json({ success: true, slip: shape(slip.toObject(), photos) });
  })
);

router.post(
  '/:id/apply',
  validate({ body: z.object({
    rows: z.array(z.object({
      index: z.number().int().min(0),
      include: z.boolean(),
      production: z.union([z.number(), z.string(), z.null()]).optional(),
      timer: z.string().max(12).nullable().optional(),
      remarks: z.string().max(300).optional(),
    })).max(300),
    expectedVersion: z.number().int().optional(),
  }) }),
  catchAsyncErrors(async (req, res, next) => {
    if (!idParam(req, next)) return;
    const out = await slips.applySlip(req.params.id, {
      user: req.user,
      edits: req.body.rows,
      expectedVersion: req.body.expectedVersion ?? null,
    });
    const photos = await SlipPhoto.find({ slip: req.params.id }).select('page contentType size').sort({ page: 1 }).lean();
    res.json({
      success: true,
      saved: out.saved,
      skipped: out.skipped,
      remaining: out.remaining,
      slip: shape(out.slip.toObject(), photos),
    });
  })
);

router.post('/:id/discard', catchAsyncErrors(async (req, res, next) => {
  if (!idParam(req, next)) return;
  const slip = await slips.discardSlip(req.params.id, { user: req.user });
  res.json({ success: true, slip: shape(slip.toObject()) });
}));

module.exports = router;

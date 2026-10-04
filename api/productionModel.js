'use strict';

// ══════════════════════════════════════════════════════════════════
//  PREDICTED PRODUCTION
//
//    GET /api/v2/production-model/summary
//      → how the model was trained, how accurate it was on recent shifts
//        it hadn't seen against simpler guesses, and every machine's
//        speed against the plant's typical machine
//    GET /api/v2/production-model/machine/:id?runTime=7:45&pick=14
//      → that machine's learned rate, and what it should make in that
//        run time at that pick (the pick of its current elastics when
//        none is given)
//    GET /api/v2/production-model/shift/:id?runTime=7:45
//      → what a planned shift should make, for the production entry
//        screen to show beside the figure being typed
//
//  Read-only. The model itself is services/productionModel.js; the
//  worker's own version of the shift read is /me/shifts/:id/expected.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const ShiftDetail = require('../models/ShiftDetail');
const Machine = require('../models/Machine');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/ErrorHandler');
const { validate, fields: { objectId, numberish }, z } = require('../middleware/validate');
const pm = require('../services/productionModel');

const router = express.Router();

const runTime = z.string().max(12).optional();

router.get(
  '/summary',
  catchAsyncErrors(async (req, res) => {
    const trained = await pm.getModel();
    const out = pm.describe(trained);
    let machines = [];
    if (trained.available) {
      const docs = await Machine.find({}).select('ID NoOfHead status').lean();
      machines = docs
        .map((m) => ({
          id: String(m._id),
          code: m.ID,
          heads: m.NoOfHead,
          status: m.status,
          ...pm.machineSummary(trained.model, m._id),
        }))
        .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    }
    res.json({ success: true, ...out, machines });
  })
);

router.get(
  '/machine/:id',
  validate({ params: z.object({ id: objectId }), query: z.object({ runTime, pick: numberish.optional() }) }),
  catchAsyncErrors(async (req, res, next) => {
    const machine = await Machine.findById(req.params.id).select('elastics').lean();
    if (!machine) return next(new ErrorHandler('Machine not found', 404));
    const pick = req.query.pick != null && req.query.pick !== '' ? Number(req.query.pick) : null;
    if (pick != null && !(pick > 0 && pick < 1000)) return next(new ErrorHandler('pick must be a number above 0', 400));
    const minutes = req.query.runTime ? pm.runMinutes(req.query.runTime) : null;
    if (req.query.runTime && !minutes) return next(new ErrorHandler('runTime must look like 7:45 or 07:45:00', 400));

    const out = await pm.expectFor({
      machineId: machine._id,
      elasticIds: (machine.elastics || []).map((h) => h.elastic),
      minutes: minutes || pm.SHIFT_MINUTES,
      pickOverride: pick,
    });
    const trained = await pm.getModel();
    res.json({
      success: true,
      ...out,
      runTimeFrom: minutes ? 'entered' : 'full-shift',
      evaluation: trained.evaluation,
    });
  })
);

router.get(
  '/shift/:id',
  validate({ params: z.object({ id: objectId }), query: z.object({ runTime }) }),
  catchAsyncErrors(async (req, res, next) => {
    const shift = await ShiftDetail.findById(req.params.id)
      .select('machine elastics timer submittedTimer')
      .lean();
    if (!shift) return next(new ErrorHandler('Shift not found', 404));
    const out = await pm.expectForShift(shift, { runTime: req.query.runTime });
    if (!out) return next(new ErrorHandler('Machine not found', 404));
    res.json({ success: true, ...out });
  })
);

module.exports = router;

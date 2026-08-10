'use strict';
// ══════════════════════════════════════════════════════════════════
//  STOCK COUNTS  —  /api/v2/stock-counts
//
//  The counting programme. See models/StockCount.js for why this
//  snapshots rather than freezes, and why posting applies an increment
//  rather than setting stock to the counted figure.
//
//    POST   /                    open a count over a scope
//    GET    /                    list, newest first
//    GET    /:id                 the sheet, with live variance
//    GET    /:id/variance        just the variance report
//    PATCH  /:id/lines           enter counted quantities
//    POST   /:id/post            apply the differences
//    POST   /:id/cancel          abandon; nothing is applied
//
//  Posting is the only route that writes stock. It does so through the
//  same helpers as every other stock write — appendStockMovement for
//  the ledger, MaterialInward / MaterialOutward for the authoritative
//  history — so a count's corrections appear on the material's page and
//  in the order P&L exactly like any other adjustment, rather than in a
//  private ledger only this feature knows how to read.
// ══════════════════════════════════════════════════════════════════

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const StockCount      = require('../models/StockCount');
const RawMaterial     = require('../models/RawMaterial');
const MaterialInward  = require('../models/MaterialInward');
const MaterialOutward = require('../models/MaterialOut.cjs');

const ErrorHandler     = require('../utils/ErrorHandler');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const { isAdmin }      = require('../middleware/auth');
const { appendStockMovement } = require('../utils/stockLedger');
const { costOf }       = require('../utils/materialValuation');
const {
  buildFingerprint, actorFromRequest, ACTION_CODES,
} = require('../utils/fingerprint');

// ── Tunables ───────────────────────────────────────────────────────
//
// A variance past this needs a reason before it can be posted. Not a
// block — finding a big difference is the entire point of counting, and
// refusing to record it just moves the correction somewhere with no
// audit trail. But a 400 kg discrepancy with an empty reason box is a
// number nobody can act on six months later.
const REASON_THRESHOLD_ABS = 25;      // kg
const REASON_THRESHOLD_PCT = 0.10;    // of the system quantity
const MIN_REASON = 5;

// A count sheet is walked on foot. Past this many lines it is not a
// count, it is a wish — and the document stops being loadable.
const MAX_LINES = 2000;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** The reason threshold for one line, in absolute quantity. */
const reasonThreshold = (systemQty) =>
  Math.max(REASON_THRESHOLD_ABS, Math.abs(Number(systemQty) || 0) * REASON_THRESHOLD_PCT);

/**
 * Variance for one line, in quantity and in value.
 *
 * `countedQty` of null means nobody has been to that rack yet, which is
 * not a variance of −systemQty. Treating an uncounted line as a
 * write-off is the single most expensive mistake this feature could
 * make, so it is handled first and everywhere.
 */
function lineVariance(line) {
  const counted = line.countedQty;
  if (counted === null || counted === undefined) {
    return { counted: null, variance: null, value: null, needsReason: false };
  }
  const variance = r4(Number(counted) - (Number(line.systemQty) || 0));
  return {
    counted: Number(counted),
    variance,
    value: r2(variance * (Number(line.unitCostAtFreeze) || 0)),
    needsReason:
      Math.abs(variance) > reasonThreshold(line.systemQty) &&
      String(line.reason || '').trim().length < MIN_REASON,
  };
}

/** The whole sheet, shaped for a screen. */
function summarise(count) {
  const lines = (count.lines || []).map((l) => {
    const v = lineVariance(l);
    return {
      _id:          String(l._id),
      rawMaterial:  String(l.rawMaterial?._id || l.rawMaterial),
      name:         l.name,
      category:     l.category,
      systemQty:    r4(l.systemQty),
      unitCost:     r4(l.unitCostAtFreeze),
      countedQty:   v.counted,
      variance:     v.variance,
      varianceValue: v.value,
      reason:       l.reason || '',
      needsReason:  v.needsReason,
      countedAt:    l.countedAt || null,
      stockAtPost:  l.stockAtPost,
      appliedDelta: l.appliedDelta,
      // Only knowable once posted; before that the live figure is not
      // part of the sheet's claim.
      movedSinceFreeze:
        l.stockAtPost === null || l.stockAtPost === undefined
          ? null
          : r4(Number(l.stockAtPost) - (Number(l.systemQty) || 0)) !== 0,
    };
  });

  const counted = lines.filter((l) => l.variance !== null);
  const varied  = counted.filter((l) => l.variance !== 0);

  return {
    lines,
    totals: {
      lines:        lines.length,
      counted:      counted.length,
      uncounted:    lines.length - counted.length,
      varied:       varied.length,
      needingReason: counted.filter((l) => l.needsReason).length,
      gainQuantity: r4(varied.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance, 0)),
      lossQuantity: r4(varied.filter((l) => l.variance < 0).reduce((s, l) => s + l.variance, 0)),
      gainValue:    r2(varied.filter((l) => l.varianceValue > 0).reduce((s, l) => s + l.varianceValue, 0)),
      lossValue:    r2(varied.filter((l) => l.varianceValue < 0).reduce((s, l) => s + l.varianceValue, 0)),
      netValue:     r2(counted.reduce((s, l) => s + (l.varianceValue || 0), 0)),
    },
  };
}

const shape = (count) => ({
  _id:      String(count._id),
  countNo:  count.countNo ?? null,
  label:    count.label || '',
  status:   count.status,
  scope:    count.scope,
  frozenAt: count.frozenAt,
  postedAt: count.postedAt || null,
  cancelledAt: count.cancelledAt || null,
  cancelledReason: count.cancelledReason || '',
  postedSummary: count.status === 'posted' ? count.postedSummary : null,
  ...summarise(count),
});

// ══════════════════════════════════════════════════════════════════
//  OPEN A COUNT
//  POST /  { label, scope: { kind, category, supplier, materials[] } }
// ══════════════════════════════════════════════════════════════════
router.post(
  '/',
  isAdmin('admin', 'accounts', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { label = '', scope = {} } = req.body || {};
    const kind = String(scope.kind || 'all');

    if (!['all', 'category', 'supplier', 'materials'].includes(kind)) {
      return next(new ErrorHandler(`Unknown scope '${kind}'`, 400));
    }

    const filter = {};
    if (kind === 'category') {
      if (!String(scope.category || '').trim()) {
        return next(new ErrorHandler('A category is required for a category count', 400));
      }
      filter.category = String(scope.category).trim();
    } else if (kind === 'supplier') {
      if (!mongoose.Types.ObjectId.isValid(scope.supplier)) {
        return next(new ErrorHandler('A valid supplier is required for a supplier count', 400));
      }
      filter.supplier = scope.supplier;
    } else if (kind === 'materials') {
      const ids = Array.isArray(scope.materials) ? scope.materials : [];
      if (ids.length === 0) {
        return next(new ErrorHandler('Select at least one material to count', 400));
      }
      if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
        return next(new ErrorHandler('materials contains an invalid id', 400));
      }
      filter._id = { $in: ids };
    }

    // The snapshot. Read once, here, and never refreshed — everything
    // this count claims is measured against what the system believed at
    // this moment.
    const materials = await RawMaterial.find(filter)
      .select('name category stock price avgCost')
      .sort({ category: 1, name: 1 })
      .limit(MAX_LINES + 1)
      .lean();

    if (materials.length === 0) {
      return next(new ErrorHandler('Nothing to count — that scope matched no materials', 400));
    }
    if (materials.length > MAX_LINES) {
      return next(new ErrorHandler(
        `That scope covers more than ${MAX_LINES} materials. Narrow it by category or supplier.`,
        400
      ));
    }

    const count = await StockCount.create({
      label: String(label || '').trim(),
      scope: {
        kind,
        category:  kind === 'category' ? filter.category : '',
        supplier:  kind === 'supplier' ? scope.supplier : undefined,
        materials: kind === 'materials' ? scope.materials : [],
      },
      status:   'counting',
      frozenAt: new Date(),
      openedBy: req.user?._id,
      lines: materials.map((m) => ({
        rawMaterial: m._id,
        name:        m.name || '',
        category:    m.category || '',
        systemQty:   Number(m.stock) || 0,
        // The cost as at the freeze. Valuing the variance later, at
        // whatever the average has become, would price a March
        // discrepancy at a June cost.
        unitCostAtFreeze: costOf(m),
        countedQty:  null,
      })),
    });

    count.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_COUNT_OPENED, {
      entityId: count._id,
      actor: actorFromRequest(req),
      meta: { countNo: count.countNo, scope: kind, lines: materials.length },
    }));
    await count.save();

    res.status(201).json({ success: true, count: shape(count) });
  })
);

// ══════════════════════════════════════════════════════════════════
//  LIST
//  GET /?status=&page=&limit=
// ══════════════════════════════════════════════════════════════════
router.get(
  '/',
  catchAsyncErrors(async (req, res) => {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);

    const [rows, total] = await Promise.all([
      StockCount.find(filter)
        // The lines are the bulk of the document and a list does not
        // show them — only how many there are, which is counted below
        // from a projection rather than by loading every one.
        .select('-lines.reason -fingerprints')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StockCount.countDocuments(filter),
    ]);

    res.json({
      success: true,
      counts: rows.map((c) => {
        const counted = (c.lines || []).filter(
          (l) => l.countedQty !== null && l.countedQty !== undefined
        );
        return {
          _id: String(c._id), countNo: c.countNo ?? null, label: c.label || '',
          status: c.status, scope: c.scope, frozenAt: c.frozenAt,
          postedAt: c.postedAt || null,
          lines: (c.lines || []).length,
          counted: counted.length,
          netValue: c.status === 'posted' ? c.postedSummary?.netValue ?? 0 : null,
        };
      }),
      page, limit, total,
      hasMore: (page - 1) * limit + rows.length < total,
    });
  })
);

// ══════════════════════════════════════════════════════════════════
//  ONE SHEET
//  GET /:id
// ══════════════════════════════════════════════════════════════════
router.get(
  '/:id',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid count id', 400));
    }
    const count = await StockCount.findById(req.params.id).lean();
    if (!count) return next(new ErrorHandler('Stock count not found', 404));
    res.json({ success: true, count: shape(count) });
  })
);

// ══════════════════════════════════════════════════════════════════
//  VARIANCE REPORT
//  GET /:id/variance?only=varied
//
//  The document the count exists to produce.
// ══════════════════════════════════════════════════════════════════
router.get(
  '/:id/variance',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid count id', 400));
    }
    const count = await StockCount.findById(req.params.id).lean();
    if (!count) return next(new ErrorHandler('Stock count not found', 404));

    const { lines, totals } = summarise(count);
    // Default to the lines that differ — a variance report listing
    // 900 materials that matched is not a report, it is the sheet
    // again. `?only=all` gives the lot.
    const only = String(req.query.only || 'varied');
    const shown = only === 'all'
      ? lines
      : lines.filter((l) => l.variance !== null && l.variance !== 0);

    res.json({
      success: true,
      countNo:  count.countNo ?? null,
      label:    count.label || '',
      status:   count.status,
      frozenAt: count.frozenAt,
      postedAt: count.postedAt || null,
      // Biggest loss first: that is the order somebody reads it in.
      lines: shown.sort((a, b) => (a.varianceValue ?? 0) - (b.varianceValue ?? 0)),
      totals,
    });
  })
);

// ══════════════════════════════════════════════════════════════════
//  ENTER COUNTED QUANTITIES
//  PATCH /:id/lines  { lines: [{ rawMaterial | lineId, countedQty, reason }] }
//
//  Bulk, because the sheet comes back from the floor as a sheet. Lines
//  not mentioned are left exactly as they were, so two people can count
//  different racks and neither wipes the other's work.
// ══════════════════════════════════════════════════════════════════
router.patch(
  '/:id/lines',
  isAdmin('admin', 'accounts', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid count id', 400));
    }
    const entries = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (entries.length === 0) {
      return next(new ErrorHandler('lines is required', 400));
    }

    const count = await StockCount.findById(req.params.id);
    if (!count) return next(new ErrorHandler('Stock count not found', 404));
    if (count.status === 'posted' || count.status === 'cancelled') {
      return next(new ErrorHandler(
        `Count #${count.countNo} is ${count.status} — its lines can no longer be changed`, 409
      ));
    }

    const byLineId  = new Map(count.lines.map((l) => [String(l._id), l]));
    const byMaterial = new Map(count.lines.map((l) => [String(l.rawMaterial), l]));

    const applied = [];
    const errors  = [];

    for (const e of entries) {
      const line = e.lineId
        ? byLineId.get(String(e.lineId))
        : byMaterial.get(String(e.rawMaterial));

      if (!line) {
        errors.push({ ref: e.lineId || e.rawMaterial, error: 'Not on this count sheet' });
        continue;
      }

      // An explicit null clears a line back to uncounted — somebody
      // keyed the wrong row and needs to undo it, which must be
      // possible without abandoning the whole count.
      if (e.countedQty === null) {
        line.countedQty = null;
        line.countedAt  = undefined;
        line.countedBy  = undefined;
        if (e.reason !== undefined) line.reason = String(e.reason || '').trim();
        applied.push({ lineId: String(line._id), countedQty: null });
        continue;
      }

      if (e.countedQty !== undefined) {
        const qty = Number(e.countedQty);
        if (!Number.isFinite(qty) || qty < 0) {
          errors.push({ ref: e.lineId || e.rawMaterial, error: 'countedQty must be zero or more' });
          continue;
        }
        line.countedQty = r4(qty);
        line.countedAt  = new Date();
        line.countedBy  = req.user?._id;
      }
      if (e.reason !== undefined) line.reason = String(e.reason || '').trim();

      applied.push({
        lineId: String(line._id),
        countedQty: line.countedQty,
        variance: lineVariance(line).variance,
      });
    }

    // Everything counted moves the sheet on to review by itself. It is
    // a status the person would otherwise have to remember to set, and
    // forgetting it is invisible.
    const allCounted = count.lines.every(
      (l) => l.countedQty !== null && l.countedQty !== undefined
    );
    if (allCounted && count.status === 'counting') count.status = 'review';
    if (!allCounted && count.status === 'review')  count.status = 'counting';

    await count.save();

    res.json({
      success: true,
      status: count.status,
      applied,
      ...(errors.length ? { errors } : {}),
      count: shape(count),
    });
  })
);

// ══════════════════════════════════════════════════════════════════
//  POST THE COUNT
//  POST /:id/post  { force?: true }
//
//  Applies every non-zero variance as a stock adjustment. Uncounted
//  lines are skipped — never written off.
// ══════════════════════════════════════════════════════════════════
router.post(
  '/:id/post',
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid count id', 400));
    }

    // ── Pre-flight, outside the transaction ─────────────────────────
    // So the caller gets a clean 400 listing what is wrong rather than
    // an aborted transaction and a generic failure.
    const peek = await StockCount.findById(req.params.id).lean();
    if (!peek) return next(new ErrorHandler('Stock count not found', 404));
    if (peek.status === 'posted') {
      return next(new ErrorHandler(`Count #${peek.countNo} is already posted`, 409));
    }
    if (peek.status === 'cancelled') {
      return next(new ErrorHandler(`Count #${peek.countNo} was cancelled`, 409));
    }

    const counted = peek.lines.filter(
      (l) => l.countedQty !== null && l.countedQty !== undefined
    );
    if (counted.length === 0) {
      return next(new ErrorHandler('Nothing has been counted yet', 400));
    }

    const needReason = counted
      .map((l) => ({ line: l, v: lineVariance(l) }))
      .filter((x) => x.v.needsReason);
    if (needReason.length > 0) {
      const err = new ErrorHandler(
        `${needReason.length} line(s) vary by more than the threshold and need a ` +
        `reason of at least ${MIN_REASON} characters before this count can be posted.`,
        400
      );
      err.details = needReason.map((x) => ({
        rawMaterial: String(x.line.rawMaterial),
        name:        x.line.name,
        systemQty:   x.line.systemQty,
        countedQty:  x.line.countedQty,
        variance:    x.v.variance,
        threshold:   r4(reasonThreshold(x.line.systemQty)),
      }));
      return next(err);
    }

    // Lines that never got counted. Posting is still allowed — a
    // partial count is a normal thing to post — but the caller has to
    // say so, because "post" on a half-finished sheet is much more
    // often a mistake than an intention.
    const uncounted = peek.lines.length - counted.length;
    if (uncounted > 0 && req.body?.force !== true) {
      return next(new ErrorHandler(
        `${uncounted} of ${peek.lines.length} lines have not been counted. They will be ` +
        `left untouched, not written off. Pass force:true to post the rest.`,
        400
      ));
    }

    const actor = actorFromRequest(req);
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        // Re-read inside the session. withTransaction replays its
        // callback on a transient error, so nothing here may depend on
        // a mutation made before it — and the status guard below is
        // what makes posting twice impossible rather than merely
        // unlikely.
        const count = await StockCount.findById(req.params.id).session(session);
        if (!count) throw new ErrorHandler('Stock count not found', 404);
        if (count.status === 'posted') {
          throw new ErrorHandler(`Count #${count.countNo} is already posted`, 409);
        }
        if (count.status === 'cancelled') {
          throw new ErrorHandler(`Count #${count.countNo} was cancelled`, 409);
        }

        const summary = {
          linesCounted: 0, linesVaried: 0,
          gainQuantity: 0, lossQuantity: 0,
          gainValue: 0, lossValue: 0, netValue: 0,
          linesMovedSinceFreeze: 0,
        };

        for (const line of count.lines) {
          if (line.countedQty === null || line.countedQty === undefined) continue;
          summary.linesCounted += 1;

          const variance = r4(Number(line.countedQty) - (Number(line.systemQty) || 0));

          const material = await RawMaterial.findById(line.rawMaterial).session(session);
          if (!material) {
            // Deleted between the freeze and now. Record that the line
            // could not be posted rather than failing the whole count
            // over one missing master record.
            line.stockAtPost  = null;
            line.appliedDelta = 0;
            continue;
          }

          const live = Number(material.stock) || 0;
          line.stockAtPost = live;
          if (r4(live - (Number(line.systemQty) || 0)) !== 0) {
            summary.linesMovedSinceFreeze += 1;
          }

          if (variance === 0) { line.appliedDelta = 0; continue; }

          // The increment, not a set — see models/StockCount.js. Stock
          // still floors at zero, so a loss larger than what is on hand
          // now moves only what is there, and the row records both.
          const newStock = Math.max(0, live + variance);
          const applied  = r4(newStock - live);
          line.appliedDelta = applied;

          if (applied === 0) continue;

          summary.linesVaried += 1;
          const unitCost = Number(line.unitCostAtFreeze) || 0;
          const value    = r2(applied * unitCost);
          if (applied > 0) {
            summary.gainQuantity = r4(summary.gainQuantity + applied);
            summary.gainValue    = r2(summary.gainValue + value);
          } else {
            summary.lossQuantity = r4(summary.lossQuantity + applied);
            summary.lossValue    = r2(summary.lossValue + value);
          }
          summary.netValue = r2(summary.netValue + value);

          material.stock = newStock;
          await material.save({ session });

          const reason =
            String(line.reason || '').trim() ||
            `Stock count #${count.countNo}`;

          // Through the shared ledger, so this reads on the material's
          // own page beside every other movement. A count posting into
          // a ledger only the count screen can read would be a second
          // set of books.
          await appendStockMovement(material._id, {
            type:      'STOCK_ADJUST',
            reason:    `Count #${count.countNo}: ${reason}`,
            quantity:  applied,
            requested: applied === variance ? undefined : variance,
            balance:   newStock,
            // A count changes quantity, never cost. The row still says
            // what the difference was worth, which is the number the
            // write-off gets judged on.
            unitCost,
          }, session);

          // The authoritative history, which is what the stock-movements
          // report and the order P&L actually read.
          if (applied > 0) {
            await MaterialInward.create([{
              rawMaterial: material._id,
              quantity:    applied,
              inwardDate:  new Date(),
              remarks:     `Stock count #${count.countNo}: ${reason}`,
              unitPrice:   unitCost,
            }], { session });
          } else {
            await MaterialOutward.create([{
              rawMaterial: material._id,
              quantity:    Math.abs(applied),
              type:        'STOCK_ADJUST',
              outwardDate: new Date(),
              unitPrice:   unitCost,
              remarks:     `Stock count #${count.countNo}: ${reason}`,
            }], { session });
          }
        }

        count.status        = 'posted';
        count.postedAt      = new Date();
        count.postedBy      = req.user?._id;
        count.postedSummary = summary;
        count.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_COUNT_POSTED, {
          entityId: count._id,
          actor,
          meta: { countNo: count.countNo, ...summary, forced: req.body?.force === true },
        }));
        await count.save({ session });

        result = shape(count.toObject());
      });
    } finally {
      await session.endSession();
    }

    res.json({ success: true, count: result });
  })
);

// ══════════════════════════════════════════════════════════════════
//  CANCEL
//  POST /:id/cancel  { reason }
// ══════════════════════════════════════════════════════════════════
router.post(
  '/:id/cancel',
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid count id', 400));
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      return next(new ErrorHandler('A reason (min 3 chars) is required to cancel a count', 400));
    }

    const count = await StockCount.findById(req.params.id);
    if (!count) return next(new ErrorHandler('Stock count not found', 404));
    if (count.status === 'posted') {
      // A posted count has moved stock. Undoing it is a new count, not
      // a status change — reversing it here would leave the material
      // ledger with adjustments no document explains.
      return next(new ErrorHandler(
        `Count #${count.countNo} has been posted and cannot be cancelled. ` +
        `Open a new count to correct it.`, 409
      ));
    }
    if (count.status === 'cancelled') {
      return res.json({ success: true, count: shape(count.toObject()) });
    }

    count.status          = 'cancelled';
    count.cancelledAt     = new Date();
    count.cancelledBy     = req.user?._id;
    count.cancelledReason = reason;
    count.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_COUNT_CANCELLED, {
      entityId: count._id,
      actor: actorFromRequest(req),
      meta: { countNo: count.countNo, reason },
    }));
    await count.save();

    res.json({ success: true, count: shape(count.toObject()) });
  })
);

module.exports = router;
module.exports.REASON_THRESHOLD_ABS = REASON_THRESHOLD_ABS;
module.exports.REASON_THRESHOLD_PCT = REASON_THRESHOLD_PCT;

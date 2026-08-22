'use strict';
//
// MATERIAL STOCK MOVEMENT LEDGER — over a date range.
//
// Answers "what moved on this material between these two dates, and what
// was the balance on either side of that window".
//
// ── Why not RawMaterial.stockMovements ──────────────────────────────
// The embedded array is capped at MAX_EMBEDDED_MOVEMENTS (500) and the
// detail route trims it to 50 for display. It is a convenience tail, not
// a system of record — asking it for March of last year on a fast-moving
// yarn returns nothing, and returns it silently. MaterialInward and
// MaterialOutward are the uncapped authoritative logs, so the ledger is
// composed from those two collections and the embedded array is ignored
// entirely.
//
// ── Reversed outwards ───────────────────────────────────────────────
// Cancelling an order marks its original outward `reversed: true` and
// credits the stock back through receiveAtCost — it does NOT write a
// compensating inward. So a reversed outward must be skipped rather than
// shown and then netted off, or the ledger would report an issue that
// was undone and a refund that was never logged, and its running balance
// would drift from RawMaterial.stock by twice the reversal.
//
// ── How the balances are derived ────────────────────────────────────
// There is no stored historical balance to read, so both ends of the
// window are computed backwards from the one balance that is certainly
// right — the material's stock today:
//
//     closing = stock now − (everything that moved after `to`)
//     opening = closing   − (everything that moved inside the window)
//
// That makes the closing balance agree with the stock figure whenever
// the range ends today, and lets the caller show the difference when it
// does not. It also means a stock figure edited by hand outside the
// movement logs shifts the whole ledger — which is the honest reading:
// the movements do not explain that edit.

const MaterialInward = require('../models/MaterialInward');
const MaterialOutward = require('../models/MaterialOut.cjs');
const RawMaterial = require('../models/RawMaterial');
const ErrorHandler = require('../utils/ErrorHandler');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Kilograms to three places — enough for grams, short of float noise. */
const round3 = (v) => Math.round(num(v) * 1000) / 1000;

function startOfDay(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Widen the caller's `from`/`to` to whole local days.
 *
 * A user picking 1 March to 31 March means both days included. Passing
 * the raw strings through would give midnight-to-midnight and silently
 * drop everything that moved on the 31st.
 */
function parseRange({ from, to } = {}) {
  const f = from ? startOfDay(from) : null;
  const t = to ? endOfDay(to) : null;
  if (from && !f) throw new ErrorHandler('from is not a date', 400);
  if (to && !t) throw new ErrorHandler('to is not a date', 400);
  if (f && t && f > t) throw new ErrorHandler('from is after to — swap them', 400);
  return { from: f, to: t };
}

/**
 * A goods receipt written by the stock-adjustment screen rather than by a
 * supplier delivery. Both land in MaterialInward; only the remark tells
 * them apart, and calling a correction a receipt overstates purchases on
 * every summary that reads this ledger.
 */
const isAdjustmentInward = (iw) =>
  /^Stock adjustment/i.test(String(iw.remarks || '').trim());

const inwardRow = (iw) => {
  const adjustment = isAdjustmentInward(iw);
  const ref =
    iw.purchaseOrder && iw.purchaseOrder.poNo
      ? `PO-${iw.purchaseOrder.poNo}`
      : '';
  return {
    _id: String(iw._id),
    date: iw.inwardDate || iw.createdAt || null,
    type: adjustment ? 'ADJUST_IN' : 'RECEIPT',
    label: adjustment ? 'Stock adjustment' : 'Goods receipt',
    // Always positive here; composeRows applies the sign.
    quantity: Math.abs(num(iw.quantity)),
    direction: 1,
    reference: ref,
    referenceId: iw.purchaseOrder?._id ? String(iw.purchaseOrder._id) : null,
    referenceKind: ref ? 'purchaseOrder' : null,
    lotNo: iw.lotNo || '',
    unitPrice: num(iw.unitPrice),
    remarks: iw.remarks || '',
  };
};

const OUT_LABEL = {
  ORDER_APPROVAL: 'Order approval',
  JOB_CONSUMPTION: 'Job consumption',
  STOCK_ADJUST: 'Stock adjustment',
};

const outwardRow = (ow) => {
  let reference = '';
  let referenceId = null;
  let referenceKind = null;
  if (ow.order && ow.order.orderNo != null) {
    reference = `Order #${ow.order.orderNo}`;
    referenceId = String(ow.order._id);
    referenceKind = 'order';
  } else if (ow.job && ow.job.jobOrderNo != null) {
    reference = `Job J-${ow.job.jobOrderNo}`;
    referenceId = String(ow.job._id);
    referenceKind = 'job';
  }
  return {
    _id: String(ow._id),
    date: ow.outwardDate || ow.createdAt || null,
    type: ow.type || 'STOCK_ADJUST',
    label: OUT_LABEL[ow.type] || 'Issue',
    quantity: Math.abs(num(ow.quantity)),
    direction: -1,
    reference,
    referenceId,
    referenceKind,
    lotNo: ow.lotNo || '',
    unitPrice: num(ow.unitPrice),
    remarks: ow.remarks || '',
  };
};

/**
 * Interleave receipts and issues into one dated list, oldest first, and
 * run a balance forward from `opening`.
 *
 * Oldest-first is not a display preference: a running balance can only
 * be accumulated in the direction time actually ran. The caller reverses
 * for display if it wants newest at the top.
 */
function composeRows(inwards = [], outs = [], opening = 0) {
  const rows = [...inwards.map(inwardRow), ...outs.map(outwardRow)].sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    if (ta !== tb) return ta - tb;
    // Same instant: receipts before issues, so a same-moment receive-and-
    // issue never shows a negative balance that never existed.
    return b.direction - a.direction;
  });

  let balance = round3(opening);
  return rows.map((r) => {
    const signed = round3(r.quantity * r.direction);
    balance = round3(balance + signed);
    return { ...r, signedQuantity: signed, balance };
  });
}

/** Net effect on stock of a set of movements: received minus issued. */
const netOf = (inwards, outs) =>
  round3(
    inwards.reduce((t, r) => t + Math.abs(num(r.quantity)), 0) -
      outs.reduce((t, r) => t + Math.abs(num(r.quantity)), 0)
  );

const liveOutFilter = (materialId, dateClause) => {
  const f = { rawMaterial: materialId, reversed: { $ne: true } };
  if (dateClause) f.outwardDate = dateClause;
  return f;
};

const inFilter = (materialId, dateClause) => {
  const f = { rawMaterial: materialId };
  if (dateClause) f.inwardDate = dateClause;
  return f;
};

/**
 * The ledger for one material over an optional date range.
 *
 * `from`/`to` are Dates already widened by parseRange, or null for open
 * ended. Returns rows oldest-first with a running balance, the opening
 * and closing balances, and the period totals.
 */
async function materialLedger(materialId, { from = null, to = null } = {}) {
  const material = await RawMaterial.findById(materialId)
    .select('name category unit stock')
    .lean();
  if (!material) throw new ErrorHandler('Raw material not found', 404);

  const inWindow = {};
  if (from) inWindow.$gte = from;
  if (to) inWindow.$lte = to;
  const windowClause = from || to ? inWindow : null;

  // Everything after the window — used to walk today's stock back to the
  // closing balance. Empty when the range is open-ended at the top.
  const afterClause = to ? { $gt: to } : null;

  const [inwards, outs, afterIn, afterOut] = await Promise.all([
    MaterialInward.find(inFilter(materialId, windowClause))
      .populate('purchaseOrder', 'poNo status')
      .sort({ inwardDate: 1 })
      .lean(),
    MaterialOutward.find(liveOutFilter(materialId, windowClause))
      .populate('order', 'orderNo')
      .populate('job', 'jobOrderNo')
      .sort({ outwardDate: 1 })
      .lean(),
    afterClause
      ? MaterialInward.find(inFilter(materialId, afterClause)).select('quantity').lean()
      : Promise.resolve([]),
    afterClause
      ? MaterialOutward.find(liveOutFilter(materialId, afterClause)).select('quantity').lean()
      : Promise.resolve([]),
  ]);

  const stockNow = round3(material.stock);
  const closing = round3(stockNow - netOf(afterIn, afterOut));
  const movedInWindow = netOf(inwards, outs);
  const opening = round3(closing - movedInWindow);

  const rows = composeRows(inwards, outs, opening);

  const received = round3(
    inwards
      .filter((r) => !isAdjustmentInward(r))
      .reduce((t, r) => t + Math.abs(num(r.quantity)), 0)
  );
  const adjustedIn = round3(
    inwards
      .filter(isAdjustmentInward)
      .reduce((t, r) => t + Math.abs(num(r.quantity)), 0)
  );
  const issued = round3(outs.reduce((t, r) => t + Math.abs(num(r.quantity)), 0));

  return {
    material: {
      _id: String(material._id),
      name: material.name,
      category: material.category || '',
      unit: material.unit || 'kg',
    },
    range: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    },
    opening,
    closing,
    // The material's stock as it stands right now. Equal to `closing`
    // when the range runs to today; the caller shows the gap when it
    // does not, rather than letting the two numbers quietly disagree.
    stockNow,
    totals: { received, adjustedIn, issued, net: movedInWindow },
    count: rows.length,
    rows,
  };
}

module.exports = {
  materialLedger,
  composeRows,
  parseRange,
  netOf,
  isAdjustmentInward,
  startOfDay,
  endOfDay,
};

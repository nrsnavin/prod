'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH DYE LOT DID THIS MOVEMENT COME OUT OF?
//
//  The raw-material ledger has always said how much moved and why. It
//  has never said WHICH LOT, and for dyed yarn that is the question
//  that matters: a shade complaint arrives months later naming a roll,
//  and the trail back to the bag it was warped from runs through the
//  lot, not the quantity.
//
//  ── Three kinds of answer, and they are not equal ────────────────
//  Every row on that ledger falls into one of three buckets, and the
//  whole design of this module is refusing to blur them:
//
//    RECORDED  The lot is written on the document that caused the
//              movement. A goods receipt carries `lotNo`; a stock
//              adjustment carries `yarnLot`, set when the person
//              adjusting named one. Nothing is being worked out here —
//              the fact was captured at the time.
//
//    EXACT     A warping batch draws named lots off the rack, so the
//              lot is known precisely. Handled by the writer in
//              api/warping.js, which stamps it onto the row; this
//              module just passes it through.
//
//    INFERRED  Order approval, its cancel refund, and job consumption
//              record no lot at all. They are debits against the
//              pooled balance — nobody chose a bag. For a warp yarn
//              the earlier-lot rule below gives a reading, and that
//              reading is MARKED, never presented as a record.
//
//  ── The earlier-lot rule ─────────────────────────────────────────
//  An inferred row is attributed to the earliest-received lot whose
//  receivedDate falls on or before that row's date. Oldest first,
//  because that is the lot the floor should be using up and the one
//  to look at when a shade complaint arrives.
//
//  It deliberately does NOT replay historical lot balances. Doing so
//  would need every draw in date order against every lot, which this
//  system does not have — batch issues are dated, order approvals are
//  not attributed at all — so the result would be a more expensive
//  guess wearing the clothes of a calculation. The rule as written has
//  one property worth more than precision here: a March row is read
//  from the lots that existed in March, so its answer never changes
//  because a lot ran out in June.
//
//  Every inferred row carries `lotDerived: true`, reusing the
//  vocabulary the ledger already has for reconstructed PO references.
//  A reconstruction and a record are not the same claim.
//
//  ── No database in here ──────────────────────────────────────────
//  Everything is passed in. The correctness of this feature lives in
//  this file, and a function that reaches for Mongo can only be tested
//  against a Mongo.
// ══════════════════════════════════════════════════════════════════

const { isLotTracked } = require('../utils/materialCategories');

/** Row types whose lot, when there is one, was recorded at the time. */
const RECORDED_TYPES = new Set(['PO_INWARD', 'STOCK_ADJUST']);

/** Row types written by the warping batch paths, which stamp the lot on. */
const EXACT_TYPES = new Set(['BATCH_ISSUE', 'BATCH_RETURN']);

/** Same-day comparison. The ledger's dates are timestamps; lots are days. */
const dayOf = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};

const idOf = (v) => (v && typeof v === 'object' ? (v._id ?? null) : (v ?? null));
const str = (v) => (v == null ? '' : String(v));

/**
 * The lot a receipt row was recorded against.
 *
 * The movement row itself has no link to its MaterialInward — the two
 * are written milliseconds apart by different code — so the receipt is
 * matched back on the same DAY and the same QUANTITY. That is the same
 * rule api/rawMaterial.js already uses to recover missing PO
 * references, and it inherits the same honesty: when two receipts of
 * the same quantity landed on the same day they are genuinely
 * indistinguishable, and naming one of them would be inventing a fact
 * to fill a column. Ambiguous means no lot.
 */
function recordedInwardLot(row, inwards) {
  const qty = Math.abs(Number(row.quantity) || 0);
  const day = dayOf(row.date);
  if (!day) return null;

  const matches = inwards.filter(
    (iw) => Number(iw.quantity) === qty && dayOf(iw.inwardDate) === day
  );
  if (matches.length !== 1) return null;

  const lotNo = str(matches[0].lotNo).trim();
  return lotNo ? { lotNo, yarnLot: null } : null;
}

/**
 * The lot a stock adjustment named.
 *
 * Matched the same way and for the same reasons, but the outward row
 * carries a real `yarnLot` reference rather than only a number — a
 * manual adjustment picks the lot from a list.
 */
function recordedAdjustLot(row, outwards) {
  const qty = Math.abs(Number(row.quantity) || 0);
  const day = dayOf(row.date);
  if (!day) return null;

  const matches = outwards.filter(
    (ow) =>
      ow.type === 'STOCK_ADJUST' &&
      Math.abs(Number(ow.quantity)) === qty &&
      dayOf(ow.outwardDate) === day
  );
  if (matches.length !== 1) return null;

  const ow = matches[0];
  const lotNo = str(ow.lotNo).trim();
  const yarnLot = idOf(ow.yarnLot);
  if (!lotNo && !yarnLot) return null;
  return { lotNo, yarnLot: yarnLot ? String(yarnLot) : null };
}

/**
 * The earliest-received lot that existed on or before [date].
 *
 * Quarantined and closed lots are still eligible: this is a reading of
 * history, and yarn that was drawn in March came off a lot that may
 * well have been quarantined in May. Excluding them would silently
 * shift old rows onto lots they cannot have come from.
 */
function earliestLotBy(date, lotsOldestFirst) {
  const on = dayOf(date);
  if (!on) return null;
  for (const lot of lotsOldestFirst) {
    const rec = dayOf(lot.receivedDate);
    // A lot with no received date cannot be placed in time, so it
    // cannot be used to explain a movement at a point in time.
    if (rec && rec <= on) return lot;
  }
  return null;
}

/**
 * Attribute every movement on one material to a lot.
 *
 * @param {object}  material  needs `category`; the switch is derived from it
 * @param {Array}   movements the ledger rows, any order
 * @param {Array}   lots      this material's YarnLots (lean or docs)
 * @param {Array}   inwards   MaterialInward rows for this material
 * @param {Array}   outwards  MaterialOutward rows for this material
 *
 * @returns {Array} one entry per movement, in the SAME ORDER, shaped
 *   `{ lotNo, yarnLot, lotDerived }`. `lotNo` is '' when no honest
 *   answer exists — the caller renders that as unplaced rather than
 *   blank, because "this material has lots and this row is not on one"
 *   and "nobody knows" are different statements.
 */
function attributeMovements({
  material = {},
  movements = [],
  lots = [],
  inwards = [],
  outwards = [],
} = {}) {
  const tracked = isLotTracked(material.category);

  // Oldest first, once, rather than per row.
  const oldestFirst = [...lots].sort(
    (a, b) => new Date(a.receivedDate || 0) - new Date(b.receivedDate || 0)
  );

  const none = { lotNo: '', yarnLot: null, lotDerived: false };

  return movements.map((raw) => {
    const row = typeof raw?.toObject === 'function' ? raw.toObject() : { ...(raw || {}) };

    // Already stamped on the row by the writer. Batch paths know their
    // lot exactly, so nothing here should second-guess it — and an
    // adjustment written through a path that recorded the lot inline
    // gets the same respect.
    const stamped = str(row.lotNo).trim();
    if (stamped || row.yarnLot) {
      return {
        lotNo: stamped,
        yarnLot: row.yarnLot ? String(idOf(row.yarnLot)) : null,
        lotDerived: false,
      };
    }

    if (EXACT_TYPES.has(row.type)) {
      // A batch row with no lot on it is a writer bug, not something to
      // paper over with an inference — it would read as a recorded fact.
      return none;
    }

    if (RECORDED_TYPES.has(row.type)) {
      const found =
        row.type === 'PO_INWARD'
          ? recordedInwardLot(row, inwards)
          : recordedAdjustLot(row, outwards);
      if (found) return { ...found, lotDerived: false };
      // Falls through: a receipt whose lot was never keyed in, or an
      // adjustment that named none. For a warp yarn the earlier-lot
      // rule below still gives a reading; for anything else, nothing.
    }

    if (!tracked) return none;

    const lot = earliestLotBy(row.date, oldestFirst);
    if (!lot) return none;

    return {
      lotNo: str(lot.lotNo).trim(),
      yarnLot: lot._id ? String(lot._id) : null,
      lotDerived: true,
    };
  });
}

/**
 * Fold the attributions back onto their rows.
 *
 * Kept separate so the decision above can be tested without a shape,
 * and so a caller that wants the attributions alone (a report grouping
 * by lot) does not have to clone every movement to get them.
 */
function withLots(movements = [], attributions = []) {
  return movements.map((raw, i) => {
    const row = typeof raw?.toObject === 'function' ? raw.toObject() : { ...(raw || {}) };
    const a = attributions[i] || { lotNo: '', yarnLot: null, lotDerived: false };
    return { ...row, lotNo: a.lotNo, yarnLot: a.yarnLot, lotDerived: a.lotDerived };
  });
}

module.exports = {
  attributeMovements,
  withLots,
  earliestLotBy,
  RECORDED_TYPES,
  EXACT_TYPES,
};

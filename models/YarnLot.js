'use strict';

const mongoose = require('mongoose');

/**
 * 🧶 YARN LOT — a dyed lot of one raw material, tracked as its own bucket.
 *
 * Yarn arrives dyed in lots, and every lot takes the dye slightly
 * differently. Two lots that are nominally the same colour will show a
 * visible shade band if they meet inside one beam, so the floor warps a
 * batch from a known lot and needs to know, months later, which lot ended
 * up in which beam. That is what this collection is for.
 *
 * ── Relationship to RawMaterial.stock ──────────────────────────────────
 * These two counters measure different things and are NOT expected to
 * agree. Read this before "fixing" the discrepancy:
 *
 *   • `RawMaterial.stock` is the commercial balance. It is debited once,
 *     at order approval, when the requirement is committed to an order
 *     (services/orderService.js).
 *   • `YarnLot.consumedQty` is the physical draw. It moves later and
 *     elsewhere — when a warping batch actually pulls cones off the rack.
 *
 * So issuing a batch deliberately does NOT touch `RawMaterial.stock`;
 * doing so would debit the same yarn twice and quietly corrupt every
 * stock figure in the system. Lot balances are a subdivision of stock for
 * traceability, not a second system of record for it.
 *
 * Lots are also only as complete as the lot numbers that were keyed in.
 * Stock received without a lot number never becomes a YarnLot, so the sum
 * of lot balances is a floor on the yarn present, never the whole of it.
 */

/**
 * One movement on a lot.
 *
 * `quantity` is the DELTA to the lot's balance, so a draw is negative —
 * the same convention as RawMaterial.stockMovements, deliberately, so
 * the two ledgers cannot be read with opposite sign rules.
 */
const YarnLotMovementSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, default: Date.now },
    /** INWARD | BATCH_ISSUE | BATCH_RETURN | ADJUST */
    type: { type: String, required: true },
    quantity: { type: Number, required: true },
    /** The lot's balance immediately after this row. */
    balance: { type: Number },

    // What caused it. A batch for an issue or a return, an inward for a
    // credit; a reason for an adjustment, which has no document.
    warpingBatch: { type: mongoose.Types.ObjectId, ref: 'WarpingBatch' },
    inward: { type: mongoose.Types.ObjectId, ref: 'MaterialInward' },
    /** Human-facing number, snapshotted so the row survives a deletion. */
    refNo: { type: String, trim: true, default: '' },
    reason: { type: String, trim: true, default: '' },
    by: { type: mongoose.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const YarnLotSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },

    /** The dyer's lot number, as printed on the bag. */
    lotNo: {
      type: String,
      required: true,
      trim: true,
    },

    /** Shade / colour name for this lot, when the dyer gives one. */
    shade: { type: String, trim: true, default: '' },

    supplier: { type: mongoose.Types.ObjectId, ref: 'Supplier' },

    /** The dye house, when it differs from the yarn supplier. */
    dyer: { type: String, trim: true, default: '' },

    receivedDate: { type: Date, default: Date.now },

    // ── Quantities, in the material's unit (kg for yarn) ──────────────
    // receivedQty accumulates across every inward carrying this lot
    // number: a lot commonly arrives in more than one delivery.
    receivedQty: { type: Number, default: 0, min: 0 },
    consumedQty: { type: Number, default: 0, min: 0 },

    /**
     * open        — available to issue
     * exhausted   — drawn down to nothing; set automatically on issue
     * quarantined — held back (shade complaint, wrong count). Never issued.
     * closed      — written off / returned; the remainder is not usable
     */
    status: {
      type: String,
      enum: ['open', 'exhausted', 'quarantined', 'closed'],
      default: 'open',
    },

    remarks: { type: String, trim: true, default: '' },

    /** The inward rows that credited this lot, for drill-down. */
    inwards: [{ type: mongoose.Types.ObjectId, ref: 'MaterialInward' }],

    /**
     * This lot's own ledger.
     *
     * `receivedQty` and `consumedQty` are running totals, and a running
     * total cannot be audited: it says a lot has 40 kg left without
     * saying when the rest went or who took it. Every move through
     * services/yarnLotService.js appends a row here, so the balance can
     * always be explained rather than merely trusted.
     *
     * Capped like RawMaterial.stockMovements, and for the same reasons —
     * an unbounded array on a hot document marches toward the 16 MB
     * ceiling and is dragged along by every read of the lot.
     */
    movements: {
      type: [YarnLotMovementSchema],
      default: [],
      select: false,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** What is left on the rack. Never negative — issue refuses to overdraw. */
YarnLotSchema.virtual('balance').get(function balance() {
  return Math.max(0, (this.receivedQty || 0) - (this.consumedQty || 0));
});

/** A lot can be drawn from only while it is open and has something left. */
YarnLotSchema.virtual('issuable').get(function issuable() {
  return this.status === 'open' && this.balance > 0;
});

/**
 * How long this lot has been on the rack, in whole days.
 *
 * Dyed yarn is not indefinitely interchangeable with itself: a lot that
 * has sat for months is the one to use up first, and the one to look at
 * when a shade complaint arrives. The rack has no way to show this, so
 * the system has to.
 */
YarnLotSchema.virtual('ageDays').get(function ageDays() {
  const from = this.receivedDate ? new Date(this.receivedDate).getTime() : null;
  if (!from) return null;
  return Math.max(0, Math.floor((Date.now() - from) / 86_400_000));
});

/**
 * The age bucket, using the same vocabulary as the pending-PO ageing
 * report so one word means one thing across the system.
 *
 * Only meaningful while the lot still holds something — an exhausted
 * lot's age is history, not a thing to act on.
 */
YarnLotSchema.virtual('ageBucket').get(function ageBucket() {
  const days = this.ageDays;
  if (days == null || this.balance <= 0) return null;
  if (days <= 30) return 'fresh';
  if (days <= 90) return 'watch';
  if (days <= 180) return 'late';
  return 'critical';
});

/** Cap on the embedded ledger — see the note on RawMaterial. */
YarnLotSchema.statics.MAX_EMBEDDED_MOVEMENTS = 200;

// One bucket per (material, lot number) — a second delivery of the same
// lot tops up the existing bucket rather than opening a rival one. The
// unique index is what makes that safe when two inwards land together.
YarnLotSchema.index({ rawMaterial: 1, lotNo: 1 }, { unique: true });
// The lot picker on the batch screen lists open lots, newest first.
YarnLotSchema.index({ rawMaterial: 1, status: 1, receivedDate: -1 });
// Tracing a shade complaint starts from a lot number alone, with no idea
// which material it belonged to.
YarnLotSchema.index({ lotNo: 1 });

module.exports = mongoose.model('YarnLot', YarnLotSchema);

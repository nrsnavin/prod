// utils/elasticStock.js
// ─────────────────────────────────────────────────────────────
//  Elastic stock-movement helper.
//
//  Every change to Elastic.stock must go through applyMovement so
//  the ledger and the running balance stay in lock-step.
//
//  TWO BALANCES, ONE WRITER
//
//  `stock` is goods in the building. `reservedStock` is how much of
//  those goods is already promised to an approved order. They move
//  independently and sometimes together, and both belong here: while
//  reservations were maintained by hand at each call site, no ledger
//  row could state the reserved balance, and a dispatch against a
//  reservation released the promise without shipping the goods.
//
//  A movement carries a delta for each:
//    quantity         — goods delta   (+in, −out)
//    reservedQuantity — promise delta (+held, −released)
//
//  and each is recorded twice on the ledger row: what was asked for
//  and what could be applied. Both balances floor at zero, so either
//  side can move by less than the caller wanted, and a row that stated
//  only the applied figure left no way to tell a release of 250 from a
//  release of 400 that ran out of promise to give back.
//
//  Reserving goods creates none, so RESERVATION_HOLD moves only the
//  promise. Shipping keeps a promise AND empties a shelf, so DC_OUT
//  moves both. Available to promise is stock − reservedStock, derived
//  on read and never stored.
//
//  Atomicity model:
//   1. Read current stock and reservedStock from Elastic.
//   2. Compute the clamped deltas (both floor at 0).
//   3. findOneAndUpdate with { _id, stock, reservedStock } all at the
//      observed values, so the write only lands if no concurrent
//      writer moved either in between. On miss we retry up to
//      MAX_RETRIES times.
//   4. Insert the matching StockMovement row carrying both balances.
//
//  Both the Elastic update and the StockMovement insert run inside
//  the caller-supplied session, so they commit or roll back as a
//  single unit.
//
//  Magnitude guard: |quantity| > MAX_ABS_QUANTITY is rejected so a
//  rogue caller (UI typo, malformed payload) can't blow up the
//  ledger.
//
//  TO THE MILLIMETRE
//
//  Quantities are metres and the forms take two decimal places. Plain
//  floating-point sums do not keep them: 2224.3 − 36.1 is
//  2188.2000000000003, and the difference read back is
//  36.09999999999991 — less than the 36.1 that was asked for, which a
//  challan took for a shortfall. Both balances and both applied figures
//  are therefore rounded to three places, and the balance is WRITTEN
//  (under the same observed-values filter) rather than incremented, so
//  what is stored is the rounded figure and not the database's own sum.
// ─────────────────────────────────────────────────────────────
"use strict";

const Elastic       = require("../models/Elastic");
const StockMovement = require("../models/StockMovement");

const VALID_TYPES = [
  "PACKING_INWARD",
  "PACKING_REVERSE",
  "DC_OUT",
  "DC_CANCEL_RETURN",
  "WASTAGE_OUT",
  "WASTAGE_RETURN",
  "MANUAL_ADJUST",
  "RESERVATION_HOLD",
  "RESERVATION_RELEASE",
];

/**
 * Movements that move the promise rather than the goods.
 *
 * The type carries the direction, so callers pass a magnitude as
 * `quantity` and it is read across to the reserved side here — rather
 * than every call site having to remember which way its own sign goes.
 */
const RESERVATION_TYPES = { RESERVATION_HOLD: +1, RESERVATION_RELEASE: -1 };

const MAX_RETRIES      = 5;
const MAX_ABS_QUANTITY = 1e7;

/** A quantity to three decimal places (see TO THE MILLIMETRE above). */
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

async function applyMovement(session, opts) {
  const {
    elasticId,
    type,
    quantity,
    reservedQuantity,
    refType,
    refId,
    reason,
    by,
    alsoIncProduced = false,
  } = opts || {};

  if (!elasticId) {
    throw new Error("applyMovement: elasticId is required");
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`applyMovement: invalid type '${type}'`);
  }

  const sign = RESERVATION_TYPES[type];
  // A HOLD of 400 raises the promise by 400 and ships nothing; a
  // RELEASE of 400 lowers it. Callers pass the magnitude either way.
  const requested = sign ? 0 : Number(quantity);
  const reservedRequested = sign
    ? sign * Math.abs(Number(quantity) || 0)
    : Number(reservedQuantity) || 0;

  if (!Number.isFinite(requested) || !Number.isFinite(reservedRequested)) {
    throw new Error("applyMovement: quantity must be a finite number");
  }
  const biggest = Math.max(Math.abs(requested), Math.abs(reservedRequested));
  if (biggest > MAX_ABS_QUANTITY) {
    throw new Error(
      `applyMovement: |quantity| ${biggest} exceeds safety cap ${MAX_ABS_QUANTITY}`
    );
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await Elastic.findById(elasticId).session(session);
    if (!current) {
      throw new Error(`applyMovement: Elastic ${elasticId} not found`);
    }

    // Legacy guard: docs created before the `stock` field existed
    // have stock === undefined. The CAS filter below uses an exact
    // match, and Mongo will not match `{ stock: 0 }` against a doc
    // with the field missing, so the retry loop would spin until
    // exhausted. Backfill once here so subsequent attempts succeed.
    if (current.stock === undefined || current.stock === null) {
      await Elastic.updateOne(
        { _id: elasticId, stock: { $exists: false } },
        { $set: { stock: 0 } },
        { session }
      );
      current.stock = 0;
    }
    // Same guard for the promise side: an exact-match CAS cannot match
    // a field that is not there, and the loop would spin to exhaustion.
    if (current.reservedStock === undefined || current.reservedStock === null) {
      await Elastic.updateOne(
        { _id: elasticId, reservedStock: { $exists: false } },
        { $set: { reservedStock: 0 } },
        { session }
      );
      current.reservedStock = 0;
    }

    const currentStock = Number(current.stock) || 0;
    const newStock     = round3(Math.max(0, currentStock + requested));
    const applied      = round3(newStock - currentStock);

    // Reserved has no ceiling of its own: an order approved before the
    // goods exist promises more than is on the shelf, and that gap is a
    // production requirement, not a data error. Available reads as zero
    // and the shortfall is visible where it belongs.
    const currentReserved = Number(current.reservedStock) || 0;
    const newReserved     = round3(Math.max(0, currentReserved + reservedRequested));
    const reservedApplied = round3(newReserved - currentReserved);

    // The balances are set to the rounded figures worked out above. The
    // filter below only matches while both are still what was read, so
    // setting them is as safe as incrementing — and leaves no stray
    // 0.0000000000003 on the shelf.
    const update = {};
    if (applied || reservedApplied) {
      update.$set = {};
      if (applied) update.$set.stock = newStock;
      if (reservedApplied) update.$set.reservedStock = newReserved;
    }
    // Not in the filter, so it stays an increment.
    if (alsoIncProduced && applied) update.$inc = { quantityProduced: applied };

    const updated = Object.keys(update).length
      ? await Elastic.findOneAndUpdate(
          // Both observed values in the filter: a concurrent writer that
          // moved either one invalidates the arithmetic above.
          { _id: elasticId, stock: currentStock, reservedStock: currentReserved },
          update,
          { new: true, session }
        )
      : current;

    if (!updated) continue;

    const [persisted] = await StockMovement.create(
      [
        {
          elastic:   updated._id,
          date:      new Date(),
          type,
          requested,
          applied,
          balance:   Number(updated.stock) || 0,
          // Both halves of the promise side. `reservedApplied` alone
          // could not distinguish a release of 250 that was asked for
          // from one that was asked for as 400 and clamped at the floor.
          reservedRequested,
          reservedApplied,
          reservedBalance: Number(updated.reservedStock) || 0,
          refType:   refType || undefined,
          refId:     refId || undefined,
          reason:    reason || undefined,
          by:        by || undefined,
        },
      ],
      { session }
    );

    return { elastic: updated, movement: persisted };
  }

  throw new Error(
    `applyMovement: contention on Elastic ${elasticId} after ${MAX_RETRIES} retries`
  );
}

module.exports = { applyMovement, round3, VALID_TYPES, MAX_ABS_QUANTITY };

'use strict';

const mongoose = require('mongoose');
const YarnLot = require('../models/YarnLot');
const ErrorHandler = require('../utils/ErrorHandler');

/**
 * Lot bookkeeping — the only writer of YarnLot quantities.
 *
 * Every quantity move here is a single conditional update rather than a
 * read-modify-write. Two operators issuing from the same lot at the same
 * moment is not a hypothetical on a shop floor: it is what happens when
 * the supervisor and the warper both have the batch screen open. Reading
 * the balance and then writing it back would let both pass a check that
 * only one of them can honour, and the lot would go negative.
 */

/**
 * Credit yarn into a lot, opening the bucket on first sight.
 *
 * A lot commonly arrives across several deliveries, so this tops up an
 * existing bucket rather than opening a rival one — enforced by the
 * unique (rawMaterial, lotNo) index.
 */
async function creditLot(
  { rawMaterial, lotNo, quantity, shade, supplier, dyer, inward, receivedDate },
  session
) {
  const qty = Number(quantity) || 0;
  const lot = String(lotNo || '').trim();
  if (!lot || qty <= 0) return null;

  const opts = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) opts.session = session;

  const update = {
    $inc: { receivedQty: qty },
    $setOnInsert: {
      rawMaterial,
      lotNo: lot,
      receivedDate: receivedDate || new Date(),
      consumedQty: 0,
      status: 'open',
    },
  };
  // Only fill these in when supplied — a later delivery that omits the
  // shade must not blank the one recorded on the first.
  const set = {};
  if (shade) set.shade = String(shade).trim();
  if (dyer) set.dyer = String(dyer).trim();
  if (supplier) set.supplier = supplier;
  if (Object.keys(set).length) update.$set = set;
  if (inward) update.$addToSet = { inwards: inward };

  const doc = await YarnLot.findOneAndUpdate(
    { rawMaterial, lotNo: lot },
    update,
    opts
  );

  // A lot that had been drawn to nothing is live again now that more of
  // it has arrived. Quarantined and closed lots stay where they are —
  // reopening those is a decision for a person, not a delivery note.
  if (doc && doc.status === 'exhausted') {
    const q = YarnLot.updateOne({ _id: doc._id, status: 'exhausted' }, { $set: { status: 'open' } });
    if (session) q.session(session);
    await q;
    doc.status = 'open';
  }
  return doc;
}

/**
 * Draw `quantity` from a lot.
 *
 * The filter carries the balance check, so the update only matches while
 * the lot genuinely holds enough. A concurrent issue that got there first
 * leaves this one unmatched, and it fails rather than overdrawing.
 */
async function drawFromLot(lotId, quantity, session) {
  const qty = Number(quantity) || 0;
  if (qty <= 0) throw new ErrorHandler('Issue quantity must be greater than zero', 400);

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await YarnLot.findOneAndUpdate(
    {
      _id: lotId,
      status: 'open',
      $expr: { $gte: [{ $subtract: ['$receivedQty', '$consumedQty'] }, qty] },
    },
    { $inc: { consumedQty: qty } },
    opts
  );

  if (!updated) {
    // Say which of the two it was — "not enough left" and "someone
    // quarantined this lot" need different things from the operator.
    const q = YarnLot.findById(lotId);
    if (session) q.session(session);
    const lot = await q;
    if (!lot) throw new ErrorHandler('Yarn lot not found', 404);
    if (lot.status !== 'open') {
      throw new ErrorHandler(
        `Lot ${lot.lotNo} is ${lot.status} and cannot be issued`,
        409
      );
    }
    throw new ErrorHandler(
      `Lot ${lot.lotNo} has only ${lot.balance} left — cannot issue ${qty}`,
      409
    );
  }

  // Drawn to nothing: take it out of the picker so the next batch does
  // not have to discover the hard way that it is empty.
  if (updated.receivedQty - updated.consumedQty <= 0) {
    const q = YarnLot.updateOne({ _id: updated._id, status: 'open' }, { $set: { status: 'exhausted' } });
    if (session) q.session(session);
    await q;
    updated.status = 'exhausted';
  }
  return updated;
}

/**
 * Put `quantity` back — a cancelled batch, or a correction.
 *
 * `consumedQty` has a min of 0 on the schema, but $inc bypasses schema
 * validation entirely, so the floor is enforced in the filter here.
 */
async function returnToLot(lotId, quantity, session) {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return null;

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await YarnLot.findOneAndUpdate(
    { _id: lotId, $expr: { $gte: ['$consumedQty', qty] } },
    { $inc: { consumedQty: -qty } },
    opts
  );
  if (!updated) {
    // Crediting back more than was ever drawn means the caller's record
    // of the issue disagrees with the lot's. Refusing keeps the
    // disagreement visible instead of inventing yarn to paper over it.
    throw new ErrorHandler(
      'Cannot return more than was issued from this lot',
      409
    );
  }
  // It has stock again, so it belongs back in the picker. Quarantined and
  // closed lots keep their status — a return is not a clearance.
  if (updated.status === 'exhausted' && updated.receivedQty - updated.consumedQty > 0) {
    const q = YarnLot.updateOne({ _id: updated._id, status: 'exhausted' }, { $set: { status: 'open' } });
    if (session) q.session(session);
    await q;
    updated.status = 'open';
  }
  return updated;
}

/**
 * How much of a material's stock is already sitting in a named lot.
 *
 * Counts open and quarantined lots: both hold yarn that is physically
 * on the rack. Exhausted lots hold nothing, and a closed lot has been
 * written off or returned, so neither is standing on any stock.
 */
async function placedQuantity(rawMaterial, session) {
  // A malformed id has no lots by definition, and casting it would throw
  // — turning a detail page into a 500 over a bad query string.
  if (!mongoose.Types.ObjectId.isValid(String(rawMaterial))) return 0;

  const q = YarnLot.aggregate([
    { $match: { rawMaterial: new mongoose.Types.ObjectId(String(rawMaterial)),
                status: { $in: ['open', 'quarantined'] } } },
    { $group: { _id: null,
                placed: { $sum: { $subtract: ['$receivedQty', '$consumedQty'] } } } },
  ]);
  if (session) q.session(session);
  const [row] = await q;
  return Math.max(0, Number(row?.placed) || 0);
}

/**
 * Stock that exists but has not been assigned to any lot — the pool a
 * lot opened by hand is allowed to draw on.
 *
 * Opening a lot by hand used to take any number at all, so a material
 * holding 10 kg could carry a lot claiming 500. That is not a lot, it is
 * a guess with a number on it, and everything downstream (the picker,
 * the batch, the trace) then reads as fact.
 *
 * ── The awkward part, stated plainly ───────────────────────────────
 * `stock` is the commercial balance, debited at order approval; lot
 * balances are physical yarn, drawn later when a batch is issued. In the
 * window between the two, lots legitimately hold MORE than stock says,
 * and this returns 0 — manual entry is refused while the books and the
 * rack disagree. That is the honest answer: there is no unassigned stock
 * to hand out, and inventing some would paper over the very gap the
 * operator should be looking at.
 */
async function unplacedQuantity(material, session) {
  const stock = Number(material?.stock) || 0;
  const placed = await placedQuantity(material._id ?? material, session);
  return Math.max(0, Math.round((stock - placed) * 1000) / 1000);
}

module.exports = {
  creditLot,
  drawFromLot,
  returnToLot,
  placedQuantity,
  unplacedQuantity,
};

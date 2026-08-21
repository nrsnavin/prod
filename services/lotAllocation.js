'use strict';
// ══════════════════════════════════════════════════════════════════
//  EARMARKING DYE LOTS TO AN ORDER
//
//  Approving an order debits `RawMaterial.stock` — the commercial
//  balance — without saying which bags the yarn will come out of. For
//  dyed yarn that omission costs something real: two orders can both
//  plan against the same 200 kg of D-4471, and nobody finds out until
//  the second one reaches the rack.
//
//  An earmark is that missing sentence. It says "this order's draw is
//  expected to come from these lots", and it is the thing every
//  downstream picker is then measured against.
//
//  ── Earmarked is not consumed ────────────────────────────────────
//  This is the rule the whole file turns on. An earmark moves NOTHING
//  on the lot: `receivedQty` and `consumedQty` are untouched, and the
//  yarn is still physically on the rack. It leaves when a warping
//  batch draws it, which is the only thing that ever moves
//  `consumedQty` (services/yarnLotService.js).
//
//  So the three figures are:
//
//      balance    = received − consumed        what is on the rack
//      earmarked  = Σ live orders' promises    what is spoken for
//      free       = balance − earmarked        what a NEW order may take
//
//  ── And so a batch issue must reduce the earmark ─────────────────
//  When a batch draws 40 kg from a lot earmarked 100 kg to an order,
//  `balance` falls by 40. If the earmark stayed at 100, `free` would
//  drop by 80 for one 40 kg draw — the same yarn subtracted twice, in
//  the one place this file exists to prevent it. So consumption spends
//  the earmark down. See consumeEarmark below.
//
//  ── One writer ───────────────────────────────────────────────────
//  Earmarks live on the ORDER (Order.rawMaterialRequired[].lots) and
//  nowhere else. Mirroring the total onto YarnLot would give two
//  documents a claim on one fact with no way to tell which had
//  drifted, so the per-lot total is aggregated on demand here — the
//  way placedQuantity already aggregates lot balances.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Order = require('../models/Order');
const YarnLot = require('../models/YarnLot');
const ErrorHandler = require('../utils/ErrorHandler');

/**
 * Order states whose earmarks still hold yarn.
 *
 * A Completed order's yarn has been drawn and a Cancelled one's was
 * given back, so neither has any claim left. Deleted likewise. Listing
 * the LIVE states rather than excluding the dead ones is deliberate: a
 * status added later defaults to holding nothing, which is the safe
 * direction — the alternative silently grants a claim to a state
 * nobody thought about.
 */
const LIVE_ORDER_STATUSES = Object.freeze(['Approved', 'InProgress']);

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const idStr = (v) => (v && typeof v === 'object' ? String(v._id ?? v) : String(v ?? ''));

/**
 * How much of each lot is spoken for by live orders.
 *
 * @param {Array} lotIds
 * @param {{excludeOrder?: any, session?: any}} opts
 *   `excludeOrder` leaves one order's own earmarks out of the total,
 *   which is what an edit needs: re-saving 60 kg on a lot this order
 *   already holds 60 kg of must not read as wanting 120.
 * @returns {Promise<Map<string, number>>} lot id → kg earmarked
 */
async function allocatedByLot(lotIds = [], { excludeOrder, session } = {}) {
  const ids = [...new Set(lotIds.map(idStr).filter((s) => mongoose.Types.ObjectId.isValid(s)))]
    .map((s) => new mongoose.Types.ObjectId(s));
  const out = new Map();
  if (!ids.length) return out;

  const match = {
    status: { $in: LIVE_ORDER_STATUSES },
    'rawMaterialRequired.lots.yarnLot': { $in: ids },
  };
  if (excludeOrder && mongoose.Types.ObjectId.isValid(String(excludeOrder))) {
    match._id = { $ne: new mongoose.Types.ObjectId(String(excludeOrder)) };
  }

  const pipeline = [
    { $match: match },
    { $unwind: '$rawMaterialRequired' },
    { $unwind: '$rawMaterialRequired.lots' },
    { $match: { 'rawMaterialRequired.lots.yarnLot': { $in: ids } } },
    {
      $group: {
        _id: '$rawMaterialRequired.lots.yarnLot',
        qty: { $sum: '$rawMaterialRequired.lots.quantity' },
      },
    },
  ];

  const q = Order.aggregate(pipeline);
  if (session) q.session(session);
  for (const row of await q) out.set(String(row._id), round3(row.qty));
  return out;
}

/**
 * What a NEW order may earmark from a lot.
 *
 * Never negative: an over-earmarked lot (possible if a batch drew more
 * than the order had promised, or if a lot was written down) reports
 * zero free rather than a negative allowance nobody can act on.
 */
function freeBalance(lot, allocated = 0) {
  const balance = Number(lot?.balance ?? ((lot?.receivedQty || 0) - (lot?.consumedQty || 0))) || 0;
  return Math.max(0, round3(balance - (Number(allocated) || 0)));
}

/**
 * Validate one material's proposed earmarks against the lots and the
 * requirement.
 *
 * Pure — every fact it needs is passed in, so the rules can be tested
 * without a database. Returns the rows to store; throws with a message
 * naming the offending line.
 *
 * @param {Array}  rows      [{ yarnLot, quantity }] as submitted
 * @param {Array}  lots      YarnLot docs for this material
 * @param {Map}    allocated lot id → kg held by OTHER orders
 * @param {number} required  this material's requirement on the order
 */
function validateEarmarks(rows = [], lots = [], allocated = new Map(), required = 0) {
  const byId = new Map(lots.map((l) => [String(l._id), l]));
  const seen = new Set();
  const out = [];
  let total = 0;

  rows.forEach((r, i) => {
    const at = `Lot ${i + 1}`;
    const lotId = idStr(r.yarnLot);
    if (!mongoose.Types.ObjectId.isValid(lotId)) {
      throw new ErrorHandler(`${at}: choose a lot`, 400);
    }
    const lot = byId.get(lotId);
    if (!lot) {
      throw new ErrorHandler(`${at}: that lot is not on this material`, 400);
    }
    if (seen.has(lotId)) {
      throw new ErrorHandler(
        `${at}: ${lot.lotNo} is listed twice — combine the two lines`,
        400
      );
    }
    seen.add(lotId);

    const qty = round3(r.quantity);
    if (!(qty > 0)) {
      throw new ErrorHandler(`${at}: quantity must be more than zero`, 400);
    }

    // A quarantined or closed lot must not be newly promised to
    // anything. Earmarks already on such a lot are left alone — the
    // promise was made when it was open, and silently dropping it
    // would hide the problem rather than surface it.
    if (lot.status !== 'open') {
      throw new ErrorHandler(
        `${at}: ${lot.lotNo} is ${lot.status} and cannot be assigned`,
        400
      );
    }

    const free = freeBalance(lot, allocated.get(lotId) || 0);
    if (qty > free) {
      throw new ErrorHandler(
        `${at}: ${lot.lotNo} has ${free} kg free — ` +
          `the rest is already promised to other orders`,
        400
      );
    }

    total = round3(total + qty);
    out.push({
      yarnLot: lot._id,
      lotNo: lot.lotNo || '',
      shade: lot.shade || '',
      quantity: qty,
    });
  });

  // Partial is normal and allowed — a long-lead yarn gets earmarked as
  // it arrives. Promising MORE than the order needs is not: the surplus
  // would hold yarn out of everyone else's reach for nothing.
  const req = round3(required);
  if (req > 0 && total > req) {
    throw new ErrorHandler(
      `Assigned ${total} kg against a requirement of ${req} kg — ` +
        `remove ${round3(total - req)} kg`,
      400
    );
  }

  return out;
}

/**
 * The lots one order has earmarked, keyed by material.
 *
 * The shape every downstream reader wants: the MRP sheet joins it onto
 * a requirement row, and the warping batch checks an allocation
 * against it.
 *
 * @returns {Promise<Map<string, Array>>} material id → earmark rows
 */
async function earmarksForOrder(orderId, session) {
  const out = new Map();
  if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) return out;

  const q = Order.findById(orderId).select('rawMaterialRequired status').lean();
  if (session) q.session(session);
  const order = await q;
  if (!order) return out;

  for (const rm of order.rawMaterialRequired || []) {
    const rows = (rm.lots || []).filter((l) => Number(l.quantity) > 0);
    if (rows.length) out.set(String(rm.rawMaterial), rows);
  }
  return out;
}

/** The same, reached through a job — the MRP and the warping batch both start there. */
async function earmarksForJob(job, session) {
  const orderId = job?.order?._id ?? job?.order;
  return earmarksForOrder(orderId, session);
}

/**
 * Spend an order's earmark down as a batch actually draws the yarn.
 *
 * Without this the same kilos are subtracted twice from a lot's free
 * balance — once as consumption and once as a promise that is no
 * longer outstanding. See the note at the top of this file.
 *
 * Clamped at zero rather than allowed to go negative: a batch may draw
 * more than the order promised (the floor found it needed another
 * bag), and that overdraw is a fact about the lot, not a negative
 * promise. It shows up as consumption, which is where it belongs.
 *
 * Best effort by design — returns false when there is nothing to
 * spend, which is the ordinary case for an order that never earmarked
 * anything.
 */
async function consumeEarmark(orderId, materialId, lotId, quantity, session) {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return false;
  if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) return false;

  const q = Order.findById(orderId).session(session || null);
  const order = await q;
  if (!order) return false;

  const rm = (order.rawMaterialRequired || []).find(
    (r) => String(r.rawMaterial) === String(materialId)
  );
  if (!rm || !rm.lots?.length) return false;

  const row = rm.lots.find((l) => String(l.yarnLot) === String(lotId));
  if (!row) return false;

  const next = round3(Math.max(0, (Number(row.quantity) || 0) - qty));
  if (next === Number(row.quantity)) return false;

  row.quantity = next;
  // A promise drawn to nothing is not a promise. Leaving a 0 kg row on
  // the order would show the floor a lot that is still committed when
  // every kilo of it has already been warped.
  if (next === 0) {
    rm.lots = rm.lots.filter((l) => String(l.yarnLot) !== String(lotId));
  }
  await order.save({ session });
  return true;
}

/**
 * Drop every earmark on an order.
 *
 * Called when an order reaches a state that holds no yarn — Completed,
 * where the batches have already drawn it, or Cancelled, where it was
 * given back.
 *
 * MUTATES BUT DOES NOT SAVE, matching releaseAllReservations in
 * orderReservations.js deliberately: both are called from inside a
 * transaction that has other writes to make on the same document, and
 * two functions with opposite contracts on one object is how a save
 * gets missed. consumeEarmark below does save, because its caller has
 * not opened the order for anything else.
 *
 * Idempotent: an order with nothing earmarked is left untouched and
 * reports 0.
 *
 * @returns {number} kg released, for the audit line
 */
function releaseAllEarmarks(order) {
  if (!order?.rawMaterialRequired?.length) return 0;
  let released = 0;
  for (const rm of order.rawMaterialRequired) {
    for (const l of rm.lots || []) released = round3(released + (Number(l.quantity) || 0));
    if (rm.lots?.length) rm.lots = [];
  }
  return released;
}

/**
 * The lots of one material, each with what is free after other orders.
 *
 * What a lot picker needs in one call. Open lots only — a quarantined
 * lot cannot be newly promised, and offering it would mean explaining
 * the refusal after the choice rather than before it.
 */
async function assignableLots(materialId, { excludeOrder, session } = {}) {
  if (!materialId || !mongoose.Types.ObjectId.isValid(String(materialId))) return [];

  const q = YarnLot.find({ rawMaterial: materialId, status: 'open' })
    .sort({ receivedDate: 1 });
  if (session) q.session(session);
  const lots = await q;
  if (!lots.length) return [];

  const allocated = await allocatedByLot(lots.map((l) => l._id), { excludeOrder, session });

  return lots
    .map((l) => ({
      yarnLot: String(l._id),
      lotNo: l.lotNo || '',
      shade: l.shade || '',
      balance: l.balance,
      ageDays: l.ageDays,
      allocated: allocated.get(String(l._id)) || 0,
      free: freeBalance(l, allocated.get(String(l._id)) || 0),
    }))
    // A lot with nothing free is not assignable, and listing it invites
    // a choice the save would then refuse.
    .filter((l) => l.free > 0);
}

module.exports = {
  LIVE_ORDER_STATUSES,
  allocatedByLot,
  freeBalance,
  validateEarmarks,
  earmarksForOrder,
  earmarksForJob,
  consumeEarmark,
  releaseAllEarmarks,
  assignableLots,
};

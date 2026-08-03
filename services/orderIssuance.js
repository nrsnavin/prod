'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT AN ORDER HAS ALREADY TAKEN OUT OF STOCK
//
//  Approving an order draws its raw material out of stock there and
//  then: `RawMaterial.stock` afterwards is the balance with this
//  order's needs already removed. Every requirement sheet drawn after
//  that point was still comparing the FULL requirement against that
//  reduced balance, so an order whose yarn had been bought, received
//  and drawn read as short of the very yarn it was standing on — and
//  the shortfall panel offered to buy it again.
//
//  The authority is the outward log, not a flag on the order: it
//  carries the quantity ACTUALLY applied, which under a forced
//  approval is less than the requirement, and it is marked `reversed`
//  when a cancel refunds it. Deriving from it means a refund shows up
//  here with nothing else to maintain.
// ══════════════════════════════════════════════════════════════════

const MaterialOutward = require('../models/MaterialOut.cjs');

/**
 * Raw material already drawn from stock on behalf of one order.
 *
 * @param   {ObjectId|string} orderId
 * @returns {Promise<Map<string, number>>} material id → kg drawn
 */
async function issuedForOrder(orderId, session = undefined) {
  if (!orderId) return new Map();

  const rows = await MaterialOutward.find({
    order: orderId,
    type: 'ORDER_APPROVAL',
    // A cancelled order's draw was handed back; it is not provisioning
    // anything any more.
    reversed: { $ne: true },
  })
    .select('rawMaterial quantity')
    .session(session || null)
    .lean();

  const drawn = new Map();
  for (const r of rows) {
    const key = String(r.rawMaterial ?? '');
    if (!key) continue;
    const qty = Number(r.quantity) || 0;
    if (qty > 0) drawn.set(key, (drawn.get(key) || 0) + qty);
  }
  return drawn;
}

/**
 * One job's share of its parent order's draw.
 *
 * A job is a slice of the order, and the order's material came out of
 * stock in one movement covering all of them. Splitting it by each
 * job's share of the requirement is the only division the data
 * supports — nothing records which kilo was meant for which run — and
 * on the common single-job order it is exact.
 *
 * @param {Map<string, number>} orderDrawn   material id → kg the order drew
 * @param {Array}  orderRequirement  the order's rawMaterialRequired rows
 * @param {Array}  jobRequirement    rows from computeMaterialRequirement
 * @returns {Map<string, number>} material id → kg attributable to this job
 */
function shareForJob(orderDrawn, orderRequirement = [], jobRequirement = []) {
  const share = new Map();
  if (!orderDrawn || orderDrawn.size === 0) return share;

  const orderNeeds = new Map();
  for (const rm of orderRequirement || []) {
    const key = String(rm.rawMaterial ?? '');
    if (!key) continue;
    orderNeeds.set(key, (orderNeeds.get(key) || 0) + (Number(rm.requiredWeight) || 0));
  }

  for (const row of jobRequirement || []) {
    const key = String(row.rawMaterial ?? '');
    const drawn = orderDrawn.get(key) || 0;
    if (drawn <= 0) continue;

    const jobNeeds = Number(row.requiredWeight) || 0;
    const total = orderNeeds.get(key) || 0;
    // No recorded order requirement to divide by — an order predating
    // the stored requirement, or a job carrying an elastic the order
    // does not. Attributing the whole draw would credit this job with
    // material meant for its siblings, so credit none of it and let
    // the sheet read as it did before.
    if (total <= 0) continue;

    share.set(key, Math.min(jobNeeds, (drawn * jobNeeds) / total));
  }
  return share;
}

module.exports = { issuedForOrder, shareForJob };

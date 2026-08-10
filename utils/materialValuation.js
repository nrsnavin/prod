'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE YARN ON THE SHELF IS WORTH
//
//  Until now a material carried one `price` — the latest purchase
//  price — and every issue was costed at it. On a volatile yarn market
//  that is wrong in a specific and expensive direction: buy 100 kg at
//  ₹300, buy 100 kg at ₹360, and every one of the 200 kg is suddenly
//  valued at ₹360, including the half that cost ₹300. Consumption is
//  over-stated, margin is under-stated, and the error moves every time
//  a supplier changes their quote.
//
//  So a material now also carries `avgCost`: the weighted average of
//  what its stock actually cost.
//
//      newAvg = (stockOnHand × avgCost + received × receiptPrice)
//               ÷ (stockOnHand + received)
//
//  ── Why weighted average and not FIFO ────────────────────────────
//  FIFO needs a layer per receipt and a rule for which layer an issue
//  consumes. That is the right answer when the physical stock is
//  genuinely segregated and traceable — which for a dyed yarn LOT it
//  is, and YarnLot already tracks it. But cones of the same undyed
//  yarn from three purchases sit in one rack and are drawn from
//  whichever is nearest. Costing them as if they were consumed in
//  purchase order would be a fiction with more decimal places, not
//  more truth. Weighted average matches how the material is actually
//  handled, and it is what Indian AS-2 / Ind AS-2 permits for exactly
//  this case.
//
//  ── The rules ────────────────────────────────────────────────────
//  Receipt      recomputes the average — this is the only thing that
//               does.
//  Issue        consumes at the current average; the average itself is
//               unchanged, which is the whole point of averaging.
//  Return       comes back at exactly what it left at, and moves the
//               average like any other receipt. This needs no new
//               machinery: a cancelled order is refunded by walking the
//               MaterialOutward rows its approval wrote, and each of
//               those already carries the unit cost it was issued at.
//               Returning it at TODAY's average instead would credit
//               the shelf with value the yarn never had — a cancel
//               after a price rise would quietly create money.
//  Adjustment   changes quantity, never cost. A count that finds 5 kg
//               missing has not changed what the rest of it cost.
//  Zero stock   keeps the last average rather than resetting to 0, so
//               the first issue after a stock-out is not costed at
//               nothing while a receipt is in transit.
//
//  `price` is left alone and keeps its old meaning: the latest
//  purchase price, which is what a new PO should default to. It is no
//  longer what anything is costed at.
// ══════════════════════════════════════════════════════════════════

const RawMaterial = require('../models/RawMaterial');

/** Money per kg. Four places, because a rate can be ₹342.6875. */
const COST_DP = 4;

const round = (v, dp = COST_DP) => {
  const f = 10 ** dp;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
};

/**
 * The average after taking `qty` in at `unitCost`.
 *
 * Pure, so the arithmetic can be tested without a database — and it is
 * the arithmetic, not the plumbing, that costs money when it is wrong.
 *
 * @param {number} stock     on hand before the receipt
 * @param {number} avgCost   average before the receipt
 * @param {number} qty       received (> 0)
 * @param {number} unitCost  what this receipt cost per unit
 * @param {number} [fallbackCost] the material's `price`, used as the
 *        basis when it has no average yet. receiveAtCost passes it, so
 *        this function and the database pipeline agree on legacy rows:
 *        100 kg with no average but a price of 300, taking 100 kg at
 *        360, must average to 330 — not jump to 360 as it would if the
 *        stock already on the shelf were treated as costing nothing.
 */
function nextAverage(stock, avgCost, qty, unitCost, fallbackCost = 0) {
  const onHand = Math.max(Number(stock) || 0, 0);
  const inQty  = Math.max(Number(qty) || 0, 0);
  const inCost = Math.max(Number(unitCost) || 0, 0);

  const avg = Math.max(Number(avgCost) || 0, 0);
  const basis = avg > 0 ? avg : Math.max(Number(fallbackCost) || 0, 0);

  const total = onHand + inQty;
  if (total <= 0) return basis;

  // A receipt with no price recorded must not drag the average to
  // zero. It is missing information, not free yarn — so the existing
  // basis stands and the gap is reported elsewhere.
  if (inCost <= 0) return basis;

  // Equally, stock that arrived before any of this existed and carries
  // no price either has no cost basis at all. Taking the first priced
  // receipt is better than averaging against a zero that was never a
  // real cost.
  if (basis <= 0) return round(inCost);

  return round((onHand * basis + inQty * inCost) / total);
}

/**
 * What one unit of this material is currently worth.
 *
 * Falls back to `price` for a material that has never been received
 * since averaging existed — its latest purchase price is the best
 * estimate available, and is what it was being costed at before.
 * Works on a lean object as well as a document.
 */
function costOf(material) {
  const avg = Number(material?.avgCost) || 0;
  if (avg > 0) return avg;
  return Number(material?.price) || 0;
}

/**
 * Take stock in and move the average, atomically.
 *
 * Done as an aggregation-pipeline update rather than read-modify-write
 * so two receipts landing together cannot each compute an average from
 * the same stale figure and have the second overwrite the first. The
 * pipeline's first stage reads `$stock` before the second stage
 * changes it, which is what makes the order of the stages load-bearing.
 *
 * @returns {Promise<object|null>} the material after the receipt
 */
async function receiveAtCost(materialId, qty, unitCost, session) {
  const inQty  = Math.max(Number(qty) || 0, 0);
  const inCost = Math.max(Number(unitCost) || 0, 0);
  if (inQty <= 0) return RawMaterial.findById(materialId).session(session || null);

  const onHand = { $max: [{ $ifNull: ['$stock', 0] }, 0] };
  // An unpriced material falls back to `price` for the same reason
  // costOf does — see above.
  const oldAvg = {
    $max: [
      { $ifNull: ['$avgCost', 0] },
      0,
    ],
  };
  const basis = {
    $cond: [{ $gt: [oldAvg, 0] }, oldAvg, { $max: [{ $ifNull: ['$price', 0] }, 0] }],
  };

  return RawMaterial.findOneAndUpdate(
    { _id: materialId },
    [
      {
        $set: {
          avgCost: {
            $cond: [
              // No price on the receipt: keep what we had rather than
              // averaging in a zero that was never a cost.
              { $lte: [inCost, 0] },
              basis,
              {
                $cond: [
                  { $lte: [basis, 0] },
                  round(inCost),
                  {
                    $round: [
                      {
                        $divide: [
                          {
                            $add: [
                              { $multiply: [onHand, basis] },
                              inQty * inCost,
                            ],
                          },
                          { $add: [onHand, inQty] },
                        ],
                      },
                      COST_DP,
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      // Second, so the average above was computed against the stock as
      // it stood BEFORE this receipt.
      { $set: { stock: { $add: [{ $ifNull: ['$stock', 0] }, inQty] } } },
    ],
    { new: true, ...(session ? { session } : {}) }
  );
}

module.exports = { nextAverage, costOf, receiveAtCost, round, COST_DP };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDERS DUE SOON WITH GOODS STILL OWED
//
//  The list behind "N orders at delivery risk — soonest in 2d, with
//  pending production" (GET /order/delivery-risk).
//
//  WHAT "PENDING" HAS TO MEAN HERE. It was read off `pendingElastic`,
//  and that field is not what is left to make: it is what no job has
//  been raised for yet (services/orderPending.js — ordered less planned).
//  The two are opposite ends of the work. An order due tomorrow, planned
//  onto jobs in full and with not a metre woven, has nothing "pending"
//  in that sense and was never on the list; the only orders that were
//  on it were the ones somebody had not finished planning.
//
//  What the customer is still owed is what was ordered less what is
//  packed — the figure the order page calls pending delivery. That is
//  what is counted, line by line (a line packed over its quantity does
//  not pay for another that is behind). What is not yet planned is kept
//  beside it, because it is the first thing to do about such an order.
//
//  DAYS ARE DAYS. The promised date is a calendar date. Counting the
//  hours to its midnight and rounding up called an order due today "1
//  day away" until half past five in the morning, and let the horizon's
//  last day in or out depending on the hour the page was opened.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const { round3 } = require('../utils/quantity');

/** Orders that can still ship: not completed, cancelled or deleted. */
const OPEN_STATUSES = Object.freeze(['Open', 'Approved', 'InProgress']);

const MAX_HORIZON_DAYS = 365;

/** A horizon in whole days, 1 to 365; anything unreadable is a week. */
function readHorizon(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(MAX_HORIZON_DAYS, n);
}

const idOf = (row) => String(row?.elastic?._id ?? row?.elastic ?? '');

function quantities(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const id = idOf(r);
    if (id) by.set(id, (by.get(id) || 0) + (Number(r.quantity) || 0));
  }
  return by;
}

/** What the customer is still owed: ordered less packed, line by line. */
function stillOwed(order) {
  const packed = quantities(order?.packedElastic);
  let total = 0;
  for (const line of order?.elasticOrdered || []) {
    total += Math.max(0, (Number(line.quantity) || 0) - (packed.get(idOf(line)) || 0));
  }
  return round3(total);
}

/**
 * The same figure worked out in the database, for the reports that add
 * it up over many orders (the order book report, the morning digest):
 * each ordered line less what is packed of that elastic, never below
 * nothing, added together. Tested against `stillOwed` so the list and
 * the totals cannot come to mean different things.
 */
const STILL_OWED_EXPR = Object.freeze({
  $sum: {
    $map: {
      input: { $ifNull: ['$elasticOrdered', []] },
      as: 'line',
      in: {
        $max: [0, {
          $subtract: [
            { $ifNull: ['$$line.quantity', 0] },
            {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$packedElastic', []] },
                      as: 'box',
                      cond: { $eq: ['$$box.elastic', '$$line.elastic'] },
                    },
                  },
                  as: 'box',
                  in: { $ifNull: ['$$box.quantity', 0] },
                },
              },
            },
          ],
        }],
      },
    },
  },
});

/** Of what was ordered, what no job has been raised for. */
function notPlanned(order) {
  let total = 0;
  for (const row of order?.pendingElastic || []) total += Math.max(0, Number(row.quantity) || 0);
  return round3(total);
}

/**
 * The first moment past the horizon, for the query that fetches the
 * candidates. A day wider than the horizon on purpose: promised dates
 * are kept at their day's UTC midnight, and older ones at India's
 * midnight (18:30 the evening before), so the rows are held to the
 * exact day by `deliveryRisk` and this only has to miss none of them.
 */
function fetchBefore(now, horizonDays) {
  const today = factoryDay.calendarDay(now) || factoryDay.calendarDay();
  return new Date(today.getTime() + (horizonDays + 1) * factoryDay.DAY);
}

/**
 * @param {Array}  orders  lean orders: orderNo, customer (name), status, supplyDate,
 *                         elasticOrdered, packedElastic, pendingElastic
 * @returns {Array} the ones due inside the horizon with goods still owed, soonest first
 */
function deliveryRisk(orders, { now = new Date(), horizonDays = 7 } = {}) {
  const rows = [];
  for (const o of orders || []) {
    if (!OPEN_STATUSES.includes(o.status)) continue;
    const daysToSupply = factoryDay.daysBetween(now, o.supplyDate);
    // No promised date: nothing to be late against.
    if (daysToSupply == null || daysToSupply > horizonDays) continue;
    const pendingUnits = stillOwed(o);
    if (pendingUnits <= 0) continue;
    rows.push({
      orderId:      o._id,
      orderNo:      o.orderNo,
      customerName: o.customer?.name ?? '—',
      status:       o.status,
      supplyDate:   o.supplyDate,
      // Negative once the date has passed.
      daysToSupply,
      pendingUnits,
      notPlanned:   Math.min(pendingUnits, notPlanned(o)),
    });
  }
  rows.sort((a, b) => a.daysToSupply - b.daysToSupply || b.pendingUnits - a.pendingUnits);
  return rows;
}

module.exports = {
  OPEN_STATUSES, MAX_HORIZON_DAYS, readHorizon, stillOwed, notPlanned, fetchBefore, deliveryRisk,
  STILL_OWED_EXPR,
};

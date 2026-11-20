'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT HAS LEFT ON AN ORDER
//
//  Metres that went out on the order's delivery challans — dispatched or
//  delivered (domain/challanStatus.js), never a draft or a cancelled one,
//  and not a machine-part challan. It is the only figure that may be
//  called "sent" to a customer.
//
//  The customer portal worked it out this way (api/portal/data.js); the
//  WhatsApp assistant worked out its own — ordered less the order's
//  `pendingElastic`, which is the metres not yet PLANNED onto a job. So
//  an order planned in full, with nothing woven, answered "2,000 of
//  2,000 m sent". One definition, used by both.
//
//    leftWhere(match)           the query for any set of orders
//    leftChallans(order)        the query: add .select/.populate/.sort
//    sentByElastic(challans)    Map(elasticId → metres)
//    sentOn(order)              → { total, byElastic, last }
// ══════════════════════════════════════════════════════════════════

const DeliveryChallan = require('../models/DeliveryChallan');
const { LEFT } = require('../domain/challanStatus');
const { round3 } = require('../utils/quantity');

/** Challans matching any of `match` that have left (elastic ones: a machine part is not an order's metres). */
function leftWhere(match) {
  return DeliveryChallan.find({ $or: match, status: { $in: LEFT }, type: { $ne: 'machine_part' } });
}

/** The challans of an order that have left. Older ones carry only its number. */
function leftChallans(order) {
  const match = [{ order: order._id }];
  if (order.orderNo != null) match.push({ orderNo: order.orderNo });
  return leftWhere(match);
}

function sentByElastic(challans) {
  const sent = new Map();
  for (const dc of challans || []) {
    for (const i of dc.items || []) {
      if (!i.elastic) continue;
      const k = String(i.elastic._id || i.elastic);
      sent.set(k, round3((sent.get(k) || 0) + (Number(i.quantity) || 0)));
    }
  }
  return sent;
}

/** What has left on this order: in all, by elastic, and the last challan to go. */
async function sentOn(order) {
  const challans = await leftChallans(order).select('dcNumber dispatchDate createdAt items.elastic items.quantity').sort({ dispatchDate: -1, createdAt: -1 }).lean();
  const byElastic = sentByElastic(challans);
  const total = round3([...byElastic.values()].reduce((s, v) => s + v, 0));
  const last = challans[0] ? { dcNumber: challans[0].dcNumber, dispatchDate: challans[0].dispatchDate || challans[0].createdAt } : null;
  return { total, byElastic, last };
}

module.exports = { leftWhere, leftChallans, sentByElastic, sentOn };

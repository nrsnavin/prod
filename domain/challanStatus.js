'use strict';
// ══════════════════════════════════════════════════════════════════
//  HAS A DELIVERY CHALLAN LEFT THE BUILDING?
//
//  A challan is made out as a `draft`, marked `dispatched` when the
//  goods go, and `delivered` when the customer takes them; `cancelled`
//  puts the goods back on the shelf (api/deliveryChallan.js,
//  DC_TRANSITIONS).
//
//  A draft has not left. It is paperwork: the goods are set aside and
//  the note is written, and they may sit there a day. Seven places held
//  to that, each with its own copy of the two statuses — and five did
//  not, counting every challan that was not cancelled as despatched:
//  the order page's "delivered", the order's challan panel, the order
//  book's on-time delivery, the order's costing, and the evening report
//  (which did not look at the status at all, so a challan cancelled
//  today was one of today's deliveries).
//
//  One definition, so the next figure to be built cannot pick its own.
// ══════════════════════════════════════════════════════════════════

/** Goods on these have left: on the road, or with the customer. */
const LEFT = Object.freeze(['dispatched', 'delivered']);

/** Made out, goods set aside, not yet sent. */
const DRAFT = 'draft';

const CANCELLED = 'cancelled';

const hasLeft = (status) => LEFT.includes(status);

// ── GOODS, NOT A MACHINE PART ────────────────────────────────────
// A challan is for elastic going to a customer, or for a machine part
// going out — to a repairer, say (`type`, api/deliveryChallan.js). Only
// the first is a despatch of goods: invoices are raised against it alone
// and the customer's portal shows it alone. The figures that say what was
// DISPATCHED did not look, so a gearbox sent for repair with a declared
// value was in the morning digest's rupees, the evening report's metres,
// and every row of the dispatch report.
const MACHINE_PART = 'machine_part';

/**
 * The Mongo match for goods that have left: dispatched or delivered, and
 * not a machine part. A challan from before challans had a type is goods.
 * A fresh object each call, to be spread into a larger match.
 */
const goodsLeft = () => ({ status: { $in: [...LEFT] }, type: { $ne: MACHINE_PART } });

module.exports = { LEFT, DRAFT, CANCELLED, MACHINE_PART, hasLeft, goodsLeft };

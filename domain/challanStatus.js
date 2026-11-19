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

module.exports = { LEFT, DRAFT, CANCELLED, hasLeft };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHERE A QUOTATION STANDS
//
//    draft → sent → accepted | declined          (what somebody records)
//                 → cancelled                    (withdrawn by us)
//
//  ── "Expired" is a fact about the date, not a status anybody sets ──
//  The status exists, and nothing sets it: no screen offers it (the
//  phone says outright that it "is a fact about the date, not a
//  decision") and no job writes it overnight. So a quote sent in March
//  and never answered sits on "sent" for ever. Anything that asks "which
//  quotes have run out?" — the list's Expired filter, the pricing
//  history — has to read it off the valid-until day, here, in one place.
//
//  A quote is good THROUGH its valid-until day. That day is kept as a
//  calendar date (its UTC midnight), so "has run out" is "that day is
//  before today in India" — never a comparison with the clock, which
//  would call a quote lapsed from 05:30 on its last morning.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');

const QUOTE_STATUSES = Object.freeze(['draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled']);

/** Still a price on offer: nobody has said yes or no, and we have not withdrawn it. */
const OPEN_STATUSES = Object.freeze(['draft', 'sent']);

/**
 * Quotes whose price has run out: an open one past its valid-until day,
 * or one somebody did mark expired. A Mongo filter.
 */
function lapsedFilter(today = factoryDay.calendarDay()) {
  return {
    $or: [
      { status: 'expired' },
      { status: { $in: OPEN_STATUSES }, validTill: { $lt: today } },
    ],
  };
}

/**
 * Quotes that went to a customer, ran out, and have no answer recorded.
 * A draft never went anywhere, so it is not one of these. A Mongo filter.
 */
function unansweredFilter(today = factoryDay.calendarDay()) {
  return { status: 'sent', validTill: { $lt: today } };
}

module.exports = { QUOTE_STATUSES, OPEN_STATUSES, lapsedFilter, unansweredFilter };

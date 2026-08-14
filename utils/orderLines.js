'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT AN ORDER IS ALLOWED TO BE
//
//  /create-order read the request body straight into Order.create and
//  checked nothing. The failures landed in two shapes, both wrong:
//
//    500  for a missing or malformed body — "our fault" reported for
//         what is plainly a bad request, so the client cannot tell a
//         server outage from a typo
//    201  for documents that make no sense — an order with no lines,
//         a line for zero metres, the same elastic on two lines, a
//         customer id that resolves to nothing
//
//  The last two do real damage. `reservations`, `pendingElastic`,
//  `producedElastic` and `packedElastic` are all keyed BY ELASTIC, so
//  one elastic on two lines is two entries under one key and every
//  reader silently picks whichever it finds first. And an order whose
//  customer does not exist renders a blank name on every screen that
//  shows it, with nothing to say whether the name is missing or the
//  customer is.
//
//  /update-order had the same gap: it assigned the incoming array
//  wholesale too. One validator, both routes — a rule enforced on the
//  create path and not the edit path is not a rule.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/**
 * Validate and normalise the lines of an order.
 *
 * Returns `{ error }` for anything that cannot be an order, so the
 * caller answers with one clear refusal naming the line rather than
 * storing a document nobody can read later.
 *
 * @param {unknown} elasticOrdered
 * @param {{ requireNonEmpty?: boolean }} opts
 * @returns {{ error: string } | { lines: Array<{elastic: string, quantity: number, rate?: number}> }}
 */
function readOrderLines(elasticOrdered, { requireNonEmpty = true } = {}) {
  if (!Array.isArray(elasticOrdered)) {
    return { error: 'elasticOrdered must be an array of { elastic, quantity }' };
  }
  if (requireNonEmpty && elasticOrdered.length === 0) {
    return { error: 'An order needs at least one elastic' };
  }

  const seen = new Map();   // elastic id → the line number that claimed it
  const lines = [];

  for (const [i, raw] of elasticOrdered.entries()) {
    const where = `Line ${i + 1}`;

    const elastic = raw?.elastic;
    if (!elastic || !mongoose.Types.ObjectId.isValid(elastic)) {
      return { error: `${where}: a valid elastic is required` };
    }
    const key = String(elastic);

    // Keyed collections downstream cannot represent the same product
    // twice. Merging them silently would be a guess at intent — two
    // lines may be a mistake or may be two delivery batches — so it is
    // refused with the position of both.
    if (seen.has(key)) {
      return {
        error: `${where}: this elastic is already on line ${seen.get(key)}. ` +
               `Put the whole quantity on one line.`,
      };
    }
    seen.set(key, i + 1);

    const quantity = Number(raw?.quantity);
    if (!Number.isFinite(quantity)) {
      return { error: `${where}: quantity must be a number` };
    }
    if (quantity <= 0) {
      // A line for nothing is not an order for nothing — it is a line
      // somebody meant to delete. Removing it is how that is said.
      return { error: `${where}: quantity must be more than zero` };
    }

    const line = { elastic: key, quantity };

    // The rate is optional here. /order routes do not own it — see
    // PUT /pnl/order/:orderId/rates — but they must not corrupt it
    // either, so a value that IS supplied is validated.
    if (raw?.rate !== undefined && raw?.rate !== null && raw?.rate !== '') {
      const rate = Number(raw.rate);
      if (!Number.isFinite(rate) || rate < 0) {
        return { error: `${where}: rate must be zero or more` };
      }
      line.rate = rate;
    }

    lines.push(line);
  }

  return { lines };
}

/**
 * Every elastic named here must exist.
 *
 * An order line pointing at a deleted product costs and plans at
 * nothing — see the note in utils/masterUsage.js, which is why elastics
 * are archived rather than deleted. An id that never existed is a
 * different thing and is simply wrong.
 */
async function assertElasticsExist(lines, Elastic) {
  const ids = [...new Set(lines.map((l) => String(l.elastic)))];
  const found = await Elastic.find({ _id: { $in: ids } }).select('_id').lean();
  if (found.length === ids.length) return null;

  const have = new Set(found.map((e) => String(e._id)));
  const missing = ids.filter((id) => !have.has(id));
  return `${missing.length} elastic(s) on this order do not exist`;
}

/**
 * The customer must exist.
 *
 * Not merely be a well-formed id: a dangling reference renders a blank
 * name everywhere the order appears, and a blank reads identically to
 * a customer whose name was never entered.
 */
async function assertCustomerExists(customer, Customer) {
  if (!customer || !mongoose.Types.ObjectId.isValid(customer)) {
    return 'A valid customer is required';
  }
  const exists = await Customer.exists({ _id: customer });
  return exists ? null : 'That customer does not exist';
}

module.exports = { readOrderLines, assertElasticsExist, assertCustomerExists };

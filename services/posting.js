'use strict';
// ══════════════════════════════════════════════════════════════════
//  POSTED ONCE
//
//  A request that posts something to the books may arrive twice: a
//  double tap, a retry on a slow line, a phone that never got the
//  answer. With a request id the second is answered by what the first
//  made. Each posting action did this by hand — look for the request
//  id, create, catch the duplicate-key error, look again — and the
//  actions that never got that code (a TDS challan, a PF deposit, a
//  certificate, a credit applied) posted twice.
//
//    replayOf(Model, requestId, { select, filter })
//          what an earlier request with this id made, or null
//    replayAfter(err, Model, requestId, { select, filter })
//          the same, asked after a write was refused as a duplicate:
//          two requests raced, the unique index on requestId let one in,
//          and this one is handed what the winner made
//    once(Model, requestId, work, { select, filter })
//          both, around a piece of work that creates the document:
//          → { doc, replay }
//    refuseDuplicate(err, message)
//          a write refused by a unique index on the document's own
//          natural key (not the request id): a plain 409 saying what is
//          already there
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');

const idOf = (requestId) => (requestId === undefined || requestId === null || requestId === '' ? null : String(requestId));

async function replayOf(Model, requestId, { select, filter } = {}) {
  const id = idOf(requestId);
  if (!id) return null;
  const q = Model.findOne({ ...(filter || {}), requestId: id });
  if (select) q.select(select);
  return q.lean();
}

async function replayAfter(err, Model, requestId, opts = {}) {
  if (err?.code !== 11000) return null;
  return replayOf(Model, requestId, opts);
}

/**
 * Run `work` (which creates and returns the document) unless a request
 * with this id already did. `work` is given the id to store on the
 * document (undefined when the request carried none).
 */
async function once(Model, requestId, work, opts = {}) {
  const id = idOf(requestId);
  const before = await replayOf(Model, id, opts);
  if (before) return { doc: before, replay: true };
  try {
    return { doc: await work(id || undefined), replay: false };
  } catch (err) {
    const dup = await replayAfter(err, Model, id, opts);
    if (dup) return { doc: dup, replay: true };
    throw err;
  }
}

/** A duplicate-key error on a natural key → 409 with `message`; anything else is thrown on. */
function refuseDuplicate(err, message) {
  if (err?.code === 11000) return new ErrorHandler(message, 409);
  return err;
}

module.exports = { replayOf, replayAfter, once, refuseDuplicate, idOf };

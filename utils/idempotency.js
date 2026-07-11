'use strict';
// Helpers for requestId-based write deduplication.
//
// Two patterns in use:
//   • Single-document creates (Packing, Wastage, DeliveryChallan) carry
//     `requestId` on the document itself under a unique sparse index.
//   • Batch writes (inward-stock) claim the key via claimKey() inside
//     their transaction — the replay's claim fails with E11000 and the
//     whole transaction aborts before any stock moves.

const IdempotencyKey = require("../models/IdempotencyKey.js");

/**
 * Claim `requestId` inside the caller's transaction. Throws E11000 when
 * the key was already claimed (i.e. this is a replay) — let it abort the
 * transaction and handle it with isDuplicateKeyError in the catch.
 */
async function claimKey(session, requestId, purpose) {
  await IdempotencyKey.create(
    [{ _id: String(requestId), purpose: purpose || "" }],
    { session }
  );
}

/** True when the key (or any unique index) rejected a duplicate. */
function isDuplicateKeyError(err) {
  return err?.code === 11000;
}

/** Read-side fast path: has this key already been claimed? */
async function isClaimed(requestId) {
  if (!requestId) return false;
  const doc = await IdempotencyKey.findById(String(requestId)).lean();
  return !!doc;
}

module.exports = { claimKey, isDuplicateKeyError, isClaimed };

// utils/fingerprint.js
// ────────────────────────────────────────────────────────────────
//  ACTION FINGERPRINTING
//
//  A fingerprint is a tamper-evident audit record attached to an
//  Order / JobOrder document. Every meaningful state transition
//  (creation, approval, stock deduction, job creation, stage
//  update, completion) records one entry containing:
//
//    • code     – machine-readable action identifier
//    • label    – short human label shown in the UI
//    • hash     – SHA-256 of  action|entityId|timestamp|nonce
//                 → uniquely identifies this exact action and is
//                   safe to display / export
//    • shortId  – first 10 chars of the hash, ideal for chips
//    • at       – ISO timestamp
//    • meta     – arbitrary JSON metadata (prev / next status,
//                 quantities, etc.)
//
//  The hash is *not* a signature — it's a deterministic identifier
//  derived from the event itself. Two distinct events can never
//  share the same hash because of the per-call nonce.
// ────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');

const ACTION_CODES = Object.freeze({
  ORDER_CREATED:            'ORDER_CREATED',
  ORDER_UPDATED:            'ORDER_UPDATED',
  ORDER_DELETED:            'ORDER_DELETED',
  ORDER_APPROVED:           'ORDER_APPROVED',
  RAW_MATERIAL_DEDUCTED:    'RAW_MATERIAL_DEDUCTED',
  ORDER_PRODUCTION_STARTED: 'ORDER_PRODUCTION_STARTED',
  ORDER_COMPLETED:          'ORDER_COMPLETED',
  ORDER_CANCELLED:          'ORDER_CANCELLED',
  JOB_CREATED:              'JOB_CREATED',
  JOB_STAGE_UPDATED:        'JOB_STAGE_UPDATED',
  JOB_COMPLETED:            'JOB_COMPLETED',
  JOB_CANCELLED:            'JOB_CANCELLED',
  // Sub-stage / per-action events recorded on the parent JobOrder
  WARPING_STARTED:          'WARPING_STARTED',
  WARPING_COMPLETED:        'WARPING_COMPLETED',
  COVERING_STARTED:         'COVERING_STARTED',
  COVERING_COMPLETED:       'COVERING_COMPLETED',
  COVERING_BEAM_ENTRY:      'COVERING_BEAM_ENTRY',
  SHIFT_PRODUCTION_ENTERED: 'SHIFT_PRODUCTION_ENTERED',
  PACKING_CREATED:          'PACKING_CREATED',
  WASTAGE_RECORDED:         'WASTAGE_RECORDED',
  // Delivery-Challan lifecycle
  DC_CREATED:               'DC_CREATED',
  DC_STATUS_UPDATED:        'DC_STATUS_UPDATED',
  DC_DISPATCHED:            'DC_DISPATCHED',
  DC_DELIVERED:             'DC_DELIVERED',
  DC_CANCELLED:             'DC_CANCELLED',
  DC_DELETED:               'DC_DELETED',
});

const ACTION_LABELS = Object.freeze({
  ORDER_CREATED:            'Order Created',
  ORDER_UPDATED:            'Order Updated',
  ORDER_DELETED:            'Order Deleted',
  ORDER_APPROVED:           'Order Approved',
  RAW_MATERIAL_DEDUCTED:    'Raw Material Deducted',
  ORDER_PRODUCTION_STARTED: 'Production Started',
  ORDER_COMPLETED:          'Order Completed',
  ORDER_CANCELLED:          'Order Cancelled',
  JOB_CREATED:              'Job Created',
  JOB_STAGE_UPDATED:        'Job Stage Updated',
  JOB_COMPLETED:            'Job Completed',
  JOB_CANCELLED:            'Job Cancelled',
  WARPING_STARTED:          'Warping Started',
  WARPING_COMPLETED:        'Warping Completed',
  COVERING_STARTED:         'Covering Started',
  COVERING_COMPLETED:       'Covering Completed',
  COVERING_BEAM_ENTRY:      'Covering Beam Entry',
  SHIFT_PRODUCTION_ENTERED: 'Shift Production Entered',
  PACKING_CREATED:          'Packing Recorded',
  WASTAGE_RECORDED:         'Wastage Recorded',
  DC_CREATED:               'Delivery Challan Created',
  DC_STATUS_UPDATED:        'DC Status Updated',
  DC_DISPATCHED:            'DC Dispatched',
  DC_DELIVERED:             'DC Delivered',
  DC_CANCELLED:             'DC Cancelled',
  DC_DELETED:               'DC Deleted',
});

/**
 * Normalise an actor reference into a stable object with
 * { id, name, role }. Accepts:
 *   • a Mongoose user document (req.user)
 *   • a plain object {id|_id, name, role, email}
 *   • a string (treated as a name/id when nothing else is known)
 *   • null/undefined → defaults to "system"
 */
function normaliseActor(rawActor) {
  if (!rawActor) {
    return { id: 'system', name: 'System', role: 'system' };
  }
  if (typeof rawActor === 'string') {
    return { id: rawActor, name: rawActor, role: 'unknown' };
  }
  // Mongoose document or plain object
  const id   = rawActor._id?.toString?.() || rawActor.id || 'unknown';
  const name = rawActor.name  || rawActor.username || 'Unknown User';
  const role = rawActor.role  || 'unknown';
  const email= rawActor.email || undefined;
  return email ? { id, name, role, email } : { id, name, role };
}

/**
 * Pull an actor from an Express request. Tries JWT-decoded
 * req.user first, then a body-level actor blob (so unauthenticated
 * mobile clients can still attach the logged-in user from local state).
 */
function actorFromRequest(req) {
  if (req?.user) return normaliseActor(req.user);
  if (req?.body?.actor) return normaliseActor(req.body.actor);
  if (req?.body?.actorId || req?.body?.actorName) {
    return normaliseActor({
      id:   req.body.actorId,
      name: req.body.actorName,
      role: req.body.actorRole,
    });
  }
  return normaliseActor(null);
}

/**
 * Build a fingerprint object suitable for pushing into
 * Order.fingerprints / JobOrder.fingerprints.
 *
 * @param {string} code         one of ACTION_CODES values
 * @param {object} opts
 * @param {string|object} opts.entityId  the order/job id
 * @param {object} [opts.meta]            extra metadata to record
 * @param {object|string} [opts.actor]    user object {id,name,role}
 * @returns {object}
 */
function buildFingerprint(code, { entityId, meta = {}, actor } = {}) {
  if (!ACTION_CODES[code]) {
    throw new Error(`Unknown fingerprint action code: ${code}`);
  }
  const actorObj = normaliseActor(actor);
  const at    = new Date();
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = [
    code,
    String(entityId ?? ''),
    at.toISOString(),
    nonce,
    actorObj.id,
  ].join('|');

  const hash    = crypto.createHash('sha256').update(payload).digest('hex');
  const shortId = hash.slice(0, 10).toUpperCase();

  return {
    code,
    label: ACTION_LABELS[code],
    hash,
    shortId,
    at,
    actor: actorObj,
    meta,
  };
}

module.exports = {
  ACTION_CODES,
  ACTION_LABELS,
  buildFingerprint,
  actorFromRequest,
  normaliseActor,
};

'use strict';

// Writes one AccessEvent (models/AccessEvent.js) for a change to a login.
//
// Called AFTER the change has been saved. If the record itself can't be
// written, the change still stands — refusing it now would not undo it —
// so the failure is logged and reported loudly instead of thrown.

const AccessEvent = require('../models/AccessEvent');
const { buildFingerprint, actorFromRequest } = require('./fingerprint');
const { isPlaceholderEmail } = require('./workerLogin');
const { reportError } = require('./errorReporter');

/**
 * @param {object} req      the request making the change (its user is the actor)
 * @param {string} code     an ACTION_CODES access code (LOGIN_*, PHONE_SIGNIN_*)
 * @param {object} subject  the login changed: a User document or {_id, name, email}
 * @param {object} [meta]   what changed — never a password or PIN
 */
async function recordAccess(req, code, subject, meta = {}) {
  // No live connection: say so at once rather than holding the reply
  // while the driver buffers the write for ten seconds.
  if (AccessEvent.db?.readyState !== 1) {
    console.error(`[access-log] could not record ${code}: database not connected`);
    return;
  }
  try {
    const id = String(subject?._id ?? subject?.id ?? '');
    const fp = buildFingerprint(code, { entityId: id, meta, actor: actorFromRequest(req) });
    await AccessEvent.create({
      ...fp,
      subject: {
        id,
        name: subject?.name,
        // A worker login's placeholder is not an address; leave it out.
        email: isPlaceholderEmail(subject?.email) ? undefined : subject?.email,
      },
    });
  } catch (err) {
    console.error(`[access-log] could not record ${code}:`, err.message);
    try { reportError(err, req); } catch { /* reporting is best-effort */ }
  }
}

module.exports = { recordAccess };

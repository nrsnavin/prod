'use strict';
// ══════════════════════════════════════════════════════════════════
//  TELLING THE DETECTOR IT IS WRONG
//
//  Every signal in services/serviceAnomaly.js has an innocent
//  explanation that is usually the true one. A loom serviced three
//  times in a fortnight may be a loom that is failing. A technician
//  whose bills run high may be the one trusted with the hard machines.
//  A part that keeps appearing across the floor may simply be the part
//  that keeps wearing out.
//
//  An alarm that cannot be switched off gets ignored wholesale, and an
//  ignored alarm is worse than none — it costs attention every week and
//  buys nothing. So a finding can be dismissed, and the same pattern
//  about the same subject stops being raised.
//
//  ── Dismissal is scoped, not global ───────────────────────────────
//  The key is (kind, subject). Dismissing "this technician's costs run
//  high" silences that reading of THAT technician; it does not silence
//  the same reading of anybody else, and it does not silence a
//  different reading of the same person. A blanket "never show me
//  anomalies again" would be a switch nobody could reason about.
//
//  ── Why it expires ────────────────────────────────────────────────
//  A dismissal is a judgement about a situation, and situations end.
//  The loom that was failing gets rebuilt; the technician moves to
//  easier machines. A permanent dismissal would let the one pattern
//  somebody once explained away become a permanent blind spot, which is
//  precisely where a real problem would eventually sit. So it lapses,
//  and the finding comes back to be judged again against whatever the
//  numbers look like by then.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/** How long a dismissal holds before the finding is raised again. */
const DISMISSAL_DAYS = 90;

const ServiceAnomalyFeedbackSchema = new mongoose.Schema(
  {
    /** Which reading was dismissed, e.g. 'technician-cost'. */
    kind: { type: String, required: true, trim: true },

    /**
     * What it was about — a machine id, a technician's name, an issue
     * key. Stored as a string because the subject is a different sort
     * of thing per kind, and a union of ref types would buy nothing
     * that a lookup by kind does not already give.
     */
    subject: { type: String, required: true, trim: true },

    /** Why it was not a problem. Required: a dismissal with no reason
     *  is indistinguishable from somebody clearing their screen. */
    reason: { type: String, required: true, trim: true },

    dismissedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
    dismissedAt: { type: Date, default: Date.now },

    /** When this stops applying. See the note on expiry above. */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + DISMISSAL_DAYS * 24 * 60 * 60 * 1000),
      index: true,
    },
  },
  { timestamps: true }
);

// The detector's only query: "what is currently silenced?"
ServiceAnomalyFeedbackSchema.index({ kind: 1, subject: 1, expiresAt: -1 });

const ServiceAnomalyFeedback = mongoose.model(
  'ServiceAnomalyFeedback',
  ServiceAnomalyFeedbackSchema
);

module.exports = ServiceAnomalyFeedback;
module.exports.DISMISSAL_DAYS = DISMISSAL_DAYS;

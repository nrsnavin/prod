'use strict';
// One thing at a time, across every server process (utils/onceAtATime.js).
//
// `_id` names what is being done ("invoice:order:<id>"); `until` is when a
// holder that died without letting go stops counting. A lease nobody
// released is cleared away an hour after it lapses.
const mongoose = require('mongoose');

const LeaseSchema = new mongoose.Schema(
  {
    _id:    { type: String, required: true },
    until:  { type: Date, required: true },
    holder: { type: String, default: '' },
  },
  { versionKey: false }
);

LeaseSchema.index({ until: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('Lease', LeaseSchema);

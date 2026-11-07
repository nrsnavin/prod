'use strict';
// A report someone built in the query builder (or typed as SQL) and
// kept, to run again. Shared ones show for everyone allowed to read the
// dataset; the rest only for the person who saved them.
const mongoose = require('mongoose');

const SavedReportSchema = new mongoose.Schema(
  {
    name:   { type: String, required: true, trim: true, maxlength: 80 },
    query:  { type: mongoose.Schema.Types.Mixed },
    sql:    { type: String, default: '', maxlength: 4000 },
    preset: { type: String, default: 'month' },
    shared: { type: Boolean, default: false },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User', index: true },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SavedReport', SavedReportSchema);

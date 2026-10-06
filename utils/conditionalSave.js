'use strict';
// ══════════════════════════════════════════════════════════════════
//  SAVE ONLY IF IT IS STILL TRUE
//
//  The pattern behind most lost updates here: load a document, check its
//  status ("not posted", "still pending", "not running"), change it,
//  save. Between the check and the save, someone else can change the
//  status, and the save writes over them: a posted count goes back to
//  "counting", a cancelled order back to "in progress".
//
//  saveIf puts the check INTO the save. Mongoose adds `filter` to the
//  update's query (Document#$where), so the write lands only while the
//  stored document still matches; otherwise nothing is written and it
//  returns false, for the caller to answer "it changed, reload".
//
//    if (!(await saveIf(count, { status: { $nin: ['posted', 'cancelled'] } }))) {
//      return next(changedMeanwhile('Count', 'posted or cancelled'));
//    }
//
//  Works inside a transaction too (pass { session }).
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('./ErrorHandler');

/**
 * @param {import('mongoose').Document} doc   loaded, then modified
 * @param {object} filter                      what must still be true of the stored doc
 * @param {object} [options]                   passed to save(), e.g. { session }
 * @returns {Promise<boolean>} false when the stored document no longer matched
 */
async function saveIf(doc, filter, options) {
  const before = doc.$where;
  doc.$where = { ...(before || {}), ...filter };
  try {
    await doc.save(options);
    return true;
  } catch (err) {
    if (err?.name === 'DocumentNotFoundError') return false;
    throw err;
  } finally {
    doc.$where = before;
  }
}

/** The 409 for a save that saveIf refused. */
function changedMeanwhile(what, how) {
  const err = new ErrorHandler(
    `${what} was ${how} by someone else just now, so this change was not saved. Reload to see it as it is.`,
    409
  );
  err.code = 'CHANGED_MEANWHILE';
  return err;
}

module.exports = { saveIf, changedMeanwhile };

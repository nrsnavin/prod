'use strict';
// ══════════════════════════════════════════════════════════════════
//  DOES THIS ELASTIC FIT ON THIS MACHINE?
//
//  A weaving head has a fixed number of hooks. An elastic's recipe
//  says how many it needs (`noOfHook`). Put a 24-hook product on a
//  12-hook machine and it cannot be woven as specified — the operator
//  finds out at the machine, with the beam already up, and the job has
//  to come back off.
//
//  Nothing checked this. The head map validated head NUMBERS — no
//  gaps, no duplicates, the right count, every elastic belonging to
//  the job — and never once asked whether the machine could actually
//  run what was being put on it.
//
//  ── Why a confirmation and not a refusal ─────────────────────────
//  Because the floor sometimes knows better. A product may be run on
//  a smaller machine deliberately, at reduced width or with a changed
//  setup, and a system that refuses outright just gets worked around
//  by assigning a different elastic and swapping it back. So the
//  answer is: say plainly what does not fit, and let somebody who
//  knows say yes on the record.
// ══════════════════════════════════════════════════════════════════

const Elastic = require('../models/Elastic');

/**
 * Which of these elastics need more hooks than the machine has.
 *
 * @param {{NoOfHooks: number, ID?: string}} machine
 * @param {Array<ObjectId|string>} elasticIds  may repeat, may contain null
 * @returns {Promise<{
 *   machineHooks: number,
 *   overs: Array<{ elastic: string, name: string, noOfHook: number, excess: number }>,
 *   fits: boolean,
 *   summary: string,
 * }>}
 */
async function checkHookFit(machine, elasticIds) {
  const machineHooks = Number(machine?.NoOfHooks) || 0;

  // De-duplicated: one elastic across eight heads is one problem, and
  // listing it eight times would bury the others.
  const ids = [...new Set(
    (elasticIds || []).filter(Boolean).map((id) => String(id))
  )];

  if (ids.length === 0 || machineHooks <= 0) {
    // No hooks recorded on the machine is missing information, not a
    // machine with no hooks. Refusing — or confirming — on the strength
    // of a zero would be inventing a fact.
    return { machineHooks, overs: [], fits: true, summary: '' };
  }

  const elastics = await Elastic.find({ _id: { $in: ids } })
    .select('name noOfHook')
    .lean();

  const overs = elastics
    .filter((e) => Number(e.noOfHook) > machineHooks)
    .map((e) => ({
      elastic:   String(e._id),
      name:      e.name || '',
      noOfHook:  Number(e.noOfHook),
      excess:    Number(e.noOfHook) - machineHooks,
    }))
    // Worst fit first — it is the one that decides the answer.
    .sort((a, b) => b.excess - a.excess);

  return {
    machineHooks,
    overs,
    fits: overs.length === 0,
    summary: overs
      .map((o) => `${o.name || o.elastic} needs ${o.noOfHook}`)
      .join(', '),
  };
}

/**
 * The 409 a route returns when something does not fit and the caller
 * has not said to go ahead anyway.
 *
 * Shaped like the other override-able refusals in this API (`code` +
 * `details`) so a client can tell "you must not" from "are you sure?"
 * without reading the sentence.
 */
function hookFitError(machine, fit, ErrorHandler) {
  const err = new ErrorHandler(
    `Machine ${machine.ID || ''} has ${fit.machineHooks} hooks per head, but ` +
    `${fit.overs.length === 1 ? 'this elastic needs' : 'these elastics need'} more — ` +
    `${fit.summary}. Confirm to assign it anyway.`.replace(/\s+/g, ' ').trim(),
    409
  );
  err.code = 'HOOKS_EXCEED_MACHINE';
  err.details = {
    machineId:    String(machine._id),
    machineName:  machine.ID || '',
    machineHooks: fit.machineHooks,
    elastics:     fit.overs,
    // The field the caller sets to go ahead. Named rather than left to
    // be guessed from the docs.
    confirmField: 'confirmHooks',
  };
  return err;
}

module.exports = { checkHookFit, hookFitError };

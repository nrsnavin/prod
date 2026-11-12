'use strict';
// ══════════════════════════════════════════════════════════════════
//  A FAILURE THAT DOES NOT STOP THE WORK IS STILL WRITTEN DOWN
//
//  Some steps follow a posting and must not undo it when they fail:
//  scoring an AI suggestion against what the person kept, copying a
//  file onto the bill. They were written `.catch(() => {})`, which is
//  the same as never having happened: a bill entered from the mailbox
//  whose PDF did not attach had no copy, and nothing anywhere said so.
//
//    noted(what)        → a catch handler that logs `what` with the
//                         error and lets the work carry on:
//                         promise.catch(noted('scoring the bill scan'))
//    noted(what, list)  → the same, and adds a plain sentence to `list`
//                         for the person (sent back with the answer)
// ══════════════════════════════════════════════════════════════════

function noted(what, list, sentence) {
  return (err) => {
    console.warn(`[accounts] ${what} failed: ${err?.message || err}`);
    if (Array.isArray(list) && sentence) list.push(sentence);
    return null;
  };
}

module.exports = { noted };

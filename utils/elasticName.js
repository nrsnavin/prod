'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE ANSWER TO "IS THIS THE SAME ELASTIC?"
//
//  Two products called "NEWDAY ROMEO BLACK" are one product entered
//  twice, and so are "Newday Romeo Black" and "NEWDAY  ROMEO  BLACK".
//  A duplicate check that only catches an exact byte-for-byte match
//  catches almost none of the duplicates that actually happen — the
//  second entry is nearly always typed by a different person on a
//  different day, and the shift key is the first thing to differ.
//
//  So the comparison is on a normalised key, not on the name. The name
//  itself is stored exactly as the user typed it: they chose that
//  capitalisation and it goes on the programme sheet.
//
//  Kept in its own module because three places have to agree about it
//  and they run at different times — the model derives the key on
//  every save, the routes use it to look for a clash before saving,
//  and the migration backfills it for rows written before any of this
//  existed. If they ever disagreed, the index would reject writes the
//  API had already said were fine.
// ══════════════════════════════════════════════════════════════════

/**
 * The key two elastic names are compared on.
 *
 * Case-folded, ends trimmed, and internal runs of whitespace collapsed
 * to one space — the three ways the same name gets typed differently.
 * Punctuation is deliberately LEFT ALONE: "20mm" and "20 mm" fold
 * together on the space rule, but "ROMEO-BLACK" and "ROMEO BLACK" are
 * left as different products, because a hyphen in this catalogue is
 * sometimes load-bearing and guessing costs more than it saves.
 *
 * @param   {unknown} name
 * @returns {string}  '' when there is nothing to key on
 */
function elasticNameKey(name) {
  if (name === null || name === undefined) return '';
  return String(name)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

module.exports = { elasticNameKey };

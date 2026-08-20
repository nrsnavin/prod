'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FIXED VOCABULARY OF `RawMaterial.category`
//
//  Five values, owned by the system, and separate from material
//  GROUPS — which the mill owns and can add to freely. The two used
//  to be one field: `category` held the group's name, so creating a
//  group called "Trim Tape" put a value into a field the elastic
//  recipe picker, the MRP sheet and the phone's colour chips branch
//  on, and renaming a group silently restated every member.
//
//  This list is the system's half. A new value here is a code change,
//  because code would have to learn what to do with it. Anything the
//  mill wants to track beyond it is a group.
//
//  ── Why its own file ──────────────────────────────────────────────
//  It lived on models/RawMaterial for about an hour, which broke
//  every test that does `jest.mock("../../models/RawMaterial")`: the
//  automock replaced canonicalCategory with a stub returning
//  undefined, so every create rejected its own valid category. A
//  frozen array and a string comparison are not model behaviour and
//  should never have been reachable only through a mockable module.
// ══════════════════════════════════════════════════════════════════

/**
 * Display order: the three positions in the cloth, then the two
 * substances. The odd-looking casing is deliberate and load-bearing —
 * these are the exact strings live data already holds.
 */
const MATERIAL_CATEGORIES = Object.freeze([
  'warp',
  'weft',
  'covering',
  'Rubber',
  'Chemicals',
]);

/**
 * The three that say WHERE in the cloth a material sits, as opposed
 * to WHAT it is. The elastic recipe pickers want only these.
 */
const MATERIAL_POSITIONS = Object.freeze(['warp', 'weft', 'covering']);

/**
 * Match a submitted value to its canonical spelling, case- and
 * whitespace-insensitively. Returns null when it is not one of them.
 *
 * Folding is the whole point. The recipe picker runs
 * `find({ category: "Rubber" })` — an exact literal — so a material
 * saved from the phone as "rubber" silently disappeared from it.
 * Callers store what this RETURNS, never what the client sent.
 */
function canonicalCategory(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return MATERIAL_CATEGORIES.find((c) => c.toLowerCase() === v) ?? null;
}

/** True when [value] is one of the five, in any casing. */
function isMaterialCategory(value) {
  return canonicalCategory(value) !== null;
}

module.exports = {
  MATERIAL_CATEGORIES,
  MATERIAL_POSITIONS,
  canonicalCategory,
  isMaterialCategory,
};

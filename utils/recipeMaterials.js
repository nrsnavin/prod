'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH RAW MATERIALS GO IN WHICH SLOT OF AN ELASTIC
//
//  An elastic has four composition slots: warp yarn, warp spandex
//  (rubber), spandex covering and weft. Which materials belong in each
//  comes from the material groups: a group whose name CONTAINS the
//  slot's keyword, folded to lowercase — so "Warp", "warp yarn" and
//  "Warp Spandex" all reach the warp slot, and a rename that keeps the
//  word keeps working. A material matches by its group link or by its
//  category name (one that predates groups carries only the string).
//
//  Shared by the elastic form's pickers (/materials/materialForNewElastic)
//  and the bulk-upload Excel template's dropdowns, so both offer the same
//  materials for the same slot.
// ══════════════════════════════════════════════════════════════════

const MaterialGroup = require('../models/MaterialGroup');
const { escapeRegex } = require('./escapeRegex');

// The buckets stay hardcoded on purpose: the slots are a property of the
// cloth, not of the group list.
const RECIPE_BUCKETS = Object.freeze({
  warp:     ['warp'],
  weft:     ['weft'],
  covering: ['covering'],
  // Named "rubber" for the elastic form's warp-spandex slot; "spandex"
  // accepted too, because that is what the floor calls it.
  rubber:   ['rubber', 'spandex'],
});

function bucketFor(name) {
  const n = String(name || '').toLowerCase();
  for (const [bucket, keywords] of Object.entries(RECIPE_BUCKETS)) {
    if (keywords.some((k) => n.includes(k))) return bucket;
  }
  return null;
}

/**
 * A RawMaterial filter (without the archived clause) for each bucket:
 * { warp, weft, covering, rubber }.
 */
async function recipeMaterialFilters() {
  const groups = await MaterialGroup.find({ archived: { $ne: true } }).select('_id name').lean();

  const ids = { warp: [], weft: [], covering: [], rubber: [] };
  const names = { warp: [], weft: [], covering: [], rubber: [] };
  for (const g of groups) {
    const bucket = bucketFor(g.name);
    if (!bucket) continue;
    ids[bucket].push(g._id);
    names[bucket].push(g.name);
  }

  const exactly = (list) => list.map((n) => new RegExp(`^${escapeRegex(n)}$`, 'i'));
  const filters = {};
  for (const bucket of Object.keys(RECIPE_BUCKETS)) {
    const or = [];
    if (ids[bucket].length)   or.push({ group: { $in: ids[bucket] } });
    if (names[bucket].length) or.push({ category: { $in: exactly(names[bucket]) } });
    // No group carries this keyword — fall back to the literal category,
    // so a database with no groups seeded yet behaves as it always did.
    if (or.length === 0) or.push({ category: { $in: exactly(RECIPE_BUCKETS[bucket]) } });
    filters[bucket] = { $or: or };
  }
  return filters;
}

module.exports = { RECIPE_BUCKETS, bucketFor, recipeMaterialFilters };

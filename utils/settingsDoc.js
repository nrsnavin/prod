'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ONE SETTINGS RECORD, WITH EVERY PART THE SCHEMA KNOWS
//
//  Settings live in one record per kind (key: 'production', 'accounts'),
//  made the first time anything asks for it. Read with lean(), that
//  record comes back exactly as it was stored. A record saved by an
//  older server has none of the parts added since: no
//  `shiftEndNudge.phones`, no `shiftHandover`, no `poChase`. Whatever
//  reads `phones.length` then fails, as the production settings page
//  did on a database brought over from a long-running server. A fresh
//  install never shows it, because the first upsert writes every
//  default.
//
//  So the stored record goes through its model once on the way out:
//  every path the schema has a default for and the record lacks gets
//  that default, in the answer only. Nothing is written by reading;
//  the next save stores whatever it sets, as before.
// ══════════════════════════════════════════════════════════════════

/**
 * A stored record (lean) with the schema's defaults filled in where it
 * has no value. With a projection, only the projected paths are filled.
 */
function withDefaults(Model, raw, projection) {
  if (!raw) return raw;
  // Shaped as lean() shapes it: an empty object stays (toObject would
  // drop it), and a Map comes back as a plain object.
  return Model.hydrate(raw, projection).toObject({ minimize: false, flattenMaps: true });
}

/**
 * The settings record of this kind, made if it is missing, as a plain
 * object with every default filled in.
 */
async function settingsDoc(Model, key, { projection } = {}) {
  const raw = await Model.findOneAndUpdate(
    { key },
    { $setOnInsert: { key } },
    { upsert: true, new: true, ...(projection ? { projection } : {}) },
  ).lean();
  return withDefaults(Model, raw, projection);
}

module.exports = { settingsDoc, withDefaults };

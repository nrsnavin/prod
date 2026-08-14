'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIAL GROUPS
//
//  `RawMaterial.category` was a required free-text string with no
//  validation, and the list of legal values was hardcoded in eight
//  places that did not agree with each other:
//
//    prod_web  types.ts          warp, weft, Rubber, covering
//    flu       6 files           …the same, PLUS Chemicals
//    prod      rawMaterial.js    four separate find({category:"…"})
//                                queries, matched by exact string
//
//  So a material entered on the phone as "Chemicals" could not be
//  created from the web at all and matched no filter chip there; and
//  changing the case of "Rubber" anywhere silently emptied the elastic
//  recipe picker, because that endpoint matches the literal.
//
//  This is that list, once, as data. Everything that offers a choice
//  of group reads it from here.
//
//  ── Why a collection and not an enum ─────────────────────────────
//  An enum in the schema is a fifth hardcoded copy, and it puts adding
//  a group behind a deployment. Groups are a thing the mill adds to —
//  a new chemical, a new class of trim — so they belong in the data,
//  editable by an admin, the way suppliers and customers are.
//
//  ── Two axes, not one ────────────────────────────────────────────
//  `warp` / `weft` / `covering` say where a material sits in the
//  cloth. `Rubber` / `Chemicals` say what it IS. Those are different
//  questions sharing one field, which is why the list reads oddly.
//  `kind` records which question a group answers, so a report can
//  subtotal by position without a chemical landing in the middle of
//  it, and so the recipe pickers can ask for positions only.
//
//  ── Archive, never delete ────────────────────────────────────────
//  Same rule as RawMaterial, Elastic and Customer, and deliberately
//  the same shape: filter with `{ archived: { $ne: true } }`, never
//  `{ archived: false }`. Rows written before the field existed have
//  no value at all and must read as active.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

//  What question a group answers. Kept short and closed — this one IS
//  a fixed list, because adding a third axis is a schema decision
//  rather than something the mill does on a Tuesday.
const GROUP_KINDS = Object.freeze(['position', 'material', 'other']);

const MaterialGroupSchema = new mongoose.Schema(
  {
    // What it is called on the floor. This is also the value that goes
    // into RawMaterial.category, so the two never disagree — see
    // `syncCategoryOnRename` in api/materialGroup.js.
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // A stable handle that does NOT move when the name is edited.
    // Reports, saved filters and the seeded groups reference this, so
    // renaming "Rubber" to "Spandex" on the floor does not orphan
    // anything pointing at it.
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      index: true,
    },

    kind: {
      type: String,
      enum: GROUP_KINDS,
      default: 'other',
      index: true,
    },

    // Display order in every picker. Ties break on name, so a set of
    // groups that all left this at 0 still lists predictably rather
    // than in insertion order.
    sortOrder: { type: Number, default: 0 },

    // Hex, for the chips the mobile app already colours by category —
    // today with a hardcoded `switch` per screen, in three files.
    colour: { type: String, default: '', trim: true },

    // ── Defaults a member material inherits when it has none ───────
    // Inherited at CREATE time and copied onto the material, not read
    // through at display time. A material's own figure must keep
    // working when the group's changes, or editing a group silently
    // restates the minimum stock of everything in it.
    defaultUnit:     { type: String, default: '', trim: true },
    defaultMinStock: { type: Number, default: 0, min: 0 },

    notes: { type: String, default: '', trim: true },

    archived:   { type: Boolean, default: false, index: true },
    archivedAt: { type: Date },

    fingerprints: { type: Array, default: [] },
  },
  { timestamps: true }
);

// Case-insensitive uniqueness on the name. Two groups called "warp"
// and "Warp" are the bug this collection exists to end, and a plain
// unique index would happily accept both.
MaterialGroupSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);
MaterialGroupSchema.index({ kind: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('MaterialGroup', MaterialGroupSchema);
module.exports.GROUP_KINDS = GROUP_KINDS;

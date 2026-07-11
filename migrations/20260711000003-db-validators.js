'use strict';
//
// Database-level invariants (Phase 2). The DB is the last line of
// defense — these hold even if application code regresses.
//
// $jsonSchema validators with validationLevel "moderate": enforced on
// inserts and on updates to already-valid documents; pre-existing
// invalid documents are left readable (no big-bang data cleanup, no
// blocked boot).
//
// Unique name indexes on masters (elastics, suppliers, rawmaterials —
// NOT customers: two real customers can share a trade name, phone/GSTIN
// distinguish them) are created ONLY when the data is already clean —
// duplicates are logged loudly and skipped, never aborted: this
// migration runs in `npm start`'s prestart, and master-data dupes are
// not worth blocking a production boot over (unlike duplicate PO
// numbers, which are financial documents).

function nonNegative(field) {
  return { [field]: { bsonType: ["double", "int", "long", "decimal"], minimum: 0 } };
}

const VALIDATORS = {
  rawmaterials: {
    $jsonSchema: {
      bsonType: "object",
      properties: { ...nonNegative("stock"), ...nonNegative("minStock"), ...nonNegative("price") },
    },
  },
  elastics: {
    $jsonSchema: {
      bsonType: "object",
      properties: { ...nonNegative("stock"), ...nonNegative("quantityProduced"), ...nonNegative("reservedStock") },
    },
  },
  packings: {
    $jsonSchema: {
      bsonType: "object",
      properties: {
        meter: { bsonType: ["double", "int", "long", "decimal"], minimum: 0.000001, maximum: 50000 },
        ...nonNegative("joints"),
      },
    },
  },
  wastages: {
    $jsonSchema: {
      bsonType: "object",
      properties: {
        quantity: { bsonType: ["double", "int", "long", "decimal"], minimum: 0.000001 },
        ...nonNegative("penalty"),
      },
    },
  },
  counters: {
    $jsonSchema: { bsonType: "object", properties: { ...nonNegative("seq") } },
  },
};

const UNIQUE_NAME_COLLECTIONS = ["elastics", "suppliers", "rawmaterials"];

module.exports = {
  async up(db) {
    // ── Validators ────────────────────────────────────────────────
    for (const [coll, validator] of Object.entries(VALIDATORS)) {
      // collMod requires the collection to exist; create() is a no-op
      // guard for fresh databases.
      const exists = await db.listCollections({ name: coll }).hasNext();
      if (!exists) await db.createCollection(coll);
      await db.command({
        collMod: coll,
        validator,
        validationLevel: "moderate",
        validationAction: "error",
      });
    }

    // ── Unique master names (skip-if-dirty, never abort) ──────────
    for (const coll of UNIQUE_NAME_COLLECTIONS) {
      const dupes = await db.collection(coll).aggregate([
        { $match: { name: { $type: "string" } } },
        { $group: { _id: "$name", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 5 },
      ]).toArray();

      if (dupes.length > 0) {
        console.warn(
          `[migration] SKIPPING unique name index on ${coll} — duplicates exist: ` +
          dupes.map((d) => `"${d._id}"×${d.n}`).join(", ") +
          `. De-duplicate, then re-run this index manually or in a follow-up migration.`
        );
        continue;
      }
      await db.collection(coll).createIndex(
        { name: 1 },
        { unique: true, sparse: true, name: "name_unique" }
      );
    }
  },

  async down(db) {
    for (const coll of Object.keys(VALIDATORS)) {
      try {
        await db.command({ collMod: coll, validator: {}, validationLevel: "off" });
      } catch (_) { /* collection may not exist */ }
    }
    for (const coll of UNIQUE_NAME_COLLECTIONS) {
      try { await db.collection(coll).dropIndex("name_unique"); } catch (_) {}
    }
  },
};

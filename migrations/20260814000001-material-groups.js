'use strict';
// ══════════════════════════════════════════════════════════════════
//  SEED MATERIAL GROUPS FROM THE CATEGORIES ACTUALLY IN USE
//
//  Not from any hardcoded list. There were eight of those and they did
//  not agree — the web knew four values, the mobile app five, and the
//  server matched four literals by exact string. Seeding from a list
//  would pick one of those to be right and silently strand whatever
//  the others hold. So this reads the DISTINCT categories present in
//  rawmaterials and creates exactly those.
//
//  ── Case folding is the point ────────────────────────────────────
//  "warp" and "Warp" are the same group written twice, and if this
//  migration created both it would carry the split forward forever.
//  Categories are folded case-insensitively; the spelling kept is the
//  one used by the MOST materials, because that is the one somebody
//  looking at the list will recognise. Members written under the other
//  spelling are rewritten to it, so `category` matches the group name
//  exactly from here on.
//
//  ── Idempotent ───────────────────────────────────────────────────
//  Groups are upserted on a case-insensitive name match and materials
//  are only touched where the link is missing or the name differs.
//  Running it twice changes nothing the second time.
//
//  ── Nothing depends on it having run ─────────────────────────────
//  `category` keeps working on its own: every existing reader uses it
//  and the model still requires it. The `group` link is additive, and
//  /materialForNewElastic falls back to matching the literal keywords
//  when no group carries them. This migration materialises the groups
//  so they can be managed, not so the code becomes correct.
//
//  No index building here. An index built at the end of a migration
//  chain does not return — see 20260809000001-elastic-name-key-unique.
//  The indexes on materialgroups are declared on the schema and built
//  by Mongoose on first connect.
// ══════════════════════════════════════════════════════════════════

// "Warp Yarn" → "WARP_YARN". Must match deriveCode() in
// api/materialGroup.js, or a group seeded here and one created in the
// UI would carry differently-shaped codes.
function toCode(name) {
  return (
    String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'GROUP'
  );
}

// Which axis a group sits on. `warp`/`weft`/`covering` say WHERE in the
// cloth; `rubber`/`chemicals` say WHAT it is. Anything unrecognised is
// left as 'other' rather than guessed — a wrong axis on a report is
// worse than an unset one, and an admin can set it in one click.
function kindOf(name) {
  const n = String(name).toLowerCase();
  if (/warp|weft|covering|beam/.test(n)) return 'position';
  if (/rubber|spandex|yarn|chemical|dye|lycra|elastane/.test(n)) return 'material';
  return 'other';
}

module.exports = {
  async up(db) {
    const materials = db.collection('rawmaterials');
    const groups    = db.collection('materialgroups');

    // ── 1. What categories actually exist, and how many use each ──
    const rows = await materials
      .aggregate([
        { $match: { category: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$category', n: { $sum: 1 } } },
      ])
      .toArray();

    if (rows.length === 0) {
      console.log('[migration] materialgroups: no categories in use, nothing to seed');
      return;
    }

    // ── 2. Fold to one group per case-insensitive name ────────────
    // The winning spelling is the one the most materials use.
    const folded = new Map(); // lowercase → { name, count, spellings[] }
    for (const r of rows) {
      const key = String(r._id).trim().toLowerCase();
      if (!key) continue;
      const entry = folded.get(key) || { name: null, count: -1, spellings: [] };
      entry.spellings.push(String(r._id));
      if (r.n > entry.count) {
        entry.count = r.n;
        entry.name  = String(r._id).trim();
      }
      folded.set(key, entry);
    }

    let created = 0;
    let sortOrder = 0;
    for (const [, entry] of folded) {
      sortOrder += 10;

      // Case-insensitive match, so a re-run finds the group it made
      // last time even if an admin has since changed its capitals.
      const existing = await groups.findOne(
        { name: entry.name },
        { collation: { locale: 'en', strength: 2 } }
      );

      let groupId;
      if (existing) {
        groupId = existing._id;
      } else {
        // The code must be unique. A collision here can only come from
        // two names that differ by punctuation ("Warp Yarn" / "Warp-
        // Yarn"), so suffix rather than fail the whole migration.
        let code = toCode(entry.name);
        for (let n = 2; await groups.findOne({ code }); n += 1) {
          code = `${toCode(entry.name)}_${n}`;
        }
        const now = new Date();
        const ins = await groups.insertOne({
          name:            entry.name,
          code,
          kind:            kindOf(entry.name),
          sortOrder,
          colour:          '',
          defaultUnit:     'kg',
          defaultMinStock: 0,
          notes:           '',
          archived:        false,
          fingerprints:    [],
          createdAt:       now,
          updatedAt:       now,
        });
        groupId = ins.insertedId;
        created += 1;
      }

      // ── 3. Point every member at it, under one spelling ─────────
      // Matched on the spellings seen in the data, case-insensitively,
      // and only rows that are not already correct are written — so a
      // second run reports 0 modified.
      const nameMatches = entry.spellings.map(
        (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
      );
      const res = await materials.updateMany(
        {
          category: { $in: nameMatches },
          $or: [
            { group: { $exists: false } },
            { group: null },
            { group: { $ne: groupId } },
            { category: { $ne: entry.name } },
          ],
        },
        { $set: { category: entry.name, group: groupId } }
      );
      if (res.modifiedCount) {
        console.log(
          `[migration] materialgroups: "${entry.name}" — ` +
          `${res.modifiedCount} material(s) filed` +
          (entry.spellings.length > 1
            ? ` (merged spellings: ${entry.spellings.join(', ')})`
            : '')
        );
      }
    }

    // ── 4. Units ──────────────────────────────────────────────────
    // api/rawMaterial.js has read `m.unit || ""` since long before the
    // field existed, so every unit it returned was empty. kg is what
    // every price in this system is already denominated in.
    const units = await materials.updateMany(
      { $or: [{ unit: { $exists: false } }, { unit: null }, { unit: '' }] },
      { $set: { unit: 'kg' } }
    );

    console.log(
      `[migration] materialgroups: ${created} group(s) created from ` +
      `${folded.size} distinct categor(ies); ${units.modifiedCount} unit(s) defaulted to kg`
    );
  },

  async down(db) {
    // The link and the unit come off; `category` is left exactly as it
    // was, because it is the field every reader has always used and
    // removing it would take the materials' grouping with it.
    await db.collection('rawmaterials').updateMany({}, { $unset: { group: '', unit: '' } });
    await db.collection('materialgroups').deleteMany({});
  },
};

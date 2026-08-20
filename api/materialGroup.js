'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIAL GROUPS
//
//  The single list of groups a material can belong to. Every picker,
//  filter chip and recipe query reads it from here — see the note at
//  the top of models/MaterialGroup.js for the eight disagreeing copies
//  this replaces.
//
//  ── Groups and categories are SEPARATE ───────────────────────────
//  They were one field wearing two hats: `RawMaterial.category` held
//  the group's NAME, so renaming a group rewrote it on every member
//  and creating a group put a new value into a field the engine
//  branches on. A group called "Trim Tape" therefore produced
//  materials whose category the recipe pickers, the MRP sheet and the
//  phone's colour chips had never heard of.
//
//  Now:
//    category — fixed vocabulary, five values, owned by the system.
//               See MATERIAL_CATEGORIES in models/RawMaterial.js.
//    group    — free, admin-managed, owned by the mill. Nothing in
//               the engine branches on it.
//
//  Nothing in this router writes `category` any more, and membership
//  is the LINK alone.
// ══════════════════════════════════════════════════════════════════

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { escapeRegex } = require('../utils/escapeRegex');
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');

const MaterialGroup = require('../models/MaterialGroup');
const RawMaterial   = require('../models/RawMaterial');
const { GROUP_KINDS } = MaterialGroup;

router.use(isAuthenticated);

// Reading the list is not a privileged act — the material form, the
// MRP sheet and the mobile filter chips all need it, and they run for
// production users. Writing one is admin, like every other master.
const writeGate = isAdmin('admin');

function stamp(doc, code, req, meta) {
  const fp = buildFingerprint(code, {
    entityId: doc._id,
    actor:    actorFromRequest(req),
    meta,
  });
  doc.fingerprints = [...(doc.fingerprints || []), fp];
  doc.markModified('fingerprints');
}

/**
 * Turn a name into a stable code: "Warp Yarn" → "WARP_YARN".
 *
 * The code is what survives a rename, so it is derived once at create
 * and never recomputed. Collisions get a numeric suffix rather than an
 * error, because a person naming a group should not have to know what
 * a code is.
 */
async function deriveCode(name) {
  const base = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'GROUP';

  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? base : `${base}_${n + 1}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await MaterialGroup.exists({ code: candidate });
    if (!clash) return candidate;
  }
  return `${base}_${Date.now().toString(36).toUpperCase()}`;
}

// ── ONE definition of "in this group" ────────────────────────────
//
// Three places used to decide this and they did not agree: the member
// count matched the name EXACTLY, the settings screen's counts ignored
// the link entirely, and the rename matched exactly too. Every material
// this app writes now carries the group's own spelling, so all three
// agreed on new data and disagreed on exactly the data the group screen
// exists to tidy up — rows written before the migration, or by a client
// that has not been updated.
//
// It is not cosmetic: the count drives what the confirm dialog SAYS will
// happen. A group reading "0 materials" offers to delete outright, and
// the server then archived it instead, because its own rule found
// members. The dialog was telling the truth about a different query.
//
// Case-insensitive on the name, because "rubber" and "Rubber" are the
// same group written twice — the split this whole feature exists to end.
//
// ── It is the LINK, and only the link ────────────────────────────
// This used to be `{ group: id } OR { category: /^name$/i }`, because
// `category` HELD the group's name and a row written by an older
// client had the name and no link. Now that the two fields are
// independent, that second clause is actively wrong: a material whose
// category is "Rubber" is in the CATEGORY Rubber and says nothing
// about whether anybody filed it under a group of that name.
//
// Leaving it in would mean creating a group called "Rubber" instantly
// claimed every rubber material in the mill as a member, and deleting
// that group reported — and archived — against materials nobody had
// ever put in it.
const memberFilter = (group) => ({ group: group._id });

/**
 * Live members, and members of any kind.
 *
 * Two numbers because they answer two questions. `live` is what the
 * screen shows — an archived material is out of the pickers and listing
 * it would not match what the group's page displays. `total` includes
 * archived rows and is what decides archive-vs-delete: an archived
 * material still NAMES its group, so deleting the group outright leaves
 * it pointing at nothing, and restoring it later brings back a row filed
 * under a group that no longer exists.
 */
async function memberCounts(group) {
  const filter = memberFilter(group);
  const [live, total] = await Promise.all([
    RawMaterial.countDocuments({ ...filter, archived: { $ne: true } }),
    RawMaterial.countDocuments(filter),
  ]);
  return { live, total };
}

// ─────────────────────────────────────────────────────────────
//  GET /  — the list every picker is built from.
//
//    ?kind=position     only the where-in-the-cloth groups, which is
//                       what the elastic recipe pickers want
//    ?includeArchived=1 for the settings screen, so a group archived
//                       by mistake can be found again
//    ?withCounts=1      member counts, for the settings screen only —
//                       it is a countDocuments per group and the
//                       pickers do not need it
// ─────────────────────────────────────────────────────────────
router.get(
  '/',
  catchAsyncErrors(async (req, res, next) => {
    const { kind, includeArchived, withCounts, search } = req.query;

    const filter = {};
    if (!includeArchived) filter.archived = { $ne: true };
    if (kind) {
      if (!GROUP_KINDS.includes(kind)) {
        return next(new ErrorHandler(`kind must be one of: ${GROUP_KINDS.join(', ')}`, 400));
      }
      filter.kind = kind;
    }
    if (search) filter.name = new RegExp(escapeRegex(String(search)), 'i');

    const groups = await MaterialGroup.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    if (!withCounts) {
      return res.json({ success: true, count: groups.length, groups });
    }

    // One aggregation for every group rather than a count per group —
    // the settings screen lists them all, and a query each is how a
    // page that looks instant on ten rows crawls on eighty.
    //
    // Bucketed on the PAIR (link, folded name) so the same rule
    // memberFilter uses can be applied in memory. Each material lands in
    // exactly one bucket, so a row that is both linked and named cannot
    // be counted twice.
    // Archived rows are counted too, in their own bucket. The screen
    // shows the LIVE figure, but the delete dialog has to know about
    // archived members or it promises "removed outright" for a group the
    // server will archive — the same lie, one layer up.
    const buckets = await RawMaterial.aggregate([
      // Only filed materials can be members now — see memberFilter.
      { $match: { group: { $ne: null } } },
      {
        $group: {
          _id: {
            group: '$group',
            archived: { $eq: ['$archived', true] },
          },
          n: { $sum: 1 },
        },
      },
    ]);

    const countFor = (g) => {
      const id = String(g._id);
      let live = 0;
      let total = 0;
      for (const b of buckets) {
        if (String(b._id.group) !== id) continue;
        total += b.n;
        if (!b._id.archived) live += b.n;
      }
      return { live, total };
    };

    res.json({
      success: true,
      count: groups.length,
      groups: groups.map((g) => {
        const { live, total } = countFor(g);
        return { ...g, materialCount: live, totalMaterialCount: total };
      }),
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /create
// ─────────────────────────────────────────────────────────────
router.post(
  '/create',
  writeGate,
  catchAsyncErrors(async (req, res, next) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return next(new ErrorHandler('A group name is required', 400));

    const kind = req.body?.kind ?? 'other';
    if (!GROUP_KINDS.includes(kind)) {
      return next(new ErrorHandler(`kind must be one of: ${GROUP_KINDS.join(', ')}`, 400));
    }

    // Checked here for a readable refusal; the case-insensitive unique
    // index is what actually guarantees it under a race.
    const clash = await MaterialGroup.findOne({ name })
      .collation({ locale: 'en', strength: 2 }).lean();
    if (clash) {
      return next(new ErrorHandler(
        `There is already a group called "${clash.name}".`, 409
      ));
    }

    const group = new MaterialGroup({
      name,
      code: await deriveCode(name),
      kind,
      sortOrder:       Number(req.body?.sortOrder) || 0,
      colour:          String(req.body?.colour ?? '').trim(),
      defaultUnit:     String(req.body?.defaultUnit ?? '').trim(),
      defaultMinStock: Math.max(0, Number(req.body?.defaultMinStock) || 0),
      notes:           String(req.body?.notes ?? '').trim(),
    });
    stamp(group, ACTION_CODES.MATERIAL_GROUP_CREATED, req, { name, kind });

    try {
      await group.save();
    } catch (err) {
      if (err?.code === 11000) {
        return next(new ErrorHandler(`There is already a group called "${name}".`, 409));
      }
      throw err;
    }

    res.status(201).json({ success: true, group });
  })
);

// ─────────────────────────────────────────────────────────────
//  PUT /update
//
//  A rename cascades to every member's `category`. See the header.
// ─────────────────────────────────────────────────────────────
router.put(
  '/update',
  writeGate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid group id is required', 400));
    }
    const group = await MaterialGroup.findById(id);
    if (!group) return next(new ErrorHandler('Group not found', 404));

    const oldName = group.name;
    let renamedCount = 0;

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return next(new ErrorHandler('A group name is required', 400));

      if (name !== oldName) {
        const clash = await MaterialGroup.findOne({ name, _id: { $ne: group._id } })
          .collation({ locale: 'en', strength: 2 }).lean();
        if (clash) {
          return next(new ErrorHandler(
            `There is already a group called "${clash.name}".`, 409
          ));
        }

        // ── A rename no longer touches `category` ────────────────
        //
        // It used to rewrite category on every member, because the two
        // were one field: category HELD the group's name. That is the
        // fusion this change undoes. category is now the system's own
        // fixed vocabulary — warp / weft / covering / Rubber /
        // Chemicals — and the recipe pickers and MRP branch on it, so
        // renaming a group must not be able to write "Trim Tape" into
        // it.
        //
        // What still needs doing is adopting the LINK for rows filed
        // under this group by name alone, before the link existed.
        // One-way tidy-up: sets `group`, leaves `category` alone.
        const moved = await RawMaterial.updateMany(
          { group: null, category: new RegExp(`^${escapeRegex(oldName)}$`, 'i') },
          { $set: { group: group._id } }
        );
        renamedCount = moved.modifiedCount || 0;
        group.name = name;
        // `code` is deliberately NOT recomputed. It is the handle that
        // survives a rename; regenerating it here would defeat the
        // reason it exists.
      }
    }

    if (req.body.kind !== undefined) {
      if (!GROUP_KINDS.includes(req.body.kind)) {
        return next(new ErrorHandler(`kind must be one of: ${GROUP_KINDS.join(', ')}`, 400));
      }
      group.kind = req.body.kind;
    }
    if (req.body.sortOrder !== undefined)   group.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.colour !== undefined)      group.colour = String(req.body.colour).trim();
    if (req.body.notes !== undefined)       group.notes = String(req.body.notes).trim();
    if (req.body.defaultUnit !== undefined) group.defaultUnit = String(req.body.defaultUnit).trim();
    if (req.body.defaultMinStock !== undefined) {
      group.defaultMinStock = Math.max(0, Number(req.body.defaultMinStock) || 0);
    }

    stamp(group, ACTION_CODES.MATERIAL_GROUP_UPDATED, req, {
      from: oldName, to: group.name, materialsRenamed: renamedCount,
    });
    await group.save();

    res.json({ success: true, group, materialsRenamed: renamedCount });
  })
);

// ─────────────────────────────────────────────────────────────
//  DELETE /:id  — archive if it has members, delete if it never did.
//
//  The same rule the three masters follow, for the same reason: a
//  group named by a material is part of how that material reads, and
//  removing it leaves a material whose category points at nothing. A
//  group created by mistake five minutes ago has no such history.
// ─────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  writeGate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid group id is required', 400));
    }
    const group = await MaterialGroup.findById(id);
    if (!group) return next(new ErrorHandler('Group not found', 404));

    const { live, total } = await memberCounts(group);
    if (total > 0) {
      if (group.archived) {
        return next(new ErrorHandler(
          `"${group.name}" is already archived and still holds ${total} material(s).`, 409
        ));
      }
      group.archived   = true;
      group.archivedAt = new Date();
      stamp(group, ACTION_CODES.MATERIAL_GROUP_ARCHIVED, req, {
        name: group.name, members: total, live,
      });
      await group.save();

      // Worded from `live` when there are any, because that is the
      // number on the screen the operator is looking at. When every
      // member is archived the message says so rather than claiming
      // "0 materials" and then refusing to delete.
      const noun = (n) => `${n} material${n === 1 ? '' : 's'}`;
      return res.json({
        success: true,
        archived: true,
        materials: live,
        archivedMaterials: total - live,
        message: live > 0
          ? `"${group.name}" holds ${noun(live)}, so it was archived rather than ` +
            `deleted — it is out of the pickers and every material still reads correctly.`
          : `"${group.name}" was archived rather than deleted: its ${noun(total)} ` +
            `${total === 1 ? 'is' : 'are'} archived and still filed under it.`,
      });
    }

    await MaterialGroup.deleteOne({ _id: group._id });
    res.json({
      success: true,
      archived: false,
      message: `"${group.name}" deleted — nothing was using it.`,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /restore
// ─────────────────────────────────────────────────────────────
router.post(
  '/restore',
  writeGate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid group id is required', 400));
    }
    const group = await MaterialGroup.findById(id);
    if (!group) return next(new ErrorHandler('Group not found', 404));

    group.archived   = false;
    group.archivedAt = undefined;
    stamp(group, ACTION_CODES.MATERIAL_GROUP_UPDATED, req, { change: 'restored' });
    await group.save();

    res.json({ success: true, group, message: `"${group.name}" restored to the pickers.` });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /:id/materials  — what is in this group.
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id/materials',
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid group id is required', 400));
    }
    const group = await MaterialGroup.findById(id).lean();
    if (!group) return next(new ErrorHandler('Group not found', 404));

    // By link OR by name: a material tidied into the group has the
    // link, one that predates the migration may only carry the name,
    // and the screen has to show both or it looks like the group lost
    // its contents.
    const materials = await RawMaterial.find({
      ...memberFilter(group),
      archived: { $ne: true },
    })
      .select('name category group unit stock minStock price avgCost supplier')
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, group, count: materials.length, materials });
  })
);

module.exports = router;

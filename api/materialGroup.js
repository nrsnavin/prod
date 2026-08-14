'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIAL GROUPS
//
//  The single list of groups a material can belong to. Every picker,
//  filter chip and recipe query reads it from here — see the note at
//  the top of models/MaterialGroup.js for the eight disagreeing copies
//  this replaces.
//
//  ── The one rule this router exists to hold ──────────────────────
//  A material carries BOTH the group link and the group's name (as
//  `category`, which every existing reader already uses). Those two
//  must never disagree. So a rename is not a one-document write: it
//  rewrites `category` on every member in the same request, and the
//  members are updated FIRST. If that write fails the group keeps its
//  old name and the data is still consistent; renaming the group first
//  and failing on the members would leave a group whose own members
//  claim to be in a group that no longer exists under that name.
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

/** How many live materials point at this group, by link or by name. */
async function memberCount(group) {
  return RawMaterial.countDocuments({
    archived: { $ne: true },
    $or: [{ group: group._id }, { category: group.name }],
  });
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
    const counts = await RawMaterial.aggregate([
      { $match: { archived: { $ne: true } } },
      { $group: { _id: '$category', n: { $sum: 1 } } },
    ]);
    const byName = new Map(counts.map((c) => [c._id, c.n]));

    res.json({
      success: true,
      count: groups.length,
      groups: groups.map((g) => ({ ...g, materialCount: byName.get(g.name) || 0 })),
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

        // Members first. If this write fails, the group keeps its old
        // name and nothing has drifted — the other order leaves members
        // stranded under a name their group no longer has.
        const moved = await RawMaterial.updateMany(
          { $or: [{ group: group._id }, { category: oldName }] },
          { $set: { category: name, group: group._id } }
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

    const members = await memberCount(group);
    if (members > 0) {
      if (group.archived) {
        return next(new ErrorHandler(
          `"${group.name}" is already archived and still holds ${members} material(s).`, 409
        ));
      }
      group.archived   = true;
      group.archivedAt = new Date();
      stamp(group, ACTION_CODES.MATERIAL_GROUP_ARCHIVED, req, { name: group.name, members });
      await group.save();
      return res.json({
        success: true,
        archived: true,
        materials: members,
        message:
          `"${group.name}" holds ${members} material(s), so it was archived rather than ` +
          `deleted — it is out of the pickers and every material still reads correctly.`,
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
      archived: { $ne: true },
      $or: [{ group: group._id }, { category: group.name }],
    })
      .select('name category group unit stock minStock price avgCost supplier')
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, group, count: materials.length, materials });
  })
);

module.exports = router;

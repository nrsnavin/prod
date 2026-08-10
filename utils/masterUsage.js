'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHERE IS THIS MASTER RECORD USED?
//
//  A raw material, an elastic and a customer are master data: they are
//  named by documents that are the business's actual record of what
//  happened. Deleting one does not undo those documents, it orphans
//  them — an order line pointing at nothing, a goods receipt for a
//  material with no name, a delivery challan whose product cannot be
//  looked up. The screens then render blanks and dashes, and nobody
//  can tell whether the data is wrong or the master is simply gone.
//
//  So a master that has been used is never deleted. It is ARCHIVED:
//  hidden from the pickers so nobody chooses it again, while every
//  reference to it still resolves. Archived is a display filter, not a
//  deletion — which is exactly why it is safe on data with history.
//
//  A master that has never been used has no history to protect, and a
//  typo entered five minutes ago should still be deletable. That is
//  the only case this file exists to identify.
//
//  ── Why counts and labels, not a boolean ─────────────────────────
//  "Cannot delete" is a dead end. "Used by 3 orders and 11 goods
//  receipts" tells the person what they are actually looking at and
//  whether archiving is what they wanted. The label is written the way
//  someone on the floor would say it, not as a collection name.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/**
 * Every place a master id can appear, as {label, model, path}.
 *
 * Kept as data rather than as a pile of hand-written queries so adding
 * a model that references one of these masters is one line, and so a
 * model that is forgotten here is visible as an absence rather than
 * hidden inside an if. A path that does not exist on the schema simply
 * matches nothing, so a rename degrades to "no usage found" rather
 * than to a crash — see the guard in `countUsage`.
 */
const REFERENCES = {
  RawMaterial: [
    // The recipe. First because it is the one that silently breaks a
    // product rather than a document: an elastic whose warp yarn has
    // been deleted still costs and still plans, at nothing.
    { label: 'elastic recipe',   model: 'Elastic',       path: 'warpYarn.id' },
    { label: 'elastic recipe',   model: 'Elastic',       path: 'warpSpandex.id' },
    { label: 'elastic recipe',   model: 'Elastic',       path: 'spandexCovering.id' },
    { label: 'elastic recipe',   model: 'Elastic',       path: 'weftYarn.id' },
    { label: 'order requirement', model: 'Order',        path: 'rawMaterialRequired.rawMaterial' },
    { label: 'purchase order',   model: 'PurchaseOrder', path: 'items.rawMaterial' },
    { label: 'goods receipt',    model: 'MaterialInward', path: 'rawMaterial' },
    { label: 'material issue',   model: 'MaterialOutward', path: 'rawMaterial' },
    { label: 'dye lot',          model: 'YarnLot',       path: 'rawMaterial' },
    { label: 'warping programme', model: 'WarpingPlan',  path: 'beams.sections.warpYarn' },
    { label: 'warping batch',    model: 'WarpingBatch',  path: 'rawMaterial' },
    { label: 'stock count',      model: 'StockCount',    path: 'lines.rawMaterial' },
  ],

  Elastic: [
    { label: 'order',            model: 'Order',          path: 'elasticOrdered.elastic' },
    { label: 'job',              model: 'JobOrder',       path: 'elastics.elastic' },
    { label: 'delivery challan', model: 'DeliveryChallan', path: 'items.elastic' },
    { label: 'packing entry',    model: 'Packing',        path: 'elastic' },
    { label: 'wastage entry',    model: 'Wastage',        path: 'elastic' },
    { label: 'QC record',        model: 'QcRecord',       path: 'elastic' },
    { label: 'shift entry',      model: 'ShiftDetail',    path: 'elastic' },
    { label: 'elastic group',    model: 'ElasticGroup',   path: 'items.elastic' },
    { label: 'machine head map', model: 'Machine',        path: 'elastics.elastic' },
    { label: 'warping programme', model: 'WarpingPlan',   path: 'beams.elastic' },
    { label: 'stock movement',   model: 'StockMovement',  path: 'elastic' },
  ],

  Customer: [
    { label: 'order',            model: 'Order',          path: 'customer' },
    { label: 'job',              model: 'JobOrder',       path: 'customer' },
    { label: 'sample request',   model: 'SampleRequest',  path: 'customer' },
    { label: 'complaint',        model: 'Complaints',     path: 'customer' },
    { label: 'elastic group',    model: 'ElasticGroup',   path: 'customer' },
    { label: 'portal login',     model: 'CustomerUser',   path: 'customer' },
  ],
};

/** "3 orders", "1 job" — the count and its label, pluralised. */
function phrase(label, count) {
  if (count === 1) return `1 ${label}`;
  // "elastic recipe" → "elastic recipes"; "QC record" → "QC records".
  return `${count} ${label}s`;
}

/**
 * Count every document that names this master.
 *
 * @param {'RawMaterial'|'Elastic'|'Customer'} kind
 * @param {ObjectId|string} id
 * @returns {Promise<{used: boolean, total: number,
 *                    places: Array<{label: string, count: number}>,
 *                    summary: string}>}
 */
async function countUsage(kind, id) {
  const refs = REFERENCES[kind];
  if (!refs) throw new Error(`countUsage: nothing known about '${kind}'`);

  // Counted per label, not per path: a raw material named as both the
  // warp yarn and the weft yarn of one elastic is used by "1 elastic
  // recipe", and reporting it as two would be a lie about how much is
  // in the way. Ids are collected per label and de-duplicated.
  const idsByLabel = new Map();

  for (const ref of refs) {
    let Model;
    try {
      Model = mongoose.model(ref.model);
    } catch {
      // The model is not registered in this process. Skipping is the
      // right call — but silently deciding "unused" because a model
      // failed to load would authorise a delete on the strength of a
      // missing file, so say so.
      console.warn(`[masterUsage] model '${ref.model}' not registered — not checked`);
      continue;
    }

    const rows = await Model.find({ [ref.path]: id }).select('_id').limit(1000).lean();
    if (rows.length === 0) continue;

    const bucket = idsByLabel.get(ref.label) || new Set();
    for (const r of rows) bucket.add(String(r._id));
    idsByLabel.set(ref.label, bucket);
  }

  const places = [...idsByLabel.entries()]
    .map(([label, set]) => ({ label, count: set.size }))
    // Biggest first: it is the one that decides the answer.
    .sort((a, b) => b.count - a.count);

  const total = places.reduce((s, p) => s + p.count, 0);

  return {
    used: total > 0,
    total,
    places,
    summary: places.map((p) => phrase(p.label, p.count)).join(', '),
  };
}

module.exports = { countUsage, REFERENCES };

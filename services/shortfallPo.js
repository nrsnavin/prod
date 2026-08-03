'use strict';
//
// Raising purchase orders from a material shortfall.
//
// Shared by the job-level MRP and the order-level one. They ask the same
// question of different quantities — "what is short, and who do we buy it
// from" — and the rules for answering it (only the gap, one PO per
// supplier, never order on a material we cannot resolve) must not drift
// apart between the two.

const PurchaseOrder = require('../models/PurchaseOrder');
const { nextNumber } = require('../utils/sequence');

/**
 * How much of a row still needs buying.
 *
 * The gap less what is already on order. Pressing the shortfall panel's
 * button twice used to raise a second purchase order for the same
 * quantity — the first one had not arrived, so the shortfall had not
 * moved, and nothing on this path looked at the outstanding POs the
 * sheet was already reporting beside it.
 *
 * Falls back to the raw shortfall for callers whose rows predate the
 * field, so a stale row is never silently treated as fully covered.
 */
const buyable = (m) =>
  Number(m?.toBuy ?? m?.shortfall) || 0;

/** Split a computed requirement into what can be ordered and what cannot. */
function triageShortfall(requirement, only) {
  let short = (requirement || []).filter((m) => buyable(m) > 0);

  if (Array.isArray(only) && only.length) {
    const wanted = only.map(String);
    short = short.filter((m) => wanted.includes(String(m.rawMaterial)));
  }

  return {
    // A material whose reference could not be resolved has a placeholder
    // stock figure, so its "shortfall" is not a reading — buying against
    // it would be guessing with money.
    unresolved: short.filter((m) => m.stockKnown === false),
    noSupplier: short.filter((m) => m.stockKnown !== false && !m.supplierId),
    orderable: short.filter((m) => m.stockKnown !== false && m.supplierId),
    anyShort: short.length > 0,
    // Short, but the purchase order for it already exists. Worth saying
    // apart from "nothing is short", because the two ask for opposite
    // things: one is finished, the other is waiting on a delivery.
    awaitingDelivery: (requirement || []).filter(
      (m) => Number(m.shortfall) > 0 && buyable(m) <= 0
    ),
  };
}

const skipReasons = (unresolved, noSupplier) => [
  ...noSupplier.map((m) => ({
    rawMaterial: String(m.rawMaterial), name: m.name, reason: 'no supplier set',
  })),
  ...unresolved.map((m) => ({
    rawMaterial: String(m.rawMaterial), name: m.name, reason: 'material not found',
  })),
];

async function nextPoNo() {
  return nextNumber('poNo', async () => {
    const last = await PurchaseOrder.findOne({ poNo: { $ne: null } })
      .sort({ poNo: -1 }).select('poNo').lean();
    return last?.poNo || 0;
  });
}

/**
 * Create one purchase order per supplier covering the orderable shortfall.
 *
 * @param {Array}  orderable   rows from triageShortfall
 * @param {Object} link        { forJob, forOrder } — what the PO is for
 * @param {Object} opts        { expectedDate, notes }
 */
async function createShortfallPos(orderable, link = {}, opts = {}) {
  const bySupplier = new Map();
  for (const m of orderable) {
    if (!bySupplier.has(m.supplierId)) {
      bySupplier.set(m.supplierId, { supplierName: m.supplierName, lines: [] });
    }
    bySupplier.get(m.supplierId).lines.push(m);
  }

  const expected = opts.expectedDate ? new Date(opts.expectedDate) : null;
  const created = [];

  for (const [supplierId, group] of bySupplier) {
    const poNo = await nextPoNo();
    const po = await PurchaseOrder.create({
      supplier: supplierId,
      items: group.lines.map((m) => ({
        rawMaterial: m.rawMaterial,
        price: Number(m.unitPrice) || 0,
        // The gap, not the whole requirement — stock on hand is not
        // bought a second time, and neither is stock already on order.
        quantity: buyable(m),
        receivedQuantity: 0,
      })),
      expectedDate: expected && !isNaN(expected.getTime()) ? expected : undefined,
      notes: typeof opts.notes === 'string' && opts.notes.trim()
        ? opts.notes.trim()
        : opts.defaultNote || '',
      poNo,
      status: 'Open',
      forJob: link.forJob || undefined,
      forOrder: link.forOrder || undefined,
    });

    created.push({
      poId: po._id,
      poNo: po.poNo,
      supplierId,
      supplierName: group.supplierName,
      lines: group.lines.map((m) => ({
        rawMaterial: String(m.rawMaterial),
        name: m.name,
        quantity: buyable(m),
        price: Number(m.unitPrice) || 0,
      })),
      value: group.lines.reduce((s, m) => s + buyable(m) * (Number(m.unitPrice) || 0), 0),
    });
  }

  return created;
}

module.exports = { triageShortfall, createShortfallPos, skipReasons };

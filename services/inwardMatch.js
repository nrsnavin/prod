'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SUPPLIER'S CHALLAN, MATCHED TO ITS PURCHASE ORDER
//
//  matchInward(read, { poId }) → { po: { _id, poNo } | null, rows }
//
//  What utils/inwardOcr.js read from a challan or cone labels, set
//  against the PO it is for: the PO the inward form is on, else the one
//  the document quotes. Each line is matched to one of that PO's
//  materials by name (a count that differs is never matched), with how
//  much of it is still to come. Two lots of one material stay two rows.
//  Used by the inward form (api/supplier.js /inward/read) and by a
//  challan photo sent to the WhatsApp number (services/whatsappPapers.js).
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');

async function matchInward(read, { poId = null } = {}) {
  let po = null;
  if (mongoose.isValidObjectId(String(poId || ''))) po = await PurchaseOrder.findById(poId).populate('items.rawMaterial', 'name').lean();
  if (!po && read.poNumber) {
    const n = Number(String(read.poNumber).replace(/\D/g, ''));
    if (n) po = await PurchaseOrder.findOne({ poNo: n }).populate('items.rawMaterial', 'name').lean();
  }
  const { rank } = require('../utils/fuzzyMatch');
  const choices = (po?.items || []).filter((it) => it.rawMaterial).map((it) => ({ id: String(it.rawMaterial._id || it.rawMaterial), label: it.rawMaterial.name || '' }));
  const rows = (read.lines || []).map((l) => {
    const m = choices.length ? rank(l.description, choices) : { confident: false, best: null, candidates: [] };
    const item = m.confident ? po.items.find((it) => String(it.rawMaterial._id || it.rawMaterial) === m.best.id) : null;
    return {
      ...l,
      rawMaterial: m.confident ? m.best.id : null,
      materialName: m.confident ? m.best.label : null,
      pending: item ? Math.max(0, (item.quantity || 0) - (item.receivedQuantity || 0)) : null,
      candidates: (m.candidates || []).slice(0, 4).map((c) => ({ id: c.id, name: c.label, score: c.score })),
    };
  });
  return { po: po ? { _id: po._id, poNo: po.poNo } : null, rows };
}

module.exports = { matchInward };

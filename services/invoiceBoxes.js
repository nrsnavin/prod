'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN INVOICE'S BOXES ARE ITS CHALLANS' BOXES
//
//  Boxes are counted where the goods are packed and sent: on the
//  delivery challan, line by line (models/DeliveryChallan.js). The
//  invoice raised against the challans does not ask again. Each of its
//  lines carries that elastic's boxes on its challans, and its total is
//  every box on them (api/invoice.js).
//
//  When a challan's lines are corrected after it was invoiced, the
//  invoice's boxes follow it. Only the boxes: nothing taxed changes,
//  since a box count is printed on the paper and is not part of the GST
//  return, the e-invoice or the customer's account.
// ══════════════════════════════════════════════════════════════════

const DeliveryChallan = require('../models/DeliveryChallan');
const Invoice = require('../models/Invoice');

/** Boxes per elastic id, and in all, over these challans' lines. */
function boxesOf(dcs) {
  const byElastic = new Map();
  let total = 0;
  for (const dc of dcs || []) {
    for (const item of dc.items || []) {
      const n = Number(item.boxes) || 0;
      total += n;
      if (!item.elastic) continue;
      const key = String(item.elastic._id || item.elastic);
      byElastic.set(key, (byElastic.get(key) || 0) + n);
    }
  }
  return { byElastic, total };
}

/**
 * Put its challans' boxes on every issued invoice that carries this
 * challan. Inside the caller's transaction when given its session.
 * Returns the invoice numbers whose boxes changed.
 */
async function syncInvoiceBoxes(dcId, session = null) {
  const changed = [];
  const invoices = await Invoice.find({ 'dcs.dc': dcId, status: 'issued' }).session(session);
  for (const inv of invoices) {
    const dcs = await DeliveryChallan.find({ _id: { $in: inv.dcs.map((d) => d.dc) } })
      .select('items.elastic items.boxes').session(session).lean();
    const { byElastic, total } = boxesOf(dcs);
    let differs = (inv.totalBoxes || 0) !== total;
    for (const line of inv.lines) {
      const n = byElastic.get(String(line.elastic)) || 0;
      if ((line.boxes || 0) !== n) {
        line.boxes = n;
        differs = true;
      }
    }
    if (!differs) continue;
    inv.totalBoxes = total;
    await inv.save({ session });
    changed.push(inv.invoiceNumber);
  }
  return changed;
}

module.exports = { boxesOf, syncInvoiceBoxes };

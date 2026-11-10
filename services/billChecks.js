'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A SUPPLIER BILL IS CHECKED AGAINST BEFORE IT IS ENTERED
//
//  variance()  the three-way match: each billed line against the PO's
//              rate and the quantity actually received on the receipts
//              being billed. A rate off the PO by more than the
//              tolerance (Accounts settings), or more billed than was
//              received, is a variance: the bill then needs a note from
//              whoever enters it, and the variance is kept on the bill
//              (with a debit note one click away).
//
//  gstRules()  what the supplier's GST registration allows: a
//              composition dealer or an unregistered supplier charges no
//              GST; under reverse charge the supplier charges none and
//              we pay it, so the bill's total is its taxable value and
//              the tax is a liability we also claim back.
// ══════════════════════════════════════════════════════════════════

const PurchaseOrder = require('../models/PurchaseOrder');
const MaterialInward = require('../models/MaterialInward');
const ErrorHandler = require('../utils/ErrorHandler');

const { r2 } = require('../utils/money');
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * @param lines   priced lines (rawMaterial, description, quantity, rate)
 * @param po      PurchaseOrder id
 * @param inwards MaterialInward ids being billed
 * @param tolerancePercent  how far a rate may stray
 * @returns { lines: [...], total } — only the lines that vary
 */
async function variance({ lines, po, inwards = [], tolerancePercent = 2 }) {
  if (!po) return { lines: [], total: 0 };
  const order = await PurchaseOrder.findById(po).select('items').lean();
  if (!order) return { lines: [], total: 0 };
  const poRate = new Map((order.items || []).map((it) => [String(it.rawMaterial), Number(it.price) || 0]));
  const received = new Map();
  if (inwards.length) {
    for (const i of await MaterialInward.find({ _id: { $in: inwards } }).select('rawMaterial quantity').lean()) {
      const k = String(i.rawMaterial);
      received.set(k, r3((received.get(k) || 0) + (i.quantity || 0)));
    }
  }
  const out = [];
  for (const l of lines) {
    if (!l.rawMaterial) continue;
    const k = String(l.rawMaterial);
    const expected = poRate.get(k);
    const got = received.has(k) ? received.get(k) : null;
    const rateOff = expected > 0 && Math.abs(l.rate - expected) / expected * 100 > tolerancePercent + 1e-9;
    const qtyOver = got !== null && l.quantity > got + 0.0005;
    if (!rateOff && !qtyOver) continue;
    // What the bill charges beyond the PO rate on the received quantity, and for anything not received.
    const extraRate = rateOff ? r2((l.rate - expected) * Math.min(l.quantity, got ?? l.quantity)) : 0;
    const extraQty = qtyOver ? r2((l.quantity - got) * l.rate) : 0;
    out.push({
      description: l.description, rawMaterial: l.rawMaterial,
      poRate: expected ?? null, billRate: l.rate, receivedQty: got, billedQty: l.quantity,
      rateOffPercent: expected > 0 ? r2((l.rate - expected) / expected * 100) : null,
      amount: r2(extraRate + extraQty),
    });
  }
  return { lines: out, total: r2(out.reduce((s, x) => s + x.amount, 0)) };
}

/**
 * Applies the supplier's GST position to priced totals. Throws for a
 * composition or unregistered supplier billed with GST.
 * @returns { totals, rcm, itcAmount }
 */
function gstRules({ supplier, priced, reverseCharge, itcEligible }) {
  const reg = supplier.gstRegistration || 'regular';
  const t = priced.totals;
  if ((reg === 'composition' || reg === 'unregistered') && !reverseCharge && t.tax > 0) {
    throw new ErrorHandler(`${supplier.name} is ${reg === 'composition' ? 'a composition dealer' : 'not registered for GST'} and cannot charge GST — enter the lines at 0% (or tick reverse charge if it applies)`, 400);
  }
  if (!reverseCharge) return { totals: t, rcm: null, itcAmount: itcEligible ? t.tax : 0 };
  // Reverse charge: the supplier is owed the value; we pay the tax to the government and claim it.
  const rcm = { cgst: t.cgst, sgst: t.sgst, igst: t.igst, tax: t.tax };
  const totals = { ...t, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, grand: r2(t.taxable) };
  return { totals, rcm, itcAmount: itcEligible ? rcm.tax : 0 };
}

module.exports = { variance, gstRules };

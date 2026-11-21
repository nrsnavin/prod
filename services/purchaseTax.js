'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST ON WHAT WE BUY
//
//  A raw material carries its HSN and GST rate. A purchase order line
//  carries its own copy, taken from the material when the PO is raised
//  (or typed on the line), so the document keeps the rate it was sent
//  with when the material's changes later.
//
//  Read in one order, everywhere: the line's own figure, else the
//  material's, else the default rate in Settings → Invoice. Lines
//  written before these fields existed have neither, and are priced
//  at the material's rate or the default — the same answer the bill
//  form has always pre-filled for them.
//
//  The tax itself is the sales invoice's arithmetic (services/gst.js)
//  turned round: the supplier is the seller, we are the buyer, so the
//  supplier's state against ours decides CGST + SGST or IGST. A
//  composition dealer or an unregistered supplier cannot charge GST
//  (services/billChecks.js refuses such a bill with tax on it), so
//  their POs carry none.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');
const { computeInvoice, stateCodeFromGstin } = require('./gst');

const HSN_RE = /^\d{4,8}$/;
const NO_GST = { composition: 'a composition dealer', unregistered: 'not registered for GST' };

/** An HSN as typed: blank, or 4 to 8 digits. Throws ErrorHandler(400). */
function readHsn(value, label = 'HSN') {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (!HSN_RE.test(s)) throw new ErrorHandler(`${label} is 4 to 8 digits`, 400);
  return s;
}

/**
 * A GST rate as typed: null when blank (meaning "not stated here"),
 * else a number from 0 to 100, to the hundredth. Throws ErrorHandler(400).
 */
function readGstPercent(value, label = 'GST %') {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new ErrorHandler(`${label} must be between 0 and 100`, 400);
  }
  return Math.round(n * 100) / 100;
}

const isRate = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

/** Our state and the default rate, off Settings. */
async function purchaseTaxSettings() {
  const s = await require('./documentSettings').getDocumentSettings();
  const d = s.invoice?.defaultGstPercent;
  return {
    ourState: s.invoice?.stateCode || stateCodeFromGstin(s.gstin),
    defaultGst: isRate(d) ? Number(d) : 5,
  };
}

/** A line's rate: its own, else its material's, else the default. */
function lineGst(line, material, defaultGst = 5) {
  if (isRate(line?.gstPercent)) return Number(line.gstPercent);
  if (isRate(material?.gstPercent)) return Number(material.gstPercent);
  return isRate(defaultGst) ? Number(defaultGst) : 5;
}

/** A line's HSN: its own, else its material's. */
function lineHsn(line, material) {
  return String(line?.hsn || material?.hsn || '').trim();
}

/** Why a supplier charges no GST, or '' when it does. */
const noGstReason = (supplier) => {
  const why = NO_GST[supplier?.gstRegistration];
  return why ? `${supplier.name || 'This supplier'} is ${why}, so no GST is charged` : '';
};

/**
 * Price a purchase order: each line's taxable value and tax, and the
 * totals. `po.supplier` populated with gstin (and gstRegistration);
 * `items.rawMaterial` populated with hsn and gstPercent where the lines
 * may predate the fields. Pure.
 *
 * Each line's `gstPercent` is its rate (its own, its material's or the
 * default) even where `noGst` holds and the tax on it is nothing: the
 * rate belongs to the goods, and an edit form loading it must not save
 * 0 over it.
 *
 * @returns {{ supplyType: 'intra'|'inter', noGst: string,
 *             lines: Array<{ hsn, gstPercent, taxable, cgst, sgst, igst, amount }>,
 *             totals: { taxable, cgst, sgst, igst, tax, roundOff, grand } }}
 */
function pricePo(po, { ourState = '', defaultGst = 5 } = {}) {
  const supplier = po?.supplier && typeof po.supplier === 'object' ? po.supplier : {};
  const noGst = noGstReason(supplier);
  const lines = (Array.isArray(po?.items) ? po.items : []).map((it) => {
    const m = it.rawMaterial && typeof it.rawMaterial === 'object' ? it.rawMaterial : null;
    return {
      quantity: Number(it.quantity) || 0,
      rate: Number(it.price) || 0,
      hsn: lineHsn(it, m),
      gstPercent: lineGst(it, m, defaultGst),
    };
  });
  const p = computeInvoice(lines, {
    sellerStateCode: stateCodeFromGstin(supplier.gstin),
    buyerStateCode: ourState,
    zeroRated: !!noGst,
  });
  return {
    supplyType: p.supplyType,
    noGst,
    lines: p.lines.map((l, i) => ({
      hsn: l.hsn, gstPercent: lines[i].gstPercent, taxable: l.taxable,
      cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount,
    })),
    totals: p.totals,
  };
}

/**
 * The lines with their HSN and rate filled in from the material, then
 * the default, where the line does not state its own. For the places a
 * PO is made from lines that did not come through a form (a clone, a
 * shortfall); readPoLines does the same for the ones that did.
 */
async function stampLineTax(lines, { defaultGst } = {}) {
  const RawMaterial = require('../models/RawMaterial');
  const ids = [...new Set(lines.map((l) => String(l.rawMaterial?._id ?? l.rawMaterial)))];
  const materials = new Map(
    (await RawMaterial.find({ _id: { $in: ids } }).select('hsn gstPercent').lean()).map((m) => [String(m._id), m])
  );
  const fallback = isRate(defaultGst) ? Number(defaultGst) : (await purchaseTaxSettings()).defaultGst;
  return lines.map((l) => {
    const m = materials.get(String(l.rawMaterial?._id ?? l.rawMaterial));
    return { ...l, hsn: lineHsn(l, m), gstPercent: lineGst(l, m, fallback) };
  });
}

module.exports = {
  readHsn, readGstPercent, purchaseTaxSettings, lineGst, lineHsn, noGstReason, pricePo, stampLineTax,
};

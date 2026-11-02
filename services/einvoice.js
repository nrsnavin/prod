'use strict';
// ══════════════════════════════════════════════════════════════════
//  E-INVOICE (INV-01, schema version 1.1) FROM A STORED INVOICE
//
//  The JSON the Invoice Registration Portal takes, built from the
//  snapshot on the invoice. `readiness()` lists what the portal would
//  refuse — a missing buyer GSTIN, no PIN code, no HSN — BEFORE any
//  provider is called, so the screen can say what to fix on the
//  customer or in Settings rather than relaying a portal error code.
//
//  Reference: NIC e-invoice schema (INV-01), mandatory fields only,
//  plus the optional order reference under RefDtls.
// ══════════════════════════════════════════════════════════════════

const { isGstin, round2 } = require('./gst');

// GST unit quantity codes for the units the challans use.
const UQC = { m: 'MTR', mtr: 'MTR', meter: 'MTR', metre: 'MTR', pcs: 'PCS', pc: 'PCS', kg: 'KGS', kgs: 'KGS', nos: 'NOS', set: 'SET', roll: 'ROL' };
const uqc = (unit) => UQC[String(unit || '').trim().toLowerCase()] || 'OTH';

const ddmmyyyy = (d) => {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()}`;
};

const num = (n) => round2(n);

function buildEinvoiceJson(inv) {
  const s = inv.seller || {};
  const b = inv.buyer || {};
  const t = inv.totals || {};
  const docNo = String(inv.invoiceNumber || '');
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    // INV for an invoice; CRN / DBN for a credit or debit note to the buyer.
    DocDtls: { Typ: inv.einvoiceType || 'INV', No: docNo, Dt: ddmmyyyy(inv.invoiceDate) },
    SellerDtls: {
      Gstin: s.gstin || '', LglNm: s.name || '', Addr1: s.address || '', Loc: s.city || '',
      Pin: Number(s.pincode) || 0, Stcd: s.stateCode || '',
      ...(s.phone ? { Ph: s.phone } : {}), ...(s.email ? { Em: s.email } : {}),
    },
    BuyerDtls: {
      Gstin: b.gstin || '', LglNm: b.name || '', Pos: inv.placeOfSupply || b.stateCode || '',
      Addr1: b.address || '', Loc: b.city || '', Pin: Number(b.pincode) || 0, Stcd: b.stateCode || '',
      ...(b.phone ? { Ph: b.phone } : {}), ...(b.email ? { Em: b.email } : {}),
    },
    ItemList: (inv.lines || []).map((l, i) => ({
      SlNo: String(i + 1),
      PrdDesc: l.name,
      IsServc: 'N',
      HsnCd: l.hsn || '',
      Qty: num(l.quantity),
      Unit: uqc(l.unit),
      UnitPrice: num(l.rate),
      TotAmt: num(l.taxable),
      Discount: 0,
      AssAmt: num(l.taxable),
      GstRt: num(l.gstPercent),
      IgstAmt: num(l.igst),
      CgstAmt: num(l.cgst),
      SgstAmt: num(l.sgst),
      TotItemVal: num(l.amount),
    })),
    ValDtls: {
      AssVal: num(t.taxable), CgstVal: num(t.cgst), SgstVal: num(t.sgst), IgstVal: num(t.igst),
      RndOffAmt: num(t.roundOff), TotInvVal: num(t.grand),
    },
    ...(inv.customerPo || inv.orderNo != null || inv.precedingDoc ? {
      RefDtls: {
        ...(inv.customerPo ? { DocPerdDtls: undefined, ContrDtls: [{ PoRefr: String(inv.customerPo).slice(0, 16) }] } : {}),
        ...(inv.orderNo != null ? { InvRm: `Order #${inv.orderNo}` } : {}),
        // A note names the invoice it adjusts.
        ...(inv.precedingDoc ? { PrecDocDtls: [{ InvNo: String(inv.precedingDoc.no), InvDt: ddmmyyyy(inv.precedingDoc.date) }] } : {}),
      },
    } : {}),
  };
}

/** What stops this invoice being registered. Empty = ready. */
function readiness(inv) {
  const s = inv.seller || {};
  const b = inv.buyer || {};
  const problems = [];
  if (!isGstin(s.gstin)) problems.push('Your GSTIN is missing or not valid (Settings → Documents).');
  if (!s.pincode || !/^\d{6}$/.test(String(s.pincode))) problems.push('Your PIN code is missing (Settings → Invoice).');
  if (!s.city) problems.push('Your city is missing (Settings → Invoice).');
  if (!s.address) problems.push('Your address is missing (Settings → Documents).');
  if (!isGstin(b.gstin)) problems.push(`${b.name || 'The customer'} has no valid GSTIN on the customer record.`);
  if (!b.pincode || !/^\d{6}$/.test(String(b.pincode))) problems.push(`${b.name || 'The customer'} has no PIN code on the customer record.`);
  if (!b.address) problems.push(`${b.name || 'The customer'} has no billing address on the customer record.`);
  if (!b.city) problems.push(`${b.name || 'The customer'} has no city on the customer record.`);
  if (!(inv.lines || []).length) problems.push('The invoice has no lines.');
  (inv.lines || []).forEach((l, i) => {
    if (!l.hsn) problems.push(`Line ${i + 1} (${l.name}) has no HSN code.`);
    if (!(Number(l.rate) > 0)) problems.push(`Line ${i + 1} (${l.name}) has no rate.`);
  });
  if (inv.status === 'cancelled') problems.push(`The ${inv.einvoiceType && inv.einvoiceType !== 'INV' ? 'note' : 'invoice'} is cancelled.`);
  return problems;
}

module.exports = { buildEinvoiceJson, readiness, uqc };

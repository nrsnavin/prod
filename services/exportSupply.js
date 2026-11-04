'use strict';
// ══════════════════════════════════════════════════════════════════
//  EXPORT, SEZ AND DEEMED-EXPORT SUPPLIES
//
//  A sale out of the country, or to a unit in a Special Economic Zone,
//  is zero-rated (IGST Act s.16): either made under a Letter of
//  Undertaking with no tax charged (EXPWOP / SEZWOP), or with IGST
//  charged and refunded later (EXPWP / SEZWP). A deemed export (DEXP:
//  to an EOU, against advance authorisation) is taxed like a domestic
//  sale and only reported apart.
//
//  The kind decides the pricing (services/gst.js), the place of supply
//  (96, "other country", for an export), the e-invoice's SupTyp and
//  ExpDtls, the GSTR-1 table (EXP, or B2B as SEWP/SEWOP/DE), the sales
//  ledger in Tally, and the declaration printed on the invoice. An
//  export also carries the currency and rate the buyer was invoiced
//  in, the port, and the shipping bill once customs issue it.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');

const KINDS = {
  EXPWP:  { label: 'Export, with IGST (refund claimed)',      supply: 'export', zeroRated: false, lut: false, gstr1: 'WPAY',  declaration: 'SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX' },
  EXPWOP: { label: 'Export under LUT, no IGST',               supply: 'export', zeroRated: true,  lut: true,  gstr1: 'WOPAY', declaration: 'SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX' },
  SEZWP:  { label: 'To an SEZ unit, with IGST',               supply: 'sez',    zeroRated: false, lut: false, gstr1: 'SEWP',  declaration: 'SUPPLY TO SEZ UNIT / DEVELOPER ON PAYMENT OF INTEGRATED TAX' },
  SEZWOP: { label: 'To an SEZ unit under LUT, no IGST',       supply: 'sez',    zeroRated: true,  lut: true,  gstr1: 'SEWOP', declaration: 'SUPPLY TO SEZ UNIT / DEVELOPER UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX' },
  DEXP:   { label: 'Deemed export (EOU, advance authorisation)', supply: null,  zeroRated: false, lut: false, gstr1: 'DE',    declaration: 'DEEMED EXPORT (NOTIFICATION 48/2017-CT)' },
};
const OTHER_COUNTRY = '96';

const options = () => Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, zeroRated: k.zeroRated, needsLut: k.lut }));

/** What a customer's file suggests: SEZ, abroad, or nothing. */
function suggestFor(customer) {
  if (!customer) return '';
  if (customer.sez) return 'SEZWOP';
  const c = String(customer.country || '').trim().toLowerCase();
  if (c && c !== 'india' && c !== 'in') return 'EXPWOP';
  return '';
}

/** Whether the LUT on file covers a day. */
function lutCovers(lut, date) {
  if (!lut?.number) return false;
  const d = new Date(date);
  if (lut.validFrom && d < new Date(lut.validFrom)) return false;
  if (lut.validTo && d > new Date(new Date(lut.validTo).getTime() + 86_399_999)) return false;
  return true;
}

/**
 * The export block from a request body, checked. Returns undefined when
 * the body names no kind (a domestic sale).
 */
function read(raw, { lut, invoiceDate, customer } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.kind) return undefined;
  const k = KINDS[raw.kind];
  if (!k) throw new ErrorHandler(`export.kind must be one of ${Object.keys(KINDS).join(', ')}`, 400);
  const out = { kind: raw.kind, currency: String(raw.currency || customer?.currency || '').trim().toUpperCase().slice(0, 3), exchangeRate: 0, countryCode: String(raw.countryCode || '').trim().toUpperCase().slice(0, 2), portCode: String(raw.portCode || '').trim().toUpperCase().slice(0, 10), shippingBill: {}, lut: {} };
  if (k.supply === 'export') {
    if (out.currency && out.currency !== 'INR') {
      const rate = Number(raw.exchangeRate);
      if (!(rate > 0)) throw new ErrorHandler(`Give the exchange rate: rupees per ${out.currency}`, 400);
      out.exchangeRate = Math.round(rate * 10000) / 10000;
    } else out.currency = out.currency || 'INR';
    if (out.countryCode && !/^[A-Z]{2}$/.test(out.countryCode)) throw new ErrorHandler('countryCode is the two-letter country code (DE, US, AE)', 400);
    if (!out.countryCode) throw new ErrorHandler('Give the destination country code (two letters)', 400);
  } else {
    out.currency = 'INR';
  }
  if (raw.shippingBill?.number) {
    out.shippingBill = { number: String(raw.shippingBill.number).trim().slice(0, 20), date: raw.shippingBill.date ? new Date(raw.shippingBill.date) : undefined };
    if (out.shippingBill.date && Number.isNaN(out.shippingBill.date.getTime())) throw new ErrorHandler('shippingBill.date is not a date', 400);
  }
  if (k.lut) {
    if (!lutCovers(lut, invoiceDate)) throw new ErrorHandler(`${k.label} needs a Letter of Undertaking valid on the invoice date — enter the LUT number and its year in Accounts → Settings, or raise it with IGST.`, 409);
    out.lut = { number: lut.number, validFrom: lut.validFrom || undefined, validTo: lut.validTo || undefined };
  }
  return out;
}

/** The pricing options for services/gst.js. */
function pricing(exp) {
  const k = exp?.kind ? KINDS[exp.kind] : null;
  if (!k || !k.supply) return {};
  return { supply: k.supply, zeroRated: k.zeroRated };
}

const declaration = (exp) => (exp?.kind ? KINDS[exp.kind].declaration : '');
const isZeroRated = (exp) => !!(exp?.kind && KINDS[exp.kind].zeroRated);
const gstr1Type = (exp) => (exp?.kind ? KINDS[exp.kind].gstr1 : '');
const isExport = (doc) => doc?.supplyType === 'export' || doc?.supplyType === 'sez';

/** Value in the invoice's foreign currency, from the rupee total and the rate. */
function fxValue(exp, grand) {
  if (!exp?.exchangeRate || !(exp.exchangeRate > 0)) return null;
  return Math.round(((Number(grand) || 0) / exp.exchangeRate) * 100) / 100;
}

module.exports = { KINDS, OTHER_COUNTRY, options, suggestFor, lutCovers, read, pricing, declaration, isZeroRated, gstr1Type, isExport, fxValue };

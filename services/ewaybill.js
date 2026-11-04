'use strict';
// ══════════════════════════════════════════════════════════════════
//  E-WAY BILL  (CGST Rule 138)
//
//  Goods worth more than ₹50,000 move with an e-way bill, or can be
//  detained with a penalty equal to the tax (s.129). An invoice with an
//  IRN gets its e-way bill from the same portal in one call (the GSP's
//  "generate EWB by IRN"); a challan, or an invoice without a provider,
//  takes the number the portal gave, pasted in.
//
//  needed()   whether this document needs one
//  payload()  the by-IRN request, as the NIC API takes it
//  generate() through the connected provider, stamped on the document
//  paste()    the number and validity from the portal
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');
const { getProvider } = require('./einvoiceProvider');

const LIMIT = 50000;
const MODE = { road: '1', rail: '2', air: '3', ship: '4' };
const ddmmyyyy = (d) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; };

/** Value of the goods on the document, as the rule counts it (with tax). */
const valueOf = (doc) => Number(doc.totals?.grand ?? doc.totalAmount ?? 0) || 0;
const needed = (doc) => valueOf(doc) > LIMIT;

function readDetails(b = {}) {
  const vehicleNo = String(b.vehicleNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const mode = ['road', 'rail', 'air', 'ship'].includes(b.mode) ? b.mode : 'road';
  const distanceKm = Math.max(0, Math.round(Number(b.distanceKm) || 0));
  const transporterId = String(b.transporterId || '').toUpperCase().trim().slice(0, 15);
  const transporterName = String(b.transporterName || '').trim().slice(0, 100);
  const transDocNo = String(b.transDocNo || '').trim().slice(0, 15);
  if (mode === 'road' && !vehicleNo && !transporterId) throw new ErrorHandler('Give the vehicle number, or the transporter\'s GSTIN / ID when they will add Part B', 400);
  if (vehicleNo && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(vehicleNo)) throw new ErrorHandler(`Vehicle number ${vehicleNo} is not in the RTO form (e.g. TN39BX1234)`, 400);
  return { vehicleNo, mode, distanceKm, transporterId, transporterName, transDocNo };
}

/** The "generate e-way bill by IRN" request. */
function payload(inv, d) {
  return {
    Irn: inv.einvoice?.irn || '',
    Distance: d.distanceKm || 0,
    TransMode: MODE[d.mode] || '1',
    TransId: d.transporterId || '',
    TransName: d.transporterName || '',
    TransDocNo: d.transDocNo || '',
    TransDocDt: d.transDocNo ? ddmmyyyy(inv.invoiceDate) : '',
    VehNo: d.vehicleNo || '',
    VehType: 'R',
  };
}

const stamp = (doc, { number, validUpto, generatedAt, provider }, d) => {
  doc.ewaybill = {
    status: 'generated', number: String(number), generatedAt: generatedAt || new Date(), validUpto: validUpto || undefined,
    vehicleNo: d.vehicleNo, transporterId: d.transporterId, transporterName: d.transporterName, transDocNo: d.transDocNo, distanceKm: d.distanceKm, mode: d.mode, provider,
  };
};

async function generate(inv, body) {
  if (inv.ewaybill?.status === 'generated') throw new ErrorHandler(`Already generated — e-way bill ${inv.ewaybill.number}`, 409);
  if (!inv.einvoice?.irn) throw new ErrorHandler('Register the IRN first: the e-way bill is generated from it', 409);
  const d = readDetails(body);
  const provider = await getProvider();
  if (typeof provider.ewaybill !== 'function') throw Object.assign(new ErrorHandler('The connected provider cannot generate e-way bills; paste the number from the portal', 409), { code: 'EWB_NOT_SUPPORTED' });
  const r = await provider.ewaybill(payload(inv, d), { invoice: inv });
  stamp(inv, { ...r, provider: provider.name }, d);
  return d;
}

function paste(doc, body) {
  if (doc.ewaybill?.status === 'generated') throw new ErrorHandler(`Already recorded — e-way bill ${doc.ewaybill.number}`, 409);
  const number = String(body?.number || '').replace(/\D/g, '');
  if (number.length !== 12) throw new ErrorHandler('The e-way bill number is 12 digits, as on the portal', 400);
  const d = readDetails({ ...body, vehicleNo: body?.vehicleNo || 'TRANSPORTER', transporterId: body?.transporterId || (body?.vehicleNo ? '' : 'PASTED') });
  if (d.vehicleNo === 'TRANSPORTER') d.vehicleNo = '';
  if (d.transporterId === 'PASTED') d.transporterId = '';
  const validUpto = body?.validUpto ? new Date(body.validUpto) : undefined;
  if (validUpto && Number.isNaN(validUpto.getTime())) throw new ErrorHandler('validUpto is not a date', 400);
  stamp(doc, { number, validUpto, generatedAt: new Date(), provider: 'manual' }, d);
  return d;
}

module.exports = { LIMIT, needed, valueOf, readDetails, payload, generate, paste };

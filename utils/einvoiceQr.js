'use strict';
// ═════════════════════════════════════════════════════════════════
//  A SUPPLIER'S E-INVOICE QR CODE
//
//  A supplier above the e-invoicing limit registers each invoice with
//  the GST portal (an IRP), which signs it. The printed invoice carries
//  that signed token as a QR code: the seller's and buyer's GSTINs, the
//  invoice number, date and total, the item count, the main HSN, the IRN
//  and when it was registered. Those figures are the portal's, not a
//  reading of the paper, so they win over what the bill reader saw.
//
//    parseSignedQr(text) → null when the text is not one, else
//      { sellerGstin, buyerGstin, docNo, docType, docDate: 'YYYY-MM-DD'|null,
//        value, itemCount, mainHsn, irn, irnDate, issuer,
//        signature: 'verified' | 'unchecked', signatureNote }
//
//  The token is a JWT signed with the IRP's RSA key (RS256). The keys are
//  not shipped: put the public keys or certificates the IRPs publish in
//  config/einvoice/ (PEM, one per file) and a code one of them signed
//  reads 'verified'. Without a matching key it reads 'unchecked' — never
//  "forged": a portal whose key is not installed signs genuine invoices
//  too. The checks that need no key still run (the buyer must be us, the
//  seller the supplier on file), in applyToRead below.
// ═════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_DIR = process.env.EINVOICE_KEY_DIR || path.join(__dirname, '..', 'config', 'einvoice');
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

let keys = null;
/** The IRPs' public keys installed on this server (read once). */
function installedKeys() {
  if (keys) return keys;
  keys = [];
  let files = [];
  try { files = fs.readdirSync(KEY_DIR).filter((f) => /\.(pem|crt|cer)$/i.test(f)); } catch (_) { files = []; }
  for (const f of files) {
    try {
      const pem = fs.readFileSync(path.join(KEY_DIR, f), 'utf8');
      let key = null;
      try { key = new crypto.X509Certificate(pem).publicKey; } catch (_) { key = crypto.createPublicKey(pem); }
      keys.push({ name: f, key });
    } catch (err) {
      console.warn(`[einvoice-qr] ${f} is not a public key or certificate: ${err.message}`);
    }
  }
  return keys;
}
/** For tests: forget the keys read, or use these instead. */
function setKeys(list) { keys = list; }

const json = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
const fromB64 = (s) => { try { return Buffer.from(String(s), 'base64url'); } catch (_) { return null; } };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);

/** "04/07/2026" (as the portal writes it) → "2026-07-04". */
function isoDate(v) {
  const m = str(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1 ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseSignedQr(text) {
  const t = String(text || '').trim();
  const parts = t.split('.');
  if (parts.length !== 3 || t.length < 100 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  const header = json(fromB64(parts[0])?.toString('utf8'));
  const payload = json(fromB64(parts[1])?.toString('utf8'));
  if (!header || !payload) return null;
  const data = typeof payload.data === 'string' ? json(payload.data) : payload.data;
  if (!data || typeof data !== 'object' || !(data.Irn || data.SellerGstin)) return null;
  const irn = str(data.Irn, 64).toLowerCase();
  const out = {
    sellerGstin: GSTIN.test(str(data.SellerGstin).toUpperCase()) ? str(data.SellerGstin).toUpperCase() : '',
    buyerGstin: str(data.BuyerGstin).toUpperCase(),
    docNo: str(data.DocNo, 40),
    docType: str(data.DocTyp, 8).toUpperCase(),
    docDate: isoDate(data.DocDt),
    value: Number.isFinite(Number(data.TotInvVal)) ? Number(data.TotInvVal) : null,
    itemCount: Number.isFinite(Number(data.ItemCnt)) ? Number(data.ItemCnt) : null,
    mainHsn: str(data.MainHsnCode, 8),
    irn: /^[0-9a-f]{64}$/.test(irn) ? irn : '',
    irnDate: str(data.IrnDt, 30),
    issuer: str(payload.iss, 40),
    signature: 'unchecked',
    signatureNote: '',
  };
  const installed = installedKeys();
  if (!installed.length) {
    out.signatureNote = 'No e-invoice portal key is installed on this server';
  } else if (String(header.alg || '').toUpperCase() !== 'RS256') {
    out.signatureNote = `Signed with ${str(header.alg, 10) || 'no algorithm'}, not RS256`;
  } else {
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = fromB64(parts[2]);
    const by = installed.find((k) => { try { return crypto.verify('RSA-SHA256', signed, k.key, sig); } catch (_) { return false; } });
    if (by) { out.signature = 'verified'; out.signatureNote = `Signed by the key in ${by.name}`; } else out.signatureNote = 'None of the installed portal keys signed it';
  }
  return out;
}

const TYPES = { INV: 'invoice', CRN: 'credit note', DBN: 'debit note' };

/**
 * What the code says, laid over what the reader saw: the GSTIN, number,
 * date and total come from the code. Returns the read to use and the
 * notes for the person: `danger` when the code is for another buyer or
 * is not an invoice.
 */
function applyToRead(read, qr, { ourGstin } = {}) {
  if (!read || !qr) return { read, notes: [] };
  const notes = [];
  const next = { ...read, totals: { ...(read.totals || {}) } };
  const ours = String(ourGstin || '').toUpperCase();
  if (ours && qr.buyerGstin && qr.buyerGstin !== ours) {
    notes.push({ code: 'QR_BUYER', severity: 'danger', message: `The e-invoice was issued to GSTIN ${qr.buyerGstin}, not ours (${ours})` });
  }
  if (qr.docType && qr.docType !== 'INV') {
    notes.push({ code: 'QR_TYPE', severity: 'danger', message: `The e-invoice code is for a ${TYPES[qr.docType] || qr.docType}, not an invoice` });
  }
  if (qr.sellerGstin) {
    if (read.supplierGstin && read.supplierGstin !== qr.sellerGstin) notes.push({ code: 'QR_GSTIN', severity: 'warning', message: `The GSTIN was read as ${read.supplierGstin}; the code says ${qr.sellerGstin}` });
    next.supplierGstin = qr.sellerGstin;
  }
  if (qr.docNo) {
    if (read.billNo && read.billNo !== qr.docNo) notes.push({ code: 'QR_NUMBER', severity: 'warning', message: `The bill number was read as ${read.billNo}; the code says ${qr.docNo}` });
    next.billNo = qr.docNo;
  }
  if (qr.docDate) {
    if (read.billDate && read.billDate !== qr.docDate) notes.push({ code: 'QR_DATE', severity: 'warning', message: `The date was read as ${read.billDate}; the code says ${qr.docDate}` });
    next.billDate = qr.docDate;
  }
  if (qr.value != null) {
    const printed = read.totals?.grand;
    if (printed != null && Math.abs(Number(printed) - qr.value) > 1) notes.push({ code: 'QR_TOTAL', severity: 'warning', message: `The total was read as ${printed}; the code says ${qr.value}` });
    next.totals.grand = qr.value;
  }
  return { read: next, notes };
}

module.exports = { parseSignedQr, applyToRead, installedKeys, setKeys, isoDate, KEY_DIR };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BILL'S E-INVOICE QR, FOUND AND LAID OVER WHAT WAS READ
//
//  The same for a bill scanned at the desk and one from the bills
//  mailbox: the code the browser already found in the photo is taken
//  first (it is read again here, never trusted as sent); else each file
//  is searched (utils/qrImage.js). The figures the GST portal signed —
//  the supplier's GSTIN, the bill number, date and total — replace what
//  the bill reader saw (utils/einvoiceQr.js applyToRead).
// ══════════════════════════════════════════════════════════════════
const { qrTexts } = require('../utils/qrImage');
const { parseSignedQr, applyToRead } = require('../utils/einvoiceQr');
const { getDocumentSettings } = require('./documentSettings');

/** { qr, text } for the first e-invoice code found, or null. */
async function findEinvoice(files, given) {
  const sent = parseSignedQr(given);
  if (sent) return { qr: sent, text: String(given).trim() };
  for (const f of files || []) {
    for (const t of await qrTexts({ buffer: f.buffer, mimetype: f.mimetype })) {
      const qr = parseSignedQr(t);
      if (qr) return { qr, text: t };
    }
  }
  return null;
}

/** The read with the code's figures, and what the person is told about it. */
async function withEinvoice(read, found) {
  if (!found || !read || read.problem) return { read, einvoice: null, einvoiceQr: '' };
  const ourGstin = (await getDocumentSettings()).gstin || '';
  const applied = applyToRead(read, found.qr, { ourGstin });
  return { read: applied.read, einvoice: { ...found.qr, notes: applied.notes }, einvoiceQr: found.text };
}

module.exports = { findEinvoice, withEinvoice };

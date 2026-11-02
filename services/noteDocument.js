'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CREDIT OR DEBIT NOTE AS A GST DOCUMENT
//
//  The note dressed as the invoice-shaped object the invoice PDF and
//  the e-invoice builder read: our details and the party's, its own
//  lines, the document it adjusts named on it (and, for the portal,
//  under PrecDocDtls), titled CREDIT NOTE / DEBIT NOTE.
//
//  To a customer, the note is an e-invoice (CRN / DBN) when the buyer
//  is registered. A note we send a supplier is a commercial document:
//  their own credit note is what goes on their GST return.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Supplier = require('../models/Supplier');
const { getDocumentSettings } = require('./documentSettings');
const { stateName, stateCodeFromGstin, amountInWords } = require('./gst');

const ddmmyyyy = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()}`;
};

async function asInvoice(note) {
  const settings = await getDocumentSettings();
  const { sellerFrom } = require('../api/invoice');
  let seller = sellerFrom(settings);
  let buyer;
  let against = null;
  if (note.against?.docType === 'Invoice') {
    against = await Invoice.findById(note.against.doc).select('invoiceNumber invoiceDate seller buyer placeOfSupply customerPo orderNo').lean();
    // The invoice's own snapshot of both parties, as they stood.
    if (against?.seller?.gstin) seller = against.seller;
    buyer = against?.buyer || { name: note.partyName, gstin: note.partyGstin };
  } else {
    against = await SupplierBill.findById(note.against?.doc).select('billNo supplierBillNo billDate supplierStateCode').lean();
    const s = note.supplier ? await Supplier.findById(note.supplier).select('name gstin address phoneNumber email').lean() : null;
    buyer = {
      name: s?.name || note.partyName, gstin: s?.gstin || note.partyGstin || '', address: s?.address || '',
      stateCode: against?.supplierStateCode || stateCodeFromGstin(s?.gstin || note.partyGstin), phone: s?.phoneNumber || '', email: s?.email || '',
    };
  }
  const toCustomer = note.partyType === 'customer';
  const pos = toCustomer ? (against?.placeOfSupply || buyer.stateCode) : (seller.stateCode || '');
  const originalNo = toCustomer ? against?.invoiceNumber || note.against?.docNo : against?.supplierBillNo || note.against?.docNo;
  const originalDate = toCustomer ? against?.invoiceDate : against?.billDate;
  return {
    docTitle: note.kind === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE',
    einvoiceType: note.kind === 'credit' ? 'CRN' : 'DBN',
    hideUpi: !(note.kind === 'debit' && toCustomer),
    invoiceNumber: note.noteNo,
    invoiceDate: note.date,
    status: note.status === 'cancelled' ? 'cancelled' : 'issued',
    seller, buyer,
    supplyType: note.supplyType,
    placeOfSupply: pos,
    precedingDoc: originalNo ? { no: originalNo, date: originalDate || note.date } : null,
    lines: (note.lines || []).map((l) => ({ name: l.description, hsn: l.hsn, unit: l.unit, quantity: l.quantity, rate: l.rate, taxable: l.taxable, gstPercent: l.gstPercent, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount })),
    totals: note.totals,
    amountInWords: amountInWords(note.totals?.grand || 0),
    notes: [note.reason, note.notes].filter(Boolean).join(' — '),
    einvoice: note.einvoice || {},
    detailRows: {
      left: [
        ['#', note.noteNo],
        ['Date', ddmmyyyy(note.date)],
        [toCustomer ? 'Against invoice' : 'Against bill', originalNo || '—'],
        ['Dated', ddmmyyyy(originalDate)],
      ],
      right: [
        ['Place Of Supply', pos ? `${stateName(pos)} (${pos})` : '—'],
        ['Reason', note.reason || '—'],
        ['Tax', note.supplyType === 'inter' ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'],
        [toCustomer ? 'Order' : 'Their note no.', toCustomer ? (against?.orderNo != null ? `#${against.orderNo}` : '—') : note.partyNoteNo || '—'],
      ],
    },
  };
}

module.exports = { asInvoice };

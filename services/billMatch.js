'use strict';
// ══════════════════════════════════════════════════════════════════
//  A READ BILL, MATCHED TO THE BOOKS
//
//  Who the supplier is on file — the GSTIN settles it; a name is a guess
//  to confirm — whether this bill number from them is entered already,
//  and their purchase orders with receipts still to bill. The same for a
//  bill scanned at the desk (POST /accounts/scan) and one that came to
//  the bills mailbox (services/billMailbox.js). Never the model's call.
// ══════════════════════════════════════════════════════════════════

const Supplier = require('../models/Supplier');
const SupplierBill = require('../models/SupplierBill');
const PurchaseOrder = require('../models/PurchaseOrder');
const MaterialInward = require('../models/MaterialInward');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function matchRead(read) {
  let supplier = null;
  let matchedBy = null;
  if (read?.supplierGstin) {
    supplier = await Supplier.findOne({ gstin: read.supplierGstin }).select('name gstin email').lean();
    if (supplier) matchedBy = 'gstin';
  }
  if (!supplier && read?.supplierName) {
    const words = read.supplierName.split(/\s+/).filter((w) => w.length >= 3).slice(0, 3);
    if (words.length) {
      const re = new RegExp(words.map((w) => `(?=.*${escapeRegex(w)})`).join(''), 'i');
      supplier = await Supplier.findOne({ name: re }).select('name gstin email').lean();
      if (supplier) matchedBy = 'name';
    }
  }
  const already = read?.billNo && supplier
    ? await SupplierBill.findOne({ supplier: supplier._id, supplierBillNo: read.billNo, status: { $ne: 'cancelled' } }).select('billNo').lean()
    : null;
  const purchaseOrders = [];
  if (supplier) {
    const pos = await PurchaseOrder.find({ supplier: supplier._id, status: { $ne: 'Cancelled' } }).select('poNo date status').sort({ date: -1 }).limit(10).lean();
    const billed = new Set((await SupplierBill.find({ purchaseOrder: { $in: pos.map((p) => p._id) }, status: { $ne: 'cancelled' } }).select('inwards').lean()).flatMap((b) => (b.inwards || []).map(String)));
    for (const po of pos) {
      const inwards = await MaterialInward.find({ purchaseOrder: po._id }).select('quantity').lean();
      const unbilled = inwards.filter((i) => !billed.has(String(i._id)));
      purchaseOrders.push({ _id: po._id, poNo: po.poNo, date: po.date, status: po.status, receipts: inwards.length, unbilledReceipts: unbilled.length });
    }
  }
  return {
    supplier: supplier ? { _id: supplier._id, name: supplier.name, gstin: supplier.gstin, matchedBy } : null,
    supplierEmail: supplier?.email || '',
    alreadyEntered: already ? already.billNo : null,
    purchaseOrders,
  };
}

module.exports = { matchRead };

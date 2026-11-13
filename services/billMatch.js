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

// ══════════════════════════════════════════════════════════════════
//  A PO'S UNBILLED RECEIPTS, AS BILL LINES
//
//  One line per material across the receipts no bill has taken yet, at
//  the PO price: what a bill against the PO would hold. The bill form's
//  PO picker shows these (GET /accounts/bills/po-info), and a scanned
//  bill's lines are matched against them (matchReceipts below).
// ══════════════════════════════════════════════════════════════════
async function poBillLines(poOrId, { defaultGst } = {}) {
  const po = poOrId && poOrId.items ? poOrId
    : await PurchaseOrder.findById(poOrId).populate('supplier', 'name gstin address').populate('items.rawMaterial', 'name unit hsn').lean();
  if (!po) return null;
  const inwards = await MaterialInward.find({ purchaseOrder: po._id }).populate('rawMaterial', 'name unit').sort({ inwardDate: 1 }).lean();
  const billed = await SupplierBill.find({ purchaseOrder: po._id, status: { $ne: 'cancelled' } }).select('billNo inwards supplierBillNo totals').lean();
  const onBill = new Map();
  for (const b of billed) for (const i of b.inwards || []) onBill.set(String(i), b.billNo);
  let gst = defaultGst;
  if (gst == null) gst = (await require('./documentSettings').getDocumentSettings()).invoice?.defaultGstPercent ?? 5;
  const price = new Map((po.items || []).map((it) => [String(it.rawMaterial?._id || it.rawMaterial), Number(it.price) || 0]));
  const free = inwards.filter((i) => !onBill.has(String(i._id)));
  const lines = new Map();
  for (const i of free) {
    const key = String(i.rawMaterial?._id || i.rawMaterial);
    const row = lines.get(key) || { rawMaterial: key, description: i.rawMaterial?.name || 'Material', unit: i.rawMaterial?.unit || 'kg', quantity: 0, rate: price.get(key) || i.unitPrice || 0, gstPercent: gst, hsn: '', inwards: [], receipts: [] };
    row.quantity = Math.round((row.quantity + (i.quantity || 0)) * 1000) / 1000;
    row.inwards.push(String(i._id));
    row.receipts.push({ _id: String(i._id), quantity: Number(i.quantity) || 0 });
    lines.set(key, row);
  }
  return { po, inwards, billed, onBill, lines: [...lines.values()] };
}

// ══════════════════════════════════════════════════════════════════
//  A SCANNED BILL'S LINES, MATCHED TO WHAT WAS RECEIVED
//
//  A bill photographed against a purchase order used to keep the lines
//  the reader saw: no material on them and none of the PO's receipts
//  taken, so those receipts still read "not billed" and could be billed
//  again. Each read line is set against the unbilled receipts of the
//  supplier's POs: the material's name in the line's description, the
//  quantity against the receipts (all of them, one, or the first few in
//  the order they came), and the rate against the PO price. The PO whose
//  receipts the bill fits best is the one proposed.
//
//  This is arithmetic and word matching on our own records, not the
//  model's call. A line it cannot place (freight, a loading charge) is
//  left as read; the person sees which lines took which receipts.
// ══════════════════════════════════════════════════════════════════
const QTY_TOLERANCE = 0.01;   // 1%: a supplier bills the weight on their challan
const RATE_TOLERANCE = 0.05;  // 5% here only to help the pairing; the bill's own variance check is the rule

/**
 * The words and numbers of a description: "70D/24F" also as "70d", "24f",
 * "70" and "24", and "70 denier" as "70d".
 */
function wordsOf(s) {
  const out = new Set();
  const text = String(s || '').toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(?:denier|den)\b/g, '$1d')
    .replace(/'s\b/g, 's')
    .replace(/[^a-z0-9/.]+/g, ' ');
  for (const t of text.split(/\s+/)) {
    if (!t) continue;
    const parts = [t, ...(t.includes('/') ? t.split('/') : [])];
    for (const p of parts) if (p && (p.length >= 2 || /\d/.test(p))) out.add(p);
    for (const n of t.match(/\d+(?:\.\d+)?/g) || []) out.add(n);
  }
  return out;
}

/** How much of the material's name the bill line carries, 0 to 1. */
function nameScore(description, material) {
  const m = wordsOf(material);
  if (!m.size) return 0;
  const d = wordsOf(description);
  let hit = 0;
  for (const w of m) if (d.has(w)) hit += 1;
  return hit / m.size;
}

const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * QTY_TOLERANCE, 0.01);

/** Which receipts a billed quantity covers: all, one, or the first few. */
function pickReceipts(quantity, receipts) {
  const q = Number(quantity);
  if (!(q > 0) || !receipts.length) return { ids: [], quantity: 0, exact: false };
  const total = receipts.reduce((s, r) => s + r.quantity, 0);
  if (near(q, total)) return { ids: receipts.map((r) => r._id), quantity: total, exact: true };
  const one = receipts.find((r) => near(q, r.quantity));
  if (one) return { ids: [one._id], quantity: one.quantity, exact: true };
  let sum = 0;
  for (let k = 0; k < receipts.length; k++) {
    sum += receipts[k].quantity;
    if (near(q, sum)) return { ids: receipts.slice(0, k + 1).map((r) => r._id), quantity: sum, exact: true };
  }
  return { ids: [], quantity: 0, exact: false };
}

/** The best pairing of read lines with one PO's lines. */
function pairLines(readLines, poLines) {
  const pairs = [];
  readLines.forEach((l, i) => {
    poLines.forEach((p, j) => {
      const name = nameScore(l.description, p.description);
      const pick = pickReceipts(l.quantity, p.receipts);
      const rateOk = p.rate > 0 && l.rate != null && Math.abs(Number(l.rate) - p.rate) / p.rate <= RATE_TOLERANCE;
      // One bill line, one material on the PO: the quantity alone places it.
      const only = readLines.length === 1 && poLines.length === 1;
      if (name < 0.34 && !(pick.exact && (rateOk || only))) return;
      pairs.push({ i, j, pick, rateOk, name, score: name * 0.6 + (pick.exact ? 0.3 : 0) + (rateOk ? 0.1 : 0) });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedRead = new Set(); const usedPo = new Set(); const taken = [];
  for (const p of pairs) {
    if (usedRead.has(p.i) || usedPo.has(p.j)) continue;
    usedRead.add(p.i); usedPo.add(p.j); taken.push(p);
  }
  return taken;
}

/**
 * The read bill's lines placed on the supplier's unbilled receipts.
 * @param read             what utils/billOcr.js read
 * @param purchaseOrders   matchRead's list: { _id, poNo, unbilledReceipts }
 * @returns null when nothing could be placed, else
 *   { purchaseOrder: { _id, poNo }, lines: [{ index, rawMaterial, material, inwards,
 *     quantityReceived, poRate, quantityMatches, rateMatches }], unmatched: [index],
 *     receiptsLeft: [{ material, quantity, unit }] }
 */
async function matchReceipts(read, purchaseOrders) {
  const readLines = (read?.lines || []).map((l, index) => ({ ...l, index })).filter((l) => l.description);
  const candidates = (purchaseOrders || []).filter((p) => p.unbilledReceipts > 0).slice(0, 5);
  if (!readLines.length || !candidates.length) return null;
  let best = null;
  for (const c of candidates) {
    const info = await poBillLines(c._id);
    if (!info || !info.lines.length) continue;
    const taken = pairLines(readLines, info.lines);
    if (!taken.length) continue;
    const score = taken.reduce((s, p) => s + p.score, 0);
    if (!best || score > best.score + 1e-9) best = { score, taken, info };
  }
  if (!best) return null;
  const { taken, info } = best;
  const usedPo = new Set(taken.map((p) => p.j));
  const lines = taken.sort((a, b) => a.i - b.i).map((p) => {
    const poLine = info.lines[p.j];
    return {
      index: readLines[p.i].index,
      rawMaterial: poLine.rawMaterial,
      material: poLine.description,
      inwards: p.pick.ids,
      quantityReceived: p.pick.exact ? p.pick.quantity : poLine.quantity,
      poRate: poLine.rate,
      quantityMatches: p.pick.exact,
      rateMatches: p.rateOk,
    };
  });
  const placed = new Set(lines.map((l) => l.index));
  return {
    purchaseOrder: { _id: info.po._id, poNo: info.po.poNo },
    lines,
    unmatched: readLines.filter((l) => !placed.has(l.index)).map((l) => l.index),
    receiptsLeft: info.lines.filter((_, j) => !usedPo.has(j)).map((l) => ({ material: l.description, quantity: l.quantity, unit: l.unit })),
  };
}

module.exports = { matchRead, poBillLines, matchReceipts, nameScore, pickReceipts, pairLines };

'use strict';
// ══════════════════════════════════════════════════════════════════
//  MAILED BILLS READY TO ENTER IN ONE CLICK
//
//  Every bill from the bills mailbox waited for someone to open it,
//  check it and save it, even one that agreed with everything. A mailed
//  bill is "ready" when nothing is left for a person to decide:
//
//    • a tax invoice (a receipt is an expense, not a bill)
//    • the supplier found by GSTIN, not guessed by name
//    • its number and date read, its number not entered before, nor its IRN
//    • the e-invoice code, when there is one, issued to us for an invoice
//    • every line read in full and the figures adding up to the total
//    • every line on a goods receipt of one PO, its quantity what was received
//    • the rates within the PO tolerance (the bill's own variance check)
//    • no warning the bill form would show in red (the same amount twice,
//      a GSTIN not the supplier's, input credit too late)
//    • its date in an open period, and the read at least 60% sure
//
//  readiness(item, ctx) → { ready, why: [sentence], body, summary }
//  `body` is what POST /accounts/bills takes, with a request id, so a
//  ready bill is entered by the same route, checks and transaction as
//  one typed in, and entering it twice enters it once. `why` says, for
//  a bill that is not ready, what a person has to look at.
// ══════════════════════════════════════════════════════════════════
const SupplierBill = require('../models/SupplierBill');
const billMatch = require('./billMatch');
const billChecks = require('./billChecks');
const billQr = require('./billQr');
const { checkRead } = require('../utils/billArithmetic');
const { parseSignedQr } = require('../utils/einvoiceQr');

const MIN_CONFIDENCE = 0.6;
const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));

/** What every bill in one listing shares: our state, the tolerance, the lock. */
async function context() {
  const { sellerStateCode } = require('../api/accountsCommon');
  const booksLock = require('./booksLock');
  const settings = await booksLock.getSettings();
  return {
    ourStateCode: await sellerStateCode(),
    tolerance: settings?.bills?.rateVariancePercent ?? 2,
    lockDate: settings?.lockDate || null,
  };
}

async function readiness(item, ctx) {
  const why = [];
  const out = (body = null, summary = null) => ({ ready: !why.length && !!body, why, body: why.length ? null : body, summary });
  if (!item || item.status !== 'new' || !item.read) { why.push('Not waiting to be entered'); return out(); }

  const qrText = item.einvoiceQr || '';
  const qr = await billQr.withEinvoice(item.read, qrText ? { qr: parseSignedQr(qrText), text: qrText } : null);
  const read = qr.read;
  for (const n of qr.einvoice?.notes || []) if (n.severity === 'danger') why.push(n.message);
  if (read.kind !== 'bill') why.push('A receipt, not a tax invoice: enter it as an expense');
  if ((read.confidence ?? 0) < MIN_CONFIDENCE) why.push(`The reader was only ${Math.round((read.confidence || 0) * 100)}% sure`);
  if (!read.billNo) why.push('No bill number was read');
  if (!read.billDate) why.push('No bill date was read');
  if (read.billDate && ctx.lockDate && new Date(`${read.billDate}T00:00:00Z`) <= new Date(ctx.lockDate)) why.push(`The books are closed for ${read.billDate}`);

  const match = await billMatch.matchRead(read);
  if (!match.supplier) why.push('No supplier on file has this GSTIN');
  else if (match.supplier.matchedBy !== 'gstin') why.push('The supplier was matched by name only');
  if (match.alreadyEntered) why.push(`Already entered as ${match.alreadyEntered}`);
  if (qr.einvoice?.irn) {
    const same = await SupplierBill.findOne({ 'einvoice.irn': qr.einvoice.irn, status: { $ne: 'cancelled' } }).select('billNo').lean();
    if (same) why.push(`This e-invoice is already entered as ${same.billNo}`);
  }

  // Every figure read, and adding up to the total.
  const lines = read.lines || [];
  if (!lines.length || lines.some((l) => !has(l.quantity) || !has(l.rate) || !has(l.gstPercent)) || !has(read.totals?.grand)) {
    why.push('Some figures were not read');
  } else {
    const checks = checkRead(read, { ourStateCode: ctx.ourStateCode });
    for (const x of checks.issues) if (x.severity === 'danger') why.push(x.message);
  }

  // Every line on a goods receipt, its quantity what came in.
  const rm = match.supplier ? await billMatch.matchReceipts(read, match.purchaseOrders) : null;
  if (!rm) {
    if (match.supplier) why.push('Nothing on a purchase order to match it to');
  } else {
    for (const i of rm.unmatched) why.push(`"${lines[i]?.description || `Line ${i + 1}`}" is not on a goods receipt`);
    for (const l of rm.lines) if (!l.quantityMatches) why.push(`"${lines[l.index]?.description}" is ${lines[l.index]?.quantity}; ${l.quantityReceived} was received`);
  }
  if (why.length || !rm) return out();

  const placed = new Map(rm.lines.map((l) => [l.index, l]));
  const billLines = lines.map((l, i) => ({
    rawMaterial: placed.get(i)?.rawMaterial, description: l.description, hsn: l.hsn || '', unit: l.unit || '',
    quantity: Number(l.quantity), rate: Number(l.rate), gstPercent: Number(l.gstPercent),
  }));
  const inwards = rm.lines.flatMap((l) => l.inwards);
  const variance = await billChecks.variance({ lines: billLines, po: rm.purchaseOrder._id, inwards, tolerancePercent: ctx.tolerance });
  if (variance.lines.length) why.push(`₹${variance.total.toFixed(2)} off the PO price or the receipts`);

  // The warnings the bill form shows in red.
  const insights = require('./accountsInsights');
  const flags = await insights.anomalies('bill', { supplier: match.supplier._id, supplierBillNo: read.billNo, billDate: read.billDate, lines: billLines, scannedGstin: read.supplierGstin, kind: 'goods' }, null);
  for (const f of flags) if (f.severity === 'danger') why.push(f.message);
  if (why.length) return out();

  const body = {
    supplier: String(match.supplier._id), supplierBillNo: read.billNo, billDate: read.billDate,
    purchaseOrder: String(rm.purchaseOrder._id), inwards, kind: 'goods', lines: billLines,
    itcEligible: true, tds: { applicable: false }, source: 'scan',
    ...(item.aiSuggestion ? { aiSuggestion: String(item.aiSuggestion) } : {}),
    inboxBill: String(item._id), ...(qr.einvoiceQr ? { einvoiceQr: qr.einvoiceQr } : {}),
    requestId: `inbox-bill:${item._id}`,
  };
  const summary = {
    supplierName: match.supplier.name, billNo: read.billNo, billDate: read.billDate, poNo: rm.purchaseOrder.poNo,
    receipts: inwards.length, grand: Number(read.totals.grand), einvoice: !!qr.einvoice,
  };
  return out(body, summary);
}

/** Readiness for many, a few at a time. */
async function readinessAll(items, ctx) {
  const c = ctx || await context();
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await readiness(items[i], c); } catch (err) {
        console.warn(`[bill-ready] working out whether ${items[i]?._id} is ready failed: ${err.message}`);
        results[i] = { ready: false, why: ['Could not be checked just now'], body: null, summary: null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return results;
}

module.exports = { readiness, readinessAll, context, MIN_CONFIDENCE };

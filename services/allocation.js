'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A RECEIPT OR PAYMENT WILL SETTLE, WORKED OUT ONCE
//
//  Money goes to a party's oldest open documents first; on a payment,
//  TDS comes off each bill's value net of GST, so settling a bill takes
//  less cash than the bill is for. That arithmetic was written three
//  times: here on the server (which has the last word when a voucher is
//  posted), in the web form, and in the phone app — which gave up on
//  bills carrying TDS and left them to the web.
//
//    taxOn()    the TDS on one allocation: the rate and section it
//               falls under, the value it is worked on, the tax.
//               createVoucher uses this same function, so what is
//               proposed is what will be posted.
//    propose()  the allocations for a party: either the documents
//               ticked (each for what it still owes, or the amount
//               given), or — given only the money — the oldest
//               documents first until it is used up; with the TDS on
//               each, the cash each takes, and the totals.
//
//  POST /accounts/payments/propose (api/accountsVouchers.js).
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');
const outstanding = require('./outstanding');
const { isId, r2 } = require('./accountsHelpers');

/**
 * The TDS on one allocation of `gross`.
 * @param tdsRate     the voucher's own rate (0 = none named: a bill then carries its own)
 * @param tdsSection  the voucher's own section
 * @param docTds      the document's { applicable, rate, section }, when it is a supplier bill
 * @param ratio       the share of the document that is value net of GST (1 for an opening balance)
 * @returns {{ rate, section, ownSection, tdsBase, tds }}
 */
function taxOn({ kind, docType, gross, tdsRate = 0, tdsSection = '', docTds = null, ratio = 1 }) {
  let rate = 0;
  if (kind === 'payment') rate = docType === 'SupplierBill' ? (tdsRate || (docTds?.applicable ? Number(docTds.rate) || 0 : 0)) : tdsRate;
  // The section it falls under: the voucher's when the voucher names the rate, else the bill's own.
  const ownSection = kind === 'payment' && docType === 'SupplierBill' && !tdsRate && rate > 0 ? String(docTds?.section || '').trim().slice(0, 8) : '';
  const tdsBase = rate > 0 ? r2(gross * (docType === 'OpeningBalance' ? 1 : ratio)) : 0;
  const tds = rate > 0 ? r2(tdsBase * rate / 100) : 0;
  return { rate, ownSection, section: (tdsRate ? tdsSection : ownSection) || '', tdsBase, tds };
}

/** Oldest first: by document date, then due date, then number. */
function oldestFirst(a, b) {
  const far = 8.64e15;
  const d = (a.date ? new Date(a.date).getTime() : far) - (b.date ? new Date(b.date).getTime() : far);
  if (d) return d;
  const due = (a.dueDate ? new Date(a.dueDate).getTime() : far) - (b.dueDate ? new Date(b.dueDate).getTime() : far);
  return due || String(a.docNo).localeCompare(String(b.docNo));
}

/**
 * body: { kind, partyType, party, amount?, tds?: { rate, section }, adjustments?: [{ kind, amount }],
 *         docs?: [{ doc, amount? }], skip?: [id] }
 *
 * With `docs`: those documents, each for the amount given (or all it
 * owes). Without: `amount` (and the adjustments) down the open
 * documents, oldest first, leaving out any in `skip`.
 *
 * @returns { allocations: [{ docType, doc, docNo, refNo, date, dueDate, outstanding, amount, tds, tdsBase, rate, section, cash }],
 *            totals: { gross, tds, adjustments, cashNeeded, cash, unallocated }, open }
 */
async function propose(b) {
  const kind = b.kind === 'receipt' ? 'receipt' : b.kind === 'payment' ? 'payment' : null;
  if (!kind) throw new ErrorHandler('kind must be receipt or payment', 400);
  const partyType = b.partyType;
  if (!['customer', 'supplier'].includes(partyType) || !isId(b.party)) throw new ErrorHandler('partyType and party are required', 400);
  if ((partyType === 'customer') !== (kind === 'receipt')) throw new ErrorHandler('A refund pays back credit on account — it settles no documents', 400);
  const rows = (partyType === 'customer' ? await outstanding.receivables({ customer: b.party }) : await outstanding.payables({ supplier: b.party })).sort(oldestFirst);
  const tdsRate = kind === 'payment' ? Number(b.tds?.rate) || 0 : 0;
  if (tdsRate < 0 || tdsRate > 100) throw new ErrorHandler('TDS rate must be between 0 and 100', 400);
  const tdsSection = String(b.tds?.section || '').trim().slice(0, 8);
  const adjTotal = r2((Array.isArray(b.adjustments) ? b.adjustments : []).reduce((t, a) => t + (r2(a?.amount) > 0 ? r2(a.amount) : 0), 0));

  const ratioOf = (row) => (row.docType === 'OpeningBalance' ? 1 : row.taxableRatio ?? 1);
  const line = (row, gross) => {
    const t = taxOn({ kind, docType: row.docType, gross, tdsRate, tdsSection, docTds: row.tds ? { applicable: true, ...row.tds } : null, ratio: ratioOf(row) });
    return { docType: row.docType, doc: row.id, docNo: row.docNo, refNo: row.refNo || '', date: row.date, dueDate: row.dueDate, outstanding: row.outstanding, amount: gross, tds: t.tds, tdsBase: t.tdsBase, rate: t.rate, section: t.section, cash: r2(gross - t.tds) };
  };

  let allocations = [];
  const ticked = Array.isArray(b.docs) && b.docs.length > 0;
  if (ticked) {
    const seen = new Set();
    for (const [i, d] of b.docs.entries()) {
      const row = rows.find((r) => String(r.id) === String(d?.doc));
      if (!row) throw new ErrorHandler(`Document ${i + 1} is not one of this party's open documents`, 409);
      if (seen.has(String(row.id))) throw new ErrorHandler(`Document ${i + 1}: the same document twice`, 400);
      seen.add(String(row.id));
      const gross = d.amount === undefined || d.amount === null || d.amount === '' ? row.outstanding : r2(d.amount);
      if (!(gross > 0)) throw new ErrorHandler(`${row.docNo}: amount must be more than 0`, 400);
      if (gross > row.outstanding + 0.005) throw new ErrorHandler(`${row.docNo} has only ${row.outstanding.toFixed(2)} outstanding`, 400);
      allocations.push(line(row, gross));
    }
  } else {
    const skip = new Set((Array.isArray(b.skip) ? b.skip : []).map(String));
    // The money, and what settles besides it, down the list.
    let left = r2(Math.max(0, Number(b.amount) || 0) + adjTotal);
    for (const row of rows) {
      if (left <= 0.005) break;
      if (skip.has(String(row.id))) continue;
      const full = line(row, row.outstanding);
      if (full.cash <= left + 0.005) { allocations.push(full); left = r2(left - full.cash); continue; }
      // In part: the most of it whose cash (after the TDS on that part) the money left can pay.
      const f = full.rate > 0 ? ratioOf(row) * full.rate / 100 : 0;
      let gross = Math.min(row.outstanding, r2(left / (1 - f)));
      let part = line(row, gross);
      while (part.cash > left + 0.005 && gross > 0.01) { gross = r2(gross - 0.01); part = line(row, gross); }
      if (gross > 0.005) { allocations.push(part); left = r2(left - part.cash); }
    }
  }
  const gross = r2(allocations.reduce((t, a) => t + a.amount, 0));
  const tds = r2(allocations.reduce((t, a) => t + a.tds, 0));
  const cashNeeded = r2(Math.max(0, gross - tds - adjTotal));
  const cash = b.amount === undefined || b.amount === null || b.amount === '' ? cashNeeded : r2(Math.max(0, Number(b.amount) || 0));
  return {
    kind, partyType, party: b.party, allocations,
    totals: { gross, tds, adjustments: adjTotal, cashNeeded, cash, unallocated: r2(cash + tds + adjTotal - gross) },
    open: rows.length,
  };
}

module.exports = { taxOn, propose, oldestFirst };

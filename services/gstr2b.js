'use strict';
// ══════════════════════════════════════════════════════════════════
//  GSTR-2B AGAINST THE BOOKS
//
//  Input credit may be taken only for what the supplier reported and
//  the portal shows in GSTR-2B (CGST Act s.16(2)(aa), Rule 36(4)).
//  The month's GSTR-2B JSON, as the portal downloads it, is read here
//  and each line set against the books:
//
//    matched     a bill (or our debit note) with the same supplier
//                GSTIN and number, tax within a rupee
//    mismatch    found, but the tax differs
//    notInBooks  the supplier reported it; nothing here has it
//
//  and the other way: bills of the month with credit claimed that no
//  2B line reports ("missing"): their ITC waits until the supplier
//  files. A number can be written many ways (INV/001, inv-1), so
//  numbers are compared stripped of punctuation and leading zeros, and
//  a line with the right GSTIN, tax and a date within five days is
//  taken as the same document when the number alone did not match.
// ══════════════════════════════════════════════════════════════════

const Gstr2bEntry = require('../models/Gstr2bEntry');
const SupplierBill = require('../models/SupplierBill');
const AccountNote = require('../models/AccountNote');

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** "INV/0012-A" → "INV12A": what two spellings of one number share. */
const keyOf = (no) => String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]*)0+(?=\d)/, '$1');

function readDate(v) {
  const s = String(v || '');
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The lines of a GSTR-2B JSON, whatever wrapper the portal put around docdata. */
function parse(json, period) {
  const root = json?.data?.docdata || json?.docdata || json?.data?.data?.docdata || null;
  if (!root) throw Object.assign(new Error('This is not a GSTR-2B file: no "docdata" in it. Download GSTR-2B as JSON from the GST portal (Returns → GSTR-2B → Download).'), { status: 400 });
  const sumItems = (items) => (items || []).reduce((t, it) => ({
    taxable: r2(t.taxable + (+it.txval || 0)), cgst: r2(t.cgst + (+it.cgst || 0)), sgst: r2(t.sgst + (+it.sgst || 0)), igst: r2(t.igst + (+it.igst || 0)), cess: r2(t.cess + (+it.cess || 0)),
  }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 });
  const out = [];
  const yes = (v) => String(v || '').toUpperCase() === 'Y';
  for (const s of root.b2b || []) for (const inv of s.inv || []) {
    const t = sumItems(inv.items);
    out.push({ period, kind: 'invoice', supplierGstin: s.ctin, supplierName: s.trdnm || '', number: inv.inum, key: keyOf(inv.inum), date: readDate(inv.dt || inv.idt), value: r2(inv.val), ...t, tax: r2(t.cgst + t.sgst + t.igst), reverseCharge: yes(inv.rev), itcAvailable: yes(inv.itcavl ?? 'Y'), reason: inv.rsn || '', placeOfSupply: inv.pos || '' });
  }
  for (const s of root.cdnr || []) for (const nt of s.nt || []) {
    const t = sumItems(nt.items);
    const kind = String(nt.typ || nt.nttyp || 'C').toUpperCase().startsWith('D') ? 'debitNote' : 'creditNote';
    out.push({ period, kind, supplierGstin: s.ctin, supplierName: s.trdnm || '', number: nt.ntnum, key: keyOf(nt.ntnum), date: readDate(nt.dt || nt.ntdt), value: r2(nt.val), ...t, tax: r2(t.cgst + t.sgst + t.igst), reverseCharge: yes(nt.rev), itcAvailable: yes(nt.itcavl ?? 'Y'), reason: nt.rsn || '', placeOfSupply: nt.pos || '' });
  }
  return out.filter((e) => e.supplierGstin && e.number);
}

/** Store the month's lines (replacing an earlier upload of the same month) and match them. */
async function upload({ period, json, by }) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw Object.assign(new Error('period must be YYYY-MM'), { status: 400 });
  const entries = parse(json, period);
  await Gstr2bEntry.deleteMany({ period });
  // Two lines with the same key (a supplier's numbering reused) keep the first.
  const seen = new Set();
  const unique = entries.filter((e) => { const k = `${e.supplierGstin}|${e.key}|${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (unique.length) await Gstr2bEntry.insertMany(unique.map((e) => ({ ...e, uploadedBy: by || undefined })));
  return reconcile(period);
}

/**
 * Match the month's 2B lines to the books, mark bills found and missing,
 * and return the summary.
 */
async function reconcile(period) {
  const entries = await Gstr2bEntry.find({ period }).lean();
  const [y, m] = period.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0, 23, 59, 59, 999);
  // Bills within a year of the month: a supplier may report late.
  const bills = await SupplierBill.find({ status: { $ne: 'cancelled' }, supplierGstin: { $ne: '' }, billDate: { $gte: new Date(y - 1, m - 1, 1), $lte: to } })
    .select('billNo supplierBillNo supplier supplierName supplierGstin billDate totals itc gstr2b reverseCharge').lean();
  // Our debit notes to suppliers are their credit notes in 2B.
  const notes = await AccountNote.find({ kind: 'debit', partyType: 'supplier', status: 'issued', date: { $gte: new Date(y - 1, m - 1, 1), $lte: to } }).select('noteNo partyNoteNo partyGstin date totals').lean();
  const taxOf = (t) => r2((t?.cgst || 0) + (t?.sgst || 0) + (t?.igst || 0));
  const byKey = new Map();
  for (const b of bills) byKey.set(`${String(b.supplierGstin).toUpperCase()}|${keyOf(b.supplierBillNo)}|invoice`, { docType: 'SupplierBill', doc: b });
  for (const n of notes) if (n.partyGstin && n.partyNoteNo) byKey.set(`${String(n.partyGstin).toUpperCase()}|${keyOf(n.partyNoteNo)}|creditNote`, { docType: 'AccountNote', doc: n });
  const taken = new Set();
  const matches = [];
  for (const e of entries) {
    let hit = byKey.get(`${e.supplierGstin}|${e.key}|${e.kind}`);
    let by = 'number';
    if (hit && taken.has(String(hit.doc._id))) hit = null;
    if (!hit && e.kind === 'invoice') {
      // Same GSTIN, same tax, a date within five days: the number was written differently.
      hit = bills.map((b) => ({ docType: 'SupplierBill', doc: b })).find(({ doc }) => !taken.has(String(doc._id)) && String(doc.supplierGstin).toUpperCase() === e.supplierGstin
        && Math.abs(taxOf(doc.totals) - e.tax) <= 1 && e.date && Math.abs(new Date(doc.billDate) - e.date) <= 5 * DAY) || null;
      by = 'amount';
    }
    const match = { status: 'notInBooks', docType: '', doc: undefined, docNo: '', diff: 0, by: '' };
    if (hit) {
      taken.add(String(hit.doc._id));
      const booksTax = taxOf(hit.doc.totals);
      match.docType = hit.docType; match.doc = hit.doc._id; match.docNo = hit.docType === 'SupplierBill' ? hit.doc.billNo : hit.doc.noteNo;
      match.diff = r2(booksTax - e.tax); match.by = by;
      match.status = Math.abs(match.diff) <= 1 ? 'matched' : 'mismatch';
    }
    matches.push({ entry: e, match });
    await Gstr2bEntry.updateOne({ _id: e._id }, { $set: { match } });
  }
  // The bills found: remember it on the bill. The month's bills not found: missing.
  const now = new Date();
  for (const { entry, match } of matches) {
    if (match.docType !== 'SupplierBill') continue;
    await SupplierBill.updateOne({ _id: match.doc }, { $set: { gstr2b: { status: match.status, period, entry: entry._id, diff: match.diff, note: !entry.itcAvailable ? `ITC not available in 2B: ${entry.reason || 'as reported'}` : match.status === 'mismatch' ? `Tax in books ₹${r2(taxOf(bills.find((b) => String(b._id) === String(match.doc))?.totals)).toFixed(2)}, in 2B ₹${entry.tax.toFixed(2)}` : '', at: now } } });
  }
  const monthBills = bills.filter((b) => b.billDate >= from && b.billDate <= to && b.itc?.eligible && !b.reverseCharge && !taken.has(String(b._id)));
  for (const b of monthBills) {
    // Found in an earlier month's 2B already: leave it.
    if (b.gstr2b?.status === 'matched' || b.gstr2b?.status === 'mismatch') continue;
    await SupplierBill.updateOne({ _id: b._id }, { $set: { gstr2b: { status: 'missing', period, entry: null, diff: 0, note: 'Not in GSTR-2B: the supplier has not reported it yet. ITC waits.', at: now } } });
  }
  return summary(period);
}

/** The month's position: matched, mismatched, not in books, missing from 2B, and the ITC each side carries. */
async function summary(period) {
  const entries = await Gstr2bEntry.find({ period }).sort({ supplierName: 1, date: 1 }).lean();
  const [y, m] = period.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0, 23, 59, 59, 999);
  const missing = await SupplierBill.find({ status: { $ne: 'cancelled' }, 'gstr2b.status': 'missing', 'gstr2b.period': period }).select('billNo supplierBillNo supplier supplierName supplierGstin billDate totals itc gstr2b').lean();
  const taxOf = (t) => r2((t?.cgst || 0) + (t?.sgst || 0) + (t?.igst || 0));
  const by = (st) => entries.filter((e) => e.match?.status === st);
  const itc = (rows) => r2(rows.reduce((t, e) => t + (e.itcAvailable ? e.tax : 0), 0));
  return {
    period, uploaded: entries.length > 0, uploadedAt: entries[0]?.createdAt || null, from, to,
    counts: { entries: entries.length, matched: by('matched').length, mismatch: by('mismatch').length, notInBooks: by('notInBooks').length, missing: missing.length },
    itc: {
      matched: itc(by('matched')), mismatch: itc(by('mismatch')), notInBooks: itc(by('notInBooks')),
      // What the books claim that 2B does not show: hold it.
      missing: r2(missing.reduce((t, b) => t + taxOf(b.totals), 0)),
      unavailable: r2(entries.filter((e) => !e.itcAvailable).reduce((t, e) => t + e.tax, 0)),
    },
    rows: entries.map((e) => ({ _id: e._id, kind: e.kind, supplierGstin: e.supplierGstin, supplierName: e.supplierName, number: e.number, date: e.date, value: e.value, taxable: e.taxable, tax: e.tax, cgst: e.cgst, sgst: e.sgst, igst: e.igst, itcAvailable: e.itcAvailable, reason: e.reason, match: e.match })),
    missing: missing.map((b) => ({ _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, supplierName: b.supplierName, supplierGstin: b.supplierGstin, billDate: b.billDate, tax: taxOf(b.totals), grand: b.totals?.grand || 0, note: b.gstr2b?.note || '' })),
  };
}

/** Months with a 2B uploaded, newest first. */
async function periods() {
  const rows = await Gstr2bEntry.aggregate([{ $group: { _id: '$period', n: { $sum: 1 }, at: { $max: '$createdAt' } } }, { $sort: { _id: -1 } }]);
  return rows.map((r) => ({ period: r._id, entries: r.n, uploadedAt: r.at }));
}

module.exports = { parse, upload, reconcile, summary, periods, keyOf };

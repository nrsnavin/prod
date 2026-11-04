'use strict';
// ══════════════════════════════════════════════════════════════════
//  GSTR-1 FOR A MONTH, FROM THE INVOICES AND NOTES
//
//  The outward-supplies return's tables, as the GST portal's offline
//  tool takes them:
//
//    B2B    (4)   invoices to registered customers, one by one
//    B2CL   (5)   inter-state invoices to unregistered customers over
//                 ₹1,00,000, one by one
//    B2CS   (7)   every other unregistered sale, totalled by state and rate
//    CDNR   (9B)  credit and debit notes to registered customers
//    CDNUR  (9B)  notes to unregistered customers
//    HSN    (12)  the HSN summary: quantity and value by HSN and rate
//    DOCS   (13)  the document series issued and cancelled
//
//  Plus the checks a return preparer makes before filing: an invoice
//  without the customer's GSTIN when they have one on file, a line with
//  no HSN or fewer digits than the turnover requires, a note with no
//  original invoice.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const AccountNote = require('../models/AccountNote');
const Customer = require('../models/Customer');
const { getSettings } = require('./booksLock');
const { getDocumentSettings } = require('./documentSettings');
const { uqc } = require('./einvoice');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const B2CL_LIMIT = 100000;

function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0, 23, 59, 59, 999), fp: `${String(m).padStart(2, '0')}${y}` };
}
const dmy = (d) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}`; };

/** Rate-wise items of a document, as the return wants them. */
function items(lines) {
  const by = new Map();
  for (const l of lines || []) {
    const rt = Number(l.gstPercent) || 0;
    const g = by.get(rt) || { rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    g.txval = r2(g.txval + (l.taxable || 0)); g.iamt = r2(g.iamt + (l.igst || 0)); g.camt = r2(g.camt + (l.cgst || 0)); g.samt = r2(g.samt + (l.sgst || 0));
    by.set(rt, g);
  }
  return [...by.values()].sort((a, b) => a.rt - b.rt).map((g, i) => ({ num: i + 1, itm_det: g }));
}
const posOf = (doc) => (/^\d{2}$/.test(String(doc.placeOfSupply || '')) ? doc.placeOfSupply : String(doc.buyer?.gstin || doc.partyGstin || '').slice(0, 2)) || '';

async function build(month) {
  const { from, to, fp } = monthRange(month);
  const range = { $gte: from, $lte: to };
  const [invoices, cancelled, notes, cancelledNotes, settings, docSettings] = await Promise.all([
    Invoice.find({ status: 'issued', invoiceDate: range }).select('invoiceNumber invoiceDate customer buyer supplyType placeOfSupply lines totals einvoice.irn').sort({ invoiceDate: 1, sequence: 1 }).lean(),
    Invoice.find({ status: 'cancelled', invoiceDate: range }).select('invoiceNumber').lean(),
    AccountNote.find({ status: 'issued', partyType: 'customer', date: range }).select('kind noteNo date customer partyName partyGstin against supplyType lines totals').sort({ date: 1 }).lean(),
    AccountNote.find({ status: 'cancelled', partyType: 'customer', date: range }).select('noteNo kind').lean(),
    getSettings(),
    getDocumentSettings(),
  ]);
  const hsnDigits = settings.gst?.hsnDigits || 4;
  const ourGstin = docSettings?.gstin || '';
  const ourState = ourGstin.slice(0, 2);
  // Customers on file with a GSTIN, to catch an invoice that left it off.
  const custIds = [...new Set(invoices.map((i) => String(i.customer)))];
  const customers = new Map((await Customer.find({ _id: { $in: custIds } }).select('name gstin').lean()).map((c) => [String(c._id), c]));
  const invByNo = new Map(invoices.map((i) => [i.invoiceNumber, i]));

  const checks = [];
  const b2b = new Map(); const b2cl = new Map(); const b2cs = new Map();
  for (const inv of invoices) {
    const gstin = String(inv.buyer?.gstin || '').toUpperCase();
    const pos = posOf(inv) || ourState;
    const row = { inum: inv.invoiceNumber, idt: dmy(inv.invoiceDate), val: r2(inv.totals?.grand || 0), pos, rchrg: 'N', inv_typ: 'R', itms: items(inv.lines), customer: inv.buyer?.name || '', irn: inv.einvoice?.irn || '' };
    const onFile = customers.get(String(inv.customer));
    if (!gstin && onFile?.gstin) checks.push({ level: 'error', doc: inv.invoiceNumber, text: `${onFile.name} has GSTIN ${onFile.gstin} on file but the invoice carries none: it would go as B2C` });
    for (const l of inv.lines || []) {
      const h = String(l.hsn || '').replace(/\D/g, '');
      if (!h) checks.push({ level: 'error', doc: inv.invoiceNumber, text: `"${l.name}" has no HSN` });
      else if (h.length < hsnDigits) checks.push({ level: 'warn', doc: inv.invoiceNumber, text: `"${l.name}" HSN ${h} has ${h.length} digits; ${hsnDigits} are required` });
    }
    if (gstin) {
      const g = b2b.get(gstin) || { ctin: gstin, name: inv.buyer?.name || '', inv: [] };
      g.inv.push(row); b2b.set(gstin, g);
    } else if (inv.supplyType === 'inter' && row.val > B2CL_LIMIT) {
      const g = b2cl.get(pos) || { pos, inv: [] };
      g.inv.push(row); b2cl.set(pos, g);
    } else {
      for (const it of row.itms) {
        const k = `${pos}|${it.itm_det.rt}`;
        const g = b2cs.get(k) || { sply_ty: inv.supplyType === 'inter' ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: it.itm_det.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0, count: 0 };
        g.txval = r2(g.txval + it.itm_det.txval); g.iamt = r2(g.iamt + it.itm_det.iamt); g.camt = r2(g.camt + it.itm_det.camt); g.samt = r2(g.samt + it.itm_det.samt); g.count += 1;
        b2cs.set(k, g);
      }
    }
  }

  const cdnr = new Map(); const cdnur = [];
  for (const n of notes) {
    const gstin = String(n.partyGstin || '').toUpperCase();
    const pos = posOf(n) || ourState;
    const row = { nt_num: n.noteNo, nt_dt: dmy(n.date), ntty: n.kind === 'credit' ? 'C' : 'D', val: r2(n.totals?.grand || 0), pos, rchrg: 'N', inv_typ: 'R', itms: items(n.lines), against: n.against?.docNo || '', party: n.partyName, reason: n.reason };
    if (!n.against?.docNo) checks.push({ level: 'error', doc: n.noteNo, text: 'The note names no original invoice' });
    else if (!invByNo.has(n.against.docNo) && !(await Invoice.exists({ invoiceNumber: n.against.docNo }))) checks.push({ level: 'warn', doc: n.noteNo, text: `Original invoice ${n.against.docNo} is not in the books` });
    if (gstin) { const g = cdnr.get(gstin) || { ctin: gstin, name: n.partyName, nt: [] }; g.nt.push(row); cdnr.set(gstin, g); }
    else cdnur.push({ ...row, typ: n.supplyType === 'inter' && row.val > B2CL_LIMIT ? 'B2CL' : 'B2CS' });
  }

  // HSN summary: by HSN and rate, over invoices, less credit notes, plus debit notes.
  const hsn = new Map();
  const addHsn = (lines, sign) => {
    for (const l of lines || []) {
      const h = String(l.hsn || '').replace(/\D/g, '') || '0000';
      const rt = Number(l.gstPercent) || 0;
      const k = `${h}|${rt}|${uqc(l.unit)}`;
      const g = hsn.get(k) || { hsn_sc: h, desc: String(l.name || l.description || '').slice(0, 30), uqc: uqc(l.unit), qty: 0, rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      g.qty = r2(g.qty + sign * (l.quantity || 0)); g.txval = r2(g.txval + sign * (l.taxable || 0)); g.iamt = r2(g.iamt + sign * (l.igst || 0)); g.camt = r2(g.camt + sign * (l.cgst || 0)); g.samt = r2(g.samt + sign * (l.sgst || 0));
      hsn.set(k, g);
    }
  };
  for (const inv of invoices) addHsn(inv.lines, 1);
  for (const n of notes) addHsn(n.lines, n.kind === 'credit' ? -1 : 1);
  const hsnRows = [...hsn.values()].sort((a, b) => a.hsn_sc.localeCompare(b.hsn_sc) || a.rt - b.rt).map((g, i) => ({ num: i + 1, ...g }));

  // Document series: the numbers issued this month, and how many cancelled.
  const series = (docs, cancelledDocs, no, nature) => {
    const nos = [...docs.map((d) => d[no]), ...cancelledDocs.map((d) => d[no])].sort();
    if (!nos.length) return null;
    return { doc_num: nature, doc_typ: nature === 1 ? 'Invoices for outward supply' : nature === 4 ? 'Debit Note' : 'Credit Note', docs: [{ num: 1, from: nos[0], to: nos[nos.length - 1], totnum: nos.length, cancel: cancelledDocs.length, net_issue: nos.length - cancelledDocs.length }] };
  };
  const docs = [
    series(invoices, cancelled, 'invoiceNumber', 1),
    series(notes.filter((n) => n.kind === 'credit'), cancelledNotes.filter((n) => n.kind === 'credit'), 'noteNo', 5),
    series(notes.filter((n) => n.kind === 'debit'), cancelledNotes.filter((n) => n.kind === 'debit'), 'noteNo', 4),
  ].filter(Boolean);

  const sumRows = (rows, pick) => rows.reduce((t, r) => { const x = pick(r); return { count: t.count + 1, val: r2(t.val + (x.val || 0)), txval: r2(t.txval + x.txval), tax: r2(t.tax + x.iamt + x.camt + x.samt) }; }, { count: 0, val: 0, txval: 0, tax: 0 });
  const flatInv = (groups) => groups.flatMap((g) => g.inv.map((i) => ({ val: i.val, ...i.itms.reduce((t, it) => ({ txval: r2(t.txval + it.itm_det.txval), iamt: r2(t.iamt + it.itm_det.iamt), camt: r2(t.camt + it.itm_det.camt), samt: r2(t.samt + it.itm_det.samt) }), { txval: 0, iamt: 0, camt: 0, samt: 0 }) })));
  const flatNt = (rows) => rows.map((n) => ({ val: n.val, ...n.itms.reduce((t, it) => ({ txval: r2(t.txval + it.itm_det.txval), iamt: r2(t.iamt + it.itm_det.iamt), camt: r2(t.camt + it.itm_det.camt), samt: r2(t.samt + it.itm_det.samt) }), { txval: 0, iamt: 0, camt: 0, samt: 0 }) }));

  return {
    month, from, to, fp, gstin: ourGstin, hsnDigits,
    b2b: [...b2b.values()], b2cl: [...b2cl.values()], b2cs: [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt),
    cdnr: [...cdnr.values()], cdnur, hsn: hsnRows, docs,
    summary: {
      b2b: sumRows(flatInv([...b2b.values()]), (x) => x),
      b2cl: sumRows(flatInv([...b2cl.values()]), (x) => x),
      b2cs: sumRows([...b2cs.values()], (x) => ({ val: r2(x.txval + x.iamt + x.camt + x.samt), txval: x.txval, iamt: x.iamt, camt: x.camt, samt: x.samt })),
      cdnr: sumRows(flatNt([...cdnr.values()].flatMap((g) => g.nt)), (x) => x),
      cdnur: sumRows(flatNt(cdnur), (x) => x),
    },
    checks,
    counts: { invoices: invoices.length, cancelled: cancelled.length, notes: notes.length },
  };
}

/** The offline tool's JSON. */
function toJson(r) {
  const strip = (row) => { const { customer, irn, against, party, reason, typ, ...rest } = row; return rest; };
  return {
    gstin: r.gstin, fp: r.fp, version: 'GST3.0.4', hash: 'hash',
    b2b: r.b2b.map((g) => ({ ctin: g.ctin, inv: g.inv.map(strip) })),
    b2cl: r.b2cl.map((g) => ({ pos: g.pos, inv: g.inv.map((i) => { const { pos, ...rest } = strip(i); return rest; }) })),
    b2cs: r.b2cs.map(({ count, ...g }) => g),
    cdnr: r.cdnr.map((g) => ({ ctin: g.ctin, nt: g.nt.map(strip) })),
    cdnur: r.cdnur.map((n) => ({ typ: n.typ, ...strip(n) })),
    hsn: { data: r.hsn },
    doc_issue: { doc_det: r.docs },
  };
}

module.exports = { build, toJson, items, B2CL_LIMIT };

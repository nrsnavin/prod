'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY TRANSACTION OF A CUSTOMER IS ON THEIR LEDGER
//
//  One customer through everything the office can key against them,
//  each by its real route: opening balances (bill-wise, and an advance),
//  invoices from despatched challans, one cancelled, receipts by bank
//  against an opening bill and an invoice (with bank charges and TDS the
//  customer kept), an opening advance applied, a credit note, a debit
//  note, a cheque that bounced, a receipt cancelled as a wrong entry,
//  one recorded from the bank statement, a journal writing off a
//  difference, and money left on account.
//
//  Then:
//    · each live document in the database has its one ledger row, with
//      its amount on the right side, and nothing cancelled has a row —
//      for this customer and, swept, for every party in the books
//    · the ledger closing = open documents − credits on account, and
//      the books-health checks find nothing
//    · rebuilding the ledger from the documents moves nothing
//    · the statement, its PDF (summary and detailed, one page or many,
//      any date range, an empty ledger) and its Excel all come out, and
//      the PDF says every voucher number and the closing balance
//
//  Set LEDGER_PDF_OUT=/some/dir to keep the sample PDFs it renders.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const fs       = require('fs');
const path     = require('path');
const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const ExcelJS  = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const binary = (res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };
const file = (url) => get(url).buffer(true).parse(binary);
const ok = async (p, status = 201) => { const r = await p; if (r.status !== status) throw new Error(`${r.request.method} ${r.request.url} → ${r.status} ${r.body.message}`); return r.body; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
const keep = (name, buf) => { if (process.env.LEDGER_PDF_OUT) { fs.mkdirSync(process.env.LEDGER_PDF_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.LEDGER_PDF_OUT, name), buf); } };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Elastic', 'Order', 'DeliveryChallan', 'Invoice', 'AccountNote', 'Payment', 'Journal', 'OpeningBalance', 'PartyLedgerEntry', 'SupplierBill', 'Expense']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cledger@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road', 'Erode 638052'], invoice: { city: 'Erode', pincode: '638052', defaultHsn: '5806', defaultGstPercent: 5, stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

/** An invoice through the real route: an elastic, an order, a despatched challan. */
let seq = 0;
async function invoiceFor(customer, { metres, rate, date }) {
  seq += 1;
  const el = await M.Elastic.create({ name: `${20 + seq}mm Knitted Elastic`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 9000, hsn: '5806', gstPercent: 5 });
  const order = await M.Order.create({ customer: customer._id, po: `SG/PO/${100 + seq}`, date: new Date(date), supplyDate: new Date(date), status: 'InProgress', elasticOrdered: [{ elastic: el._id, quantity: metres, rate }] });
  const dc = await M.DeliveryChallan.create({ dcNumber: `E-26/27-${String(seq).padStart(4, '0')}`, type: 'elastic', financialYear: '26/27', sequence: seq, order: order._id, orderNo: order.orderNo, customerName: customer.name, status: 'dispatched', dispatchDate: new Date(date), items: [{ elastic: el._id, elasticName: el.name, unit: 'm', quantity: metres, rate: 0 }], totalQuantity: metres });
  return (await ok(post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: date }))).invoice;
}

/**
 * The ledger rows the live documents in the database call for, as
 * "docType docNo Dr|Cr amount" — built from the documents alone, not
 * from anything the posting code wrote.
 */
async function expectedRows(match = {}) {
  const out = [];
  const pt = (d) => d.partyType;
  const who = (d) => String(d.partyType === 'customer' ? d.customer : d.supplier);
  const want = (d) => !match.party || who(d) === String(match.party);
  const row = (party, docType, docNo, debit, credit) => out.push({ party, line: `${docType} ${docNo} ${debit ? `Dr ${r2(debit).toFixed(2)}` : `Cr ${r2(credit).toFixed(2)}`}` });
  for (const o of await M.OpeningBalance.find({ status: 'posted' }).lean()) {
    if (!want(o)) continue;
    const dr = (o.partyType === 'customer') === (o.kind === 'due');
    row(who(o), 'OpeningBalance', o.docNo, dr ? o.amount : 0, dr ? 0 : o.amount);
  }
  for (const i of await M.Invoice.find({ status: 'issued' }).lean()) {
    if (match.party && String(i.customer) !== String(match.party)) continue;
    row(String(i.customer), 'Invoice', i.invoiceNumber, i.totals.grand, 0);
  }
  for (const n of await M.AccountNote.find({ status: 'issued' }).lean()) {
    if (!want(n)) continue;
    row(who(n), 'AccountNote', n.noteNo, n.kind === 'debit' ? n.totals.grand : 0, n.kind === 'credit' ? n.totals.grand : 0);
  }
  for (const p of await M.Payment.find({ status: 'posted', partyType: { $in: ['customer', 'supplier'] } }).lean()) {
    if (!want(p)) continue;
    const settled = r2((p.amount || 0) + (p.tds?.amount || 0) + (p.adjustments || []).reduce((s, a) => s + a.amount, 0));
    row(who(p), 'Payment', p.voucherNo, p.kind === 'payment' ? settled : 0, p.kind === 'receipt' ? settled : 0);
  }
  for (const j of await M.Journal.find({ status: 'posted' }).lean()) {
    for (const l of j.lines) {
      if (l.kind !== 'party' || !pt(l)) continue;
      if (!want(l)) continue;
      row(who(l), 'Journal', j.journalNo, l.debit || 0, l.credit || 0);
    }
  }
  for (const b of await M.SupplierBill.find({ status: { $ne: 'cancelled' } }).lean()) {
    if (match.party && String(b.supplier) !== String(match.party)) continue;
    row(String(b.supplier), 'SupplierBill', b.billNo, 0, b.totals.grand);
  }
  for (const e of await M.Expense.find({ status: { $in: ['approved', 'paid'] }, supplier: { $ne: null } }).lean()) {
    if (match.party && String(e.supplier) !== String(match.party)) continue;
    row(String(e.supplier), 'Expense', e.expenseNo, 0, e.totals.grand);
  }
  return out.map((x) => (match.party ? x.line : `${x.party} ${x.line}`)).sort();
}

async function ledgerRows(match = {}) {
  const rows = await M.PartyLedgerEntry.find(match.party ? { party: match.party } : {}).lean();
  return rows.map((e) => {
    const line = `${e.docType} ${e.docNo} ${e.debit ? `Dr ${r2(e.debit).toFixed(2)}` : `Cr ${r2(e.credit).toFixed(2)}`}`;
    return match.party ? line : `${e.party} ${line}`;
  }).sort();
}

describe("a customer's ledger, every transaction", () => {
  const S = {};

  beforeAll(async () => {
    S.c = await M.Customer.create({ name: 'Sunrise Garments & Co.', contactName: 'Ravi', phoneNumber: '9200000001', gstin: '33AAEPS1001F1Z2', address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', stateCode: '33', paymentTerms: '30' });
    await get('/accounts/bank-accounts');
    S.bank = (await ok(post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 500000, openingDate: '2026-03-31', isDefault: true, tallyLedger: 'Kotak Mahindra Bank' }))).account;
    const pay = (body) => ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.c._id, mode: 'bank', account: S.bank._id, ...body }));

    // Opening, bill-wise as Tally had it, and an advance.
    S.ob882 = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: S.c._id, kind: 'due', refNo: 'TALLY/882', date: '2026-03-31', amount: 30000 }))).row;
    S.ob901 = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: S.c._id, kind: 'due', refNo: 'TALLY/901', date: '2026-03-31', amount: 18500 }))).row;
    S.obAdv = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: S.c._id, kind: 'advance', refNo: 'TALLY/R77', date: '2026-03-31', amount: 5000 }))).row;

    // Invoices from despatched challans; the third cancelled the next day.
    S.inv1 = await invoiceFor(S.c, { metres: 1000, rate: 12, date: '2026-04-10' });
    S.inv2 = await invoiceFor(S.c, { metres: 2000, rate: 11.5, date: '2026-05-05' });
    S.inv3 = await invoiceFor(S.c, { metres: 500, rate: 12, date: '2026-05-20' });
    await ok(post(`/invoice/${S.inv3._id}/cancel`, { reason: 'Raised on the wrong challan' }), 200);

    // A receipt against an opening bill; the opening advance applied to the first invoice.
    S.r1 = (await pay({ amount: 30000, reference: 'NEFT KKBK2604251', date: '2026-04-25', allocations: [{ docType: 'OpeningBalance', doc: S.ob882._id, amount: 30000 }] })).payment;
    await ok(post('/accounts/credits/apply', { source: { type: 'OpeningBalance', id: S.obAdv._id }, allocations: [{ docType: 'Invoice', doc: S.inv1._id, amount: 5000 }] }), 200);
    // The rest of the first invoice: money, bank charges, and TDS the customer kept.
    const rest1 = r2(S.inv1.totals.grand - 5000);
    S.r2 = (await pay({ amount: r2(rest1 - 100), reference: 'NEFT KKBK2606011', date: '2026-06-01', adjustments: [{ kind: 'bank_charges', amount: 50 }, { kind: 'tds_by_customer', amount: 50 }], allocations: [{ docType: 'Invoice', doc: S.inv1._id, amount: rest1 }] })).payment;

    // A credit note against the second invoice, and a debit note for freight.
    S.cn = (await ok(post('/accounts/notes', { kind: 'credit', against: { doc: S.inv2._id }, reason: 'Rate difference agreed', date: '2026-06-10', lines: [{ description: 'Rate difference 2000 m at 0.50', quantity: 2000, rate: 0.5, gstPercent: 5 }] }))).note;
    S.dn = (await ok(post('/accounts/notes', { kind: 'debit', partyType: 'customer', against: { doc: S.inv2._id }, reason: 'Freight billed later', date: '2026-06-15', lines: [{ description: 'Freight Tiruppur', quantity: 1, rate: 800, gstPercent: 18 }] }))).note;
    const due2 = r2(S.inv2.totals.grand - S.cn.totals.grand + S.dn.totals.grand);

    // A cheque for it that bounced; a wrong entry cancelled.
    S.chq = (await pay({ amount: due2, mode: 'cheque', cheque: { number: '004512', bank: 'Indian Bank', date: '2026-06-20', deposited: true }, date: '2026-06-20', allocations: [{ docType: 'Invoice', doc: S.inv2._id, amount: due2 }] })).payment;
    await ok(post(`/accounts/payments/${S.chq._id}/cheque`, { action: 'bounced', on: '2026-06-25', reason: 'Insufficient funds', charges: 250 }), 200);
    S.wrong = (await pay({ amount: 1000, date: '2026-06-22', reference: 'UPI 6622' })).payment;
    await ok(post(`/accounts/payments/${S.wrong._id}/cancel`, { reason: 'Entered against the wrong customer' }), 200);

    // A difference written off by journal, the rest from the bank statement.
    S.jv = (await ok(post('/accounts/journals', { date: '2026-06-28', purpose: 'writeoff', reason: 'Short payment waived', lines: [
      { kind: 'ledger', ledger: 'Discount Allowed', debit: 100 },
      { kind: 'party', partyType: 'customer', party: S.c._id, credit: 100, refs: [{ docType: 'Invoice', doc: S.inv2._id, amount: 100 }] },
    ] }))).journal;
    S.r5 = (await pay({ amount: r2(due2 - 100), date: '2026-07-01', source: 'statement', statementLine: '2026-07-01|NEFT SUNRISE GARMENTS', reference: 'NEFT SBIN2607011', allocations: [{ docType: 'Invoice', doc: S.inv2._id, amount: r2(due2 - 100) }] })).payment;

    // Paid ahead, on account.
    S.r6 = (await pay({ amount: 10000, date: '2026-07-10', reference: 'RTGS UTIB2607101', narration: 'Advance for the August order' })).payment;
  }, 120_000);

  it('has each live document once, on the right side, and nothing cancelled', async () => {
    const want = await expectedRows({ party: S.c._id });
    const have = await ledgerRows({ party: S.c._id });
    expect(have).toEqual(want);
    // Every kind of customer document is in it.
    expect([...new Set(have.map((l) => l.split(' ')[0]))].sort()).toEqual(['AccountNote', 'Invoice', 'Journal', 'OpeningBalance', 'Payment']);
    expect(have).toHaveLength(3 + 2 + 2 + 4 + 1);   // opening 3, invoices 2, notes 2, receipts 4 live, journal 1
    // The cancelled invoice, the bounced cheque and the wrong entry are not.
    const docs = have.join('\n');
    for (const gone of [S.inv3.invoiceNumber, S.chq.voucherNo, S.wrong.voucherNo]) expect(docs).not.toContain(gone);
    // And they are still in the database, cancelled — not lost.
    expect((await M.Invoice.findById(S.inv3._id).lean()).status).toBe('cancelled');
    expect(await M.Payment.findById(S.chq._id).lean()).toMatchObject({ status: 'cancelled', cheque: { status: 'bounced', bounceReason: 'Insufficient funds', charges: 250 } });
    expect((await M.Payment.findById(S.wrong._id).lean()).status).toBe('cancelled');
  });

  it('closes at the open documents less what was paid ahead, and the health checks are clean', async () => {
    const st = (await ok(get(`/accounts/statement?partyType=customer&party=${S.c._id}`), 200));
    // What is open: TALLY/901, and 10,000 on account.
    const open = (await require('../../services/outstanding').receivables({ customer: S.c._id })).reduce((s, r) => s + r.outstanding, 0);
    const credit = (await require('../../services/credits').openFor('customer', S.c._id)).reduce((s, x) => s + x.available, 0);
    expect(r2(open)).toBe(18500);
    expect(r2(credit)).toBe(10000);
    expect(st.closing).toBe(8500);
    expect(st.closingSide).toBe('Dr');
    expect(st.totals.debit - st.totals.credit).toBeCloseTo(8500, 2);
    // The running balance ends where the closing says.
    expect(st.rows[st.rows.length - 1].balance).toBe(8500);
    const h = await require('../../services/booksHealth').check();
    expect(h.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.count}`)).toEqual([]);
  });

  it('rebuilt from the documents, nothing moves', async () => {
    const before = await ledgerRows();
    const n = await require('../../services/partyLedger').rebuild();
    expect(await ledgerRows()).toEqual(before);
    expect(n).toBe(before.length);
  });

  it('swept across every party in the books: no document without its row, no row without its document', async () => {
    // A supplier side too, so the sweep is not of one party.
    const s = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS4004F1Z5', address: 'Erode' });
    await ok(post('/accounts/opening-balances', { partyType: 'supplier', party: s._id, kind: 'due', refNo: 'SY/1099', date: '2026-03-31', amount: 30000 }));
    const bill = (await ok(post('/accounts/bills', { supplier: s._id, supplierBillNo: 'SY/1204', lines: [{ description: 'Polyester yarn', quantity: 100, rate: 220, gstPercent: 5 }], billDate: '2026-06-05' }))).bill;
    await ok(post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: bill.totals.grand, mode: 'bank', account: S.bank._id, date: '2026-06-30', allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: bill.totals.grand }] }));
    expect(await ledgerRows()).toEqual(await expectedRows());
  });

  it('prints: the PDF names every voucher and the closing, summary and detailed, Excel too', async () => {
    const q = `partyType=customer&party=${S.c._id}&from=2026-04-01&to=2027-03-31`;
    const st = (await ok(get(`/accounts/statement?${q}`), 200));
    // The opening balances are before the year: they are the opening line.
    expect(st.opening).toBe(43500);
    expect(st.rows.map((r) => r.docNo)).not.toContain(S.ob882.docNo);

    const res = await file(`/accounts/statement/pdf?${q}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    keep('sunrise-garments-ledger-2026-27.pdf', res.body);
    // One page, and no blank one after it for the footer.
    expect(pageCount(res.body)).toBe(1);
    const text = pdfText(res.body);
    for (const r of st.rows) expect(text).toContain(r.docNo);
    expect(text).toContain('Sunrise Garments & Co.');
    expect(text).toContain(inr(8500));
    expect(text).toContain(inr(43500));

    const detailed = await file(`/accounts/statement/pdf?${q}&detailed=1`);
    expect(detailed.status).toBe(200);
    keep('sunrise-garments-ledger-2026-27-detailed.pdf', detailed.body);
    expect(pdfText(detailed.body)).toContain(S.inv1.invoiceNumber);

    // From the first day: the opening balances as rows.
    const all = await file(`/accounts/statement/pdf?partyType=customer&party=${S.c._id}`);
    expect(all.status).toBe(200);
    keep('sunrise-garments-ledger-all.pdf', all.body);
    for (const ob of [S.ob882, S.ob901, S.obAdv]) expect(pdfText(all.body)).toContain(ob.docNo);

    // The receipt the customer is sent: one page too.
    const rct = await file(`/accounts/payments/${S.r2._id}/pdf`);
    expect(rct.status).toBe(200);
    keep('receipt-sample.pdf', rct.body);
    expect(pageCount(rct.body)).toBe(1);
    expect(pdfText(rct.body)).toContain(S.r2.voucherNo);

    const x = await file(`/accounts/statement/xlsx?${q}`);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const cells = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))));
    for (const r of st.rows) expect(cells.join('|')).toContain(r.docNo);
  });

  it('does not break: an empty ledger, a range with nothing in it, many pages, bad requests', async () => {
    const empty = await M.Customer.create({ name: 'New Buyer (no entries yet)', contactName: 'N', phoneNumber: '9200000009' });
    for (const url of [
      `/accounts/statement/pdf?partyType=customer&party=${empty._id}`,
      `/accounts/statement/pdf?partyType=customer&party=${empty._id}&detailed=1`,
      `/accounts/statement/pdf?partyType=customer&party=${S.c._id}&from=2030-04-01&to=2031-03-31`,
      `/accounts/statement/pdf?partyType=customer&party=${S.c._id}&from=2026-12-01&to=2026-04-01`,
      `/accounts/statement/xlsx?partyType=customer&party=${empty._id}`,
    ]) {
      const r = await file(url);
      expect({ url, status: r.status }).toEqual({ url, status: 200 });
    }
    const quiet = (await ok(get(`/accounts/statement?partyType=customer&party=${S.c._id}&from=2030-04-01&to=2031-03-31`), 200));
    expect(quiet).toMatchObject({ opening: 8500, closing: 8500, rows: [] });

    // Two hundred rows with long narrations: many pages, every one printed.
    const busy = await M.Customer.create({ name: 'Busy Buyer', contactName: 'B', phoneNumber: '9200000008' });
    const ledger = require('../../services/partyLedger');
    for (let i = 0; i < 200; i++) {
      await ledger.post({ partyType: 'customer', party: busy._id, date: new Date(Date.UTC(2026, 3, 1 + (i % 300))), docType: 'Invoice', doc: new mongoose.Types.ObjectId(), docNo: `BULK/${String(i).padStart(4, '0')}`, debit: 1000 + i, narration: `Sales — ${'a long narration that has to wrap onto the next line in the particulars column '.repeat(2)}` });
    }
    const big = await file(`/accounts/statement/pdf?partyType=customer&party=${busy._id}`);
    expect(big.status).toBe(200);
    keep('many-pages.pdf', big.body);
    const pages = pageCount(big.body);
    expect(pages).toBeGreaterThan(3);
    // Every page carries rows (or the closing): none is blank.
    const perPage = pdfText(big.body).split(/page \d+ of \d+/).slice(0, -1);
    expect(perPage).toHaveLength(pages);
    for (const p of perPage) expect(p).toMatch(/BULK\/\d{4}|Closing Balance|Due from you/);
    const t = pdfText(big.body);
    expect(t).toContain('BULK/0000');
    expect(t).toContain('BULK/0199');

    expect((await get(`/accounts/statement/pdf?partyType=customer&party=${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await get('/accounts/statement/pdf?partyType=customer&party=nope')).status).toBe(400);
    expect((await get(`/accounts/statement/pdf?partyType=vendor&party=${S.c._id}`)).status).toBe(400);
    expect((await get(`/accounts/statement/pdf?partyType=customer&party=${S.c._id}&from=31-13-2026`)).status).toBe(400);
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BILLS MAILBOX — services/billMailbox.js, /accounts/bill-inbox
//
//    • each PDF or photo mailed in is read like a scanned bill and matched
//      to the supplier on file; a mail is read once, whoever asks
//    • the inbox lists them; one opens as a scan does, entering it marks
//      it entered and the file goes with the bill
//    • signature logos, other senders (when a list is set), and files
//      that are not bills are left out; dismissing keeps it out of the books
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockReadBill = jest.fn();
jest.mock('../../utils/billOcr', () => ({
  readBill: (...a) => mockReadBill(...a),
  SUPPORTED: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const MailComposer = require('nodemailer/lib/mail-composer');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, box;
let inbox = [];
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function mail({ id, from = 'accounts@sriyarn.in', attachments = [] }) {
  const raw = await new MailComposer({ from, to: 'bills@baluelastics.com', subject: 'Invoice SY/118', text: 'Please find the invoice.', messageId: `<${id}@sriyarn.in>`, attachments }).compile().build();
  return { messageId: `<${id}@sriyarn.in>`, source: raw };
}
const reading = (over = {}) => ({
  kind: 'bill', problem: null, supplierName: 'Sri Yarn Traders', supplierGstin: '33AAAPS0001F1Z5', billNo: 'SY/118', billDate: '2026-10-20', dueDate: null,
  lines: [{ description: 'Nylon 70D', hsn: '5402', quantity: 60, unit: 'kg', rate: 310, gstPercent: 5, amount: 18600, confidence: 0.9 }],
  totals: { taxable: 18600, cgst: 465, sgst: 465, igst: 0, grand: 19530 }, confidence: 0.9, model: 'test-vision', usage: {}, latencyMs: 5, ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  box = require('../../services/billMailbox');
  box.setFetcher(async (_c, { isKnown }) => { const out = []; for (const m of inbox) if (!(await isKnown(m.messageId))) out.push(m); return out; });
  M = {};
  for (const n of ['User', 'Supplier', 'SupplierBill', 'InboxBill']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'bm@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { box.setFetcher(null); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  inbox = [];
  mockReadBill.mockReset();
  Object.assign(process.env, { BILLS_IMAP_HOST: 'imap.test', BILLS_IMAP_USER: 'bills@baluelastics.com', BILLS_IMAP_PASS: 'x', BILLS_EVERY_MIN: '0' });
  delete process.env.BILLS_FROM;
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

describe('the bills mailbox', () => {
  it('reads each bill mailed in, matches the supplier, and lists it — once', async () => {
    const supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode', email: 'accounts@sriyarn.in' });
    mockReadBill.mockResolvedValue(reading());
    inbox = [await mail({ id: 'a1', attachments: [
      { filename: 'SY-118.pdf', content: PDF, contentType: 'application/pdf' },
      // The logo in the signature is not a bill.
      { filename: 'logo.png', content: Buffer.alloc(800, 1), contentType: 'image/png', cid: 'logo@sig', contentDisposition: 'inline' },
    ] })];

    expect(await box.run()).toMatchObject({ ran: true, mails: 1, bills: 1 });
    expect(mockReadBill).toHaveBeenCalledTimes(1);
    expect(mockReadBill.mock.calls[0][0][0].mimetype).toBe('application/pdf');
    // Asked again — or by a second process — the mail is not read twice.
    expect(await box.run()).toMatchObject({ mails: 0, bills: 0 });
    expect(mockReadBill).toHaveBeenCalledTimes(1);

    const list = (await get('/accounts/bill-inbox')).body.bills;
    expect(list).toEqual([expect.objectContaining({ status: 'new', supplierName: 'Sri Yarn Traders', matchedBy: 'gstin', senderKnown: true, billNo: 'SY/118', grand: 19530, filename: 'SY-118.pdf' })]);
    expect((await get('/accounts/inbox')).body.mailedBills).toMatchObject({ count: 1, amount: 19530 });

    // Opened: as a scan returns it, to fill the bill form.
    const one = (await get(`/accounts/bill-inbox/${list[0]._id}`)).body;
    expect(one).toMatchObject({ read: { billNo: 'SY/118' }, supplier: { _id: String(supplier._id), matchedBy: 'gstin' }, alreadyEntered: null });
    const file = await get(`/accounts/bill-inbox/${list[0]._id}/file`).buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(file.body, PDF)).toBe(0);

    // Entered from it: the item is done and the PDF goes with the bill.
    const bill = await post('/accounts/bills', { supplier: String(supplier._id), supplierBillNo: 'SY/118', billDate: '2026-10-20', lines: [{ description: 'Nylon 70D', quantity: 60, rate: 310, gstPercent: 5 }], inboxBill: list[0]._id });
    expect(bill.status).toBe(201);
    const item = await M.InboxBill.findById(list[0]._id).lean();
    expect(item).toMatchObject({ status: 'entered', bill: new mongoose.Types.ObjectId(bill.body.bill._id) });
    expect((await M.SupplierBill.findById(bill.body.bill._id).lean()).attachments?.[0]).toMatchObject({ filename: 'SY-118.pdf' });
    expect((await get('/accounts/bill-inbox')).body.bills).toEqual([]);
    expect((await post('/accounts/bills', { supplier: String(supplier._id), supplierBillNo: 'SY/119', lines: [{ description: 'x', quantity: 1, rate: 1 }], inboxBill: list[0]._id })).status).toBe(409);

    // The bill is cancelled (entered wrongly): the mailed bill is among the new ones again.
    expect((await post(`/accounts/bills/${bill.body.bill._id}/cancel`, { reason: 'Entered with the wrong quantity' })).status).toBe(200);
    const back = await M.InboxBill.findById(list[0]._id).lean();
    expect(back).toMatchObject({ status: 'new', bill: null });
    expect(back.note).toMatch(/was cancelled: to be entered again/);
    expect((await get('/accounts/bill-inbox')).body.bills).toHaveLength(1);
    const again = await post('/accounts/bills', { supplier: String(supplier._id), supplierBillNo: 'SY/118', billDate: '2026-10-20', lines: [{ description: 'Nylon 70D', quantity: 62, rate: 310, gstPercent: 5 }], inboxBill: list[0]._id });
    expect(again.status).toBe(201);
    expect(await M.InboxBill.findById(list[0]._id).lean()).toMatchObject({ status: 'entered', bill: new mongoose.Types.ObjectId(again.body.bill._id) });
  });

  it('says when the same bill is entered already, and lets one be dismissed', async () => {
    const supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    await post('/accounts/bills', { supplier: String(supplier._id), supplierBillNo: 'SY/118', lines: [{ description: 'x', quantity: 1, rate: 1 }] });
    mockReadBill.mockResolvedValue(reading());
    inbox = [await mail({ id: 'b1', from: 'someone@else.in', attachments: [{ filename: 'scan.jpg', content: Buffer.alloc(40_000, 7), contentType: 'image/jpeg' }] })];
    await box.run();
    const [row] = (await get('/accounts/bill-inbox')).body.bills;
    expect(row).toMatchObject({ alreadyEntered: expect.stringMatching(/^PB\//), senderKnown: false });
    expect((await post(`/accounts/bill-inbox/${row._id}/dismiss`, { reason: 'Copy of one entered' })).status).toBe(200);
    expect((await get('/accounts/bill-inbox?status=dismissed')).body.bills[0]).toMatchObject({ note: 'Copy of one entered' });
  });

  it('leaves out other senders when a list is set, mails with no bill, and files that are not bills', async () => {
    process.env.BILLS_FROM = '@sriyarn.in';
    mockReadBill.mockResolvedValueOnce(reading({ kind: null, problem: 'not_a_bill' }));
    inbox = [
      await mail({ id: 'c1', from: 'spam@else.com', attachments: [{ filename: 'x.pdf', content: PDF, contentType: 'application/pdf' }] }),
      await mail({ id: 'c2', attachments: [] }),
      await mail({ id: 'c3', attachments: [{ filename: 'brochure.pdf', content: PDF, contentType: 'application/pdf' }] }),
    ];
    expect(await box.run()).toMatchObject({ mails: 3, bills: 0 });
    expect(mockReadBill).toHaveBeenCalledTimes(1);
    expect((await get('/accounts/bill-inbox')).body.bills).toEqual([]);
    expect((await get('/accounts/bill-inbox?status=skipped')).body.bills).toEqual([expect.objectContaining({ note: 'Not a bill', filename: 'brochure.pdf' })]);
    const mails = await M.InboxBill.find({ part: 0 }).lean();
    expect(mails.map((m) => m.note).sort()).toEqual(expect.arrayContaining(['spam@else.com is not on the bills senders list', 'No PDF or photo of a bill attached']));
  });

  it('keeps the file when reading is not set up, to enter by hand', async () => {
    mockReadBill.mockRejectedValueOnce(Object.assign(new Error('no key'), { code: 'ANTHROPIC_KEY_MISSING' }));
    inbox = [await mail({ id: 'd1', attachments: [{ filename: 'SY-120.pdf', content: PDF, contentType: 'application/pdf' }] })];
    await box.run();
    expect((await get('/accounts/bill-inbox?status=failed')).body.bills[0]).toMatchObject({ filename: 'SY-120.pdf', note: expect.stringMatching(/not set up/) });
  });

  it('is the accounts desk\'s, and says whether the mailbox is set up', async () => {
    expect((await get('/accounts/bill-inbox/status')).body).toMatchObject({ configured: true, mailbox: 'bills@baluelastics.com', waiting: 0 });
    expect((await request(app).get('/api/v2/accounts/bill-inbox')).status).toBe(401);
  });
});

'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CUSTOMER MAILBOX
//
//  Each customer mail sorted (order, complaint, advice, enquiry) and
//  handed to the reader that exists for it; an order or complaint from
//  an unknown sender kept, not filed under a guess. The readers are
//  stubbed: what is tested is the sorting and what each mail becomes.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));
const mockNotify = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../utils/notify', () => ({ ...jest.requireActual('../../utils/notify'), notify: (...a) => mockNotify(...a) }));
const mockPoText = jest.fn(); const mockPoDoc = jest.fn();
jest.mock('../../services/inboundPoIntake', () => ({ draftFromText: (...a) => mockPoText(...a), draftFromDocument: (...a) => mockPoDoc(...a), settleDraft: jest.fn() }));
const mockIntake = jest.fn();
jest.mock('../../services/complaintIntake', () => ({ ...jest.requireActual('../../services/complaintIntake'), intake: (...a) => mockIntake(...a) }));
const mockAdvice = jest.fn(); const mockPlace = jest.fn();
jest.mock('../../utils/adviceOcr', () => ({ readAdvice: (...a) => mockAdvice(...a) }));
jest.mock('../../services/adviceMatch', () => ({ placeAdvice: (...a) => mockPlace(...a) }));
const mockQuote = jest.fn();
jest.mock('../../services/quoteEnquiry', () => ({ draft: (...a) => mockQuote(...a) }));

let mongo, app, inbox, InboxMail, admin, customer, job;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
let n = 0;
const mail = ({ from = 'purchase@tirupurknits.in', subject, body, attach }) => {
  n += 1;
  const id = `<m${n}@t>`;
  const head = `From: ${from}\r\nTo: orders@balu.in\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: Mon, 9 Nov 2026 10:00:00 +0530\r\nMIME-Version: 1.0\r\n`;
  if (!attach) return { messageId: id, source: Buffer.from(`${head}Content-Type: text/plain\r\n\r\n${body}\r\n`) };
  const b = 'XYZ';
  return { messageId: id, source: Buffer.from(`${head}Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--${b}\r\nContent-Type: application/pdf; name="${attach}"\r\nContent-Disposition: attachment; filename="${attach}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4 test').toString('base64')}\r\n--${b}--\r\n`) };
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  inbox = require('../../services/customerInbox');
  InboxMail = require('../../models/InboxMail');
  admin = await require('../../models/User').create({ name: 'Owner', email: 'ci@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  customer = await require('../../models/Customer').collection.insertOne({ name: 'Tirupur Knits', email: 'accounts@tirupurknits.in', purchase: { name: 'Raj', email: 'purchase@tirupurknits.in' } }).then((r) => ({ _id: r.insertedId, name: 'Tirupur Knits' }));
  job = new mongoose.Types.ObjectId();
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { [mockNotify, mockPoText, mockPoDoc, mockIntake, mockAdvice, mockPlace, mockQuote].forEach((m) => m.mockReset()); mockNotify.mockResolvedValue({}); });

describe('a purchase order by mail', () => {
  it('becomes an order request from the attached PO, for the customer the sender belongs to', async () => {
    mockPoDoc.mockResolvedValue({ ok: true, draft: { lines: [{ elastic: 'x' }, { elastic: 'y' }] }, aiSuggestionId: 'ai1' });
    const r = await inbox.handle(mail({ subject: 'Purchase Order 4512', body: 'Please find our PO attached.', attach: 'PO-4512.pdf' }));
    expect(r).toMatchObject({ status: 'done', kind: 'purchase_order' });
    const req = await require('../../models/OrderRequest').findOne({ customer: customer._id }).lean();
    expect(req.draft.lines).toHaveLength(2);
    const m = await InboxMail.findOne({ subject: 'Purchase Order 4512' }).lean();
    expect(m).toMatchObject({ customerName: 'Tirupur Knits', orderRequest: req._id, files: [expect.objectContaining({ filename: 'PO-4512.pdf' })] });
    expect(mockNotify).toHaveBeenCalledWith('customerMail', expect.objectContaining({ body: expect.stringMatching(/Tirupur Knits\* sent a purchase order/) }));
  });

  it('from an unknown sender, is kept with its draft rather than filed under a guess', async () => {
    mockPoText.mockResolvedValue({ ok: true, draft: { lines: [{}] } });
    const before = await require('../../models/OrderRequest').countDocuments();
    await inbox.handle(mail({ from: 'someone@gmail.com', subject: 'Order for 5000 m', body: 'Kindly supply 5000 m of 25mm white elastic. PO no 77' }));
    expect(await require('../../models/OrderRequest').countDocuments()).toBe(before);
    const m = await InboxMail.findOne({ from: 'someone@gmail.com' }).lean();
    expect(m).toMatchObject({ status: 'new', kind: 'purchase_order', note: expect.stringMatching(/not matched to a customer/) });
  });
});

describe('a complaint by mail', () => {
  it('opens a complaint when the job it is about is clear', async () => {
    mockIntake.mockResolvedValue({ category: 'shade', reason: 'Shade differs from the last lot', jobs: [{ _id: job, jobOrderNo: 812, why: 'Delivered last week' }], elastic: null, aiGenerated: true, confidence: 0.8, aiSuggestion: 'ai2' });
    const r = await inbox.handle(mail({ subject: 'Complaint - shade variation', body: 'The shade of the last supply is different, rejected by our customer.' }));
    expect(r.kind).toBe('complaint');
    const c = await require('../../models/Complaints').findOne({ customer: customer._id }).lean();
    expect(c).toMatchObject({ category: 'shade', status: 'Open' });
    expect(String(c.job)).toBe(String(job));
  });

  it('keeps the draft when the job is not clear', async () => {
    mockIntake.mockResolvedValue({ category: 'other', reason: 'Quality issue', jobs: [], elastic: null });
    const r = await inbox.handle(mail({ subject: 'Quality problem', body: 'We have a quality issue with your elastic.' }));
    expect(r.status).toBe('new');
  });
});

describe('a payment advice and an enquiry by mail', () => {
  it('reads the advice and places it on the books for accounts', async () => {
    mockAdvice.mockResolvedValue({ amount: 84000, lines: [{ invoiceNo: 'INV-101' }] });
    mockPlace.mockResolvedValue({ allocations: [{ docType: 'Invoice', docNo: 'INV-101' }], adjustments: [] });
    await inbox.handle(mail({ from: 'accounts@tirupurknits.in', subject: 'Payment advice', body: 'We have paid Rs 84,000 by NEFT UTR HDFC123456 against INV-101' }));
    const m = await InboxMail.findOne({ subject: 'Payment advice' }).lean();
    expect(m.kind).toBe('payment_advice');
    expect(m.note).toMatch(/₹84,000 against 1 document/);
    expect(mockPlace).toHaveBeenCalledWith(expect.anything(), { customer: customer._id });
  });

  it('drafts a quote from an enquiry', async () => {
    mockQuote.mockResolvedValue({ read: { lines: [] }, customer, lines: [{ elastic: 'e1' }], coverNote: 'Dear Raj' });
    await inbox.handle(mail({ subject: 'Enquiry for rates', body: 'Please send your best rates for 30mm knitted elastic.' }));
    const m = await InboxMail.findOne({ subject: 'Enquiry for rates' }).lean();
    expect(m).toMatchObject({ kind: 'enquiry', note: expect.stringMatching(/Quote drafted — 1 line/) });
  });
});

describe('the inbox', () => {
  it('reads each mail once', async () => {
    const m = mail({ subject: 'Hello', body: 'Thanks for the visit' });
    expect((await inbox.handle(m)).status).toBe('new');
    expect((await inbox.handle(m)).status).toBe('known');
  });

  it('lists the mail for accounts, and lets it be dismissed', async () => {
    const list = await request(app).get('/api/v2/accounts/customer-mail').set('Cookie', cookie());
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBeGreaterThan(3);
    const one = list.body.rows.find((r) => r.subject === 'Hello');
    const res = await request(app).post(`/api/v2/accounts/customer-mail/${one._id}/dismiss`).set('Cookie', cookie());
    expect(res.body.mail.status).toBe('dismissed');
  });
});

describe('nothing is filed under a guess', () => {
  const Complaint = () => require('../../models/Complaints');
  const complaintsNow = () => Complaint().countDocuments({});
  const jobRow = (no, over = {}) => ({ _id: String(new mongoose.Types.ObjectId()), jobOrderNo: no, date: new Date('2026-10-12'), status: 'completed', elastics: [], why: 'job of 12 Oct 2026, completed', ...over });

  it('a complaint read without the model lists the newest jobs, not the one it is about: kept for a person', async () => {
    const before = await complaintsNow();
    // What services/complaintIntake.js answers with no model (or when the model fails): keywords and dates.
    mockIntake.mockResolvedValue({ category: 'shade', reason: 'Shade differs', jobs: [jobRow(901), jobRow(900), jobRow(899)], elastic: null, confidence: 0.3, aiGenerated: false, aiSuggestion: null });
    const r = await inbox.handle(mail({ subject: 'Complaint: shade', body: 'Shade variation in the last supply, rejected.' }));
    expect(r).toMatchObject({ kind: 'complaint', status: 'new' });
    expect(await complaintsNow()).toBe(before);
    const m = await InboxMail.findOne({ subject: 'Complaint: shade' }).lean();
    expect(m.note).toMatch(/not clear/);
    expect(m.complaint).toBeNull();
    expect(m.draft.jobs).toHaveLength(3);
  });

  it('…unless they named an elastic only one of those jobs carries', async () => {
    const before = await complaintsNow();
    const e = { _id: String(new mongoose.Types.ObjectId()), name: '25mm Black Knitted' };
    const only = jobRow(905, { elastics: [e], why: 'carries 25mm Black Knitted' });
    mockIntake.mockResolvedValue({ category: 'shade', reason: 'Shade differs on 25mm black', jobs: [only, jobRow(904), jobRow(903)], elastic: e, confidence: 0.3, aiGenerated: false, aiSuggestion: null });
    const r = await inbox.handle(mail({ subject: 'Complaint: 25mm black shade', body: 'Shade variation in 25mm Black Knitted, rejected.' }));
    expect(r).toMatchObject({ kind: 'complaint', status: 'done' });
    expect(await complaintsNow()).toBe(before + 1);
    expect(String((await Complaint().findOne({}).sort({ _id: -1 }).lean()).job)).toBe(only._id);
    // Two of them carry it: which one is not clear.
    mockIntake.mockResolvedValue({ category: 'shade', reason: 'x', jobs: [only, jobRow(906, { elastics: [e] }), jobRow(903)], elastic: e, confidence: 0.3, aiGenerated: false, aiSuggestion: null });
    expect(await inbox.handle(mail({ subject: 'Complaint: 25mm black again', body: 'Shade variation in 25mm Black Knitted, rejected.' }))).toMatchObject({ status: 'new' });
    expect(await complaintsNow()).toBe(before + 1);
  });

  it('the model naming several jobs, unsure, is for a person; one job, or sure of the first, is filed', async () => {
    const before = await complaintsNow();
    const two = [jobRow(910, { why: 'delivered last week' }), jobRow(909, { why: 'also 25mm' })];
    mockIntake.mockResolvedValue({ category: 'width', reason: 'Width short', jobs: two, elastic: null, confidence: 0.5, aiGenerated: true, aiSuggestion: 'ai5' });
    expect(await inbox.handle(mail({ subject: 'Complaint: width A', body: 'Width is short, quality issue.' }))).toMatchObject({ status: 'new' });
    expect(await complaintsNow()).toBe(before);
    mockIntake.mockResolvedValue({ category: 'width', reason: 'Width short', jobs: two, elastic: null, confidence: 0.9, aiGenerated: true, aiSuggestion: 'ai6' });
    expect(await inbox.handle(mail({ subject: 'Complaint: width B', body: 'Width is short, quality issue.' }))).toMatchObject({ status: 'done' });
    mockIntake.mockResolvedValue({ category: 'width', reason: 'Width short', jobs: [two[1]], elastic: null, confidence: 0.4, aiGenerated: true, aiSuggestion: 'ai7' });
    expect(await inbox.handle(mail({ subject: 'Complaint: width C', body: 'Width is short, quality issue.' }))).toMatchObject({ status: 'done' });
    expect(await complaintsNow()).toBe(before + 2);
  });

  it('a sender who is a contact of two customers is not taken for the first of them', async () => {
    // A buying house's merchandiser looks after two of our customers.
    const Customer = require('../../models/Customer');
    await Customer.collection.insertMany([
      { name: 'Alpha Exports', merchandiser: { name: 'Meena', email: 'meena@buyinghouse.in' } },
      { name: 'Beta Garments', merchandiser: { name: 'Meena', email: 'Meena@BuyingHouse.in' } },
    ]);
    expect(await inbox.customerForEmail('meena@buyinghouse.in')).toBeNull();
    mockPoDoc.mockResolvedValue({ ok: true, draft: { lines: [{ elastic: 'x' }] }, aiSuggestionId: 'ai8' });
    const OrderRequest = require('../../models/OrderRequest');
    const before = await OrderRequest.countDocuments();
    const r = await inbox.handle(mail({ from: 'meena@buyinghouse.in', subject: 'Purchase Order 88', body: 'Please find our PO attached.', attach: 'PO-88.pdf' }));
    expect(r).toMatchObject({ kind: 'purchase_order', status: 'new' });
    expect(await OrderRequest.countDocuments()).toBe(before);
    const m = await InboxMail.findOne({ subject: 'Purchase Order 88' }).lean();
    expect(m.customer).toBeNull();
    expect(m.note).toMatch(/more than one customer/i);
    // One customer's own address is still theirs.
    expect((await inbox.customerForEmail('PURCHASE@tirupurknits.in')).name).toBe('Tirupur Knits');
  });
});

describe('sorting by keywords, when the model is off or slow', () => {
  it('a purchase order whose terms mention NEFT is an order, not a payment advice', () => {
    expect(inbox.keywordKind('Purchase Order 4512 attached. Payment by NEFT within 30 days of delivery.')).toBe('purchase_order');
    expect(inbox.keywordKind('PO No: 7781 — kindly supply. Our bank: RTGS only.')).toBe('purchase_order');
    // What a payment advice says is still one.
    expect(inbox.keywordKind('We have paid Rs 84,000 by NEFT against your PO 4512 invoice')).toBe('payment_advice');
    expect(inbox.keywordKind('Payment advice for purchase order 4512')).toBe('payment_advice');
    expect(inbox.keywordKind('UTR HDFC000123 dated 28 Oct for INV 701')).toBe('payment_advice');
    expect(inbox.keywordKind('Short supply against PO 4512, rolls damaged')).toBe('complaint');
  });
});

describe('a mail whose reading was cut short', () => {
  const env = { CUSTOMER_IMAP_HOST: 'imap.test', CUSTOMER_IMAP_USER: 'orders@balu.in', CUSTOMER_IMAP_PASS: 'x' };
  let box = [];
  beforeAll(() => { Object.assign(process.env, env); inbox.setFetcher(async (_c, { isKnown }) => { const out = []; for (const m of box) if (!(await isKnown(m.messageId))) out.push(m); return out; }); });
  afterAll(() => { for (const k of Object.keys(env)) delete process.env[k]; inbox.setFetcher(null); });
  const hourAgo = (messageId) => InboxMail.collection.updateOne({ messageId }, { $set: { updatedAt: new Date(Date.now() - 3_600_000) } });

  it('is read again by the next check — not while another server may still be on it', async () => {
    const m = mail({ subject: 'Purchase Order 4600', body: 'Please find our PO attached.', attach: 'PO-4600.pdf' });
    box = [m];
    mockPoDoc.mockResolvedValue({ ok: true, draft: { lines: [{ elastic: 'x' }] }, aiSuggestionId: 'ai9' });
    // Another server claimed it a moment ago and is reading it.
    await InboxMail.create({ messageId: m.messageId, from: 'purchase@tirupurknits.in', subject: 'Purchase Order 4600' });
    expect(await inbox.run()).toMatchObject({ ran: true, mails: 0 });
    expect((await InboxMail.findOne({ messageId: m.messageId }).lean()).status).toBe('reading');
    // …it was restarted and never finished: nobody would ever see this order.
    await hourAgo(m.messageId);
    expect(await inbox.run()).toMatchObject({ ran: true, mails: 1 });
    const read = await InboxMail.findOne({ messageId: m.messageId }).lean();
    expect(read).toMatchObject({ status: 'done', kind: 'purchase_order', customerName: 'Tirupur Knits' });
    expect(read.orderRequest).toBeTruthy();
    expect(await InboxMail.countDocuments({ messageId: m.messageId })).toBe(1);
    // Read: not read a third time.
    expect(await inbox.run()).toMatchObject({ mails: 0 });
  });

  it('cut short a second time, it is not tried again: a person is shown it', async () => {
    const m = mail({ subject: 'Purchase Order 4601', body: 'Please find our PO attached.', attach: 'PO-4601.pdf' });
    box = [m];
    await InboxMail.create({ messageId: m.messageId, from: 'purchase@tirupurknits.in', subject: 'Purchase Order 4601' });
    await hourAgo(m.messageId);
    // The second reading never comes back either (the reader hangs; the server is restarted).
    mockPoDoc.mockImplementation(() => new Promise(() => {}));
    const hung = inbox.handle(m); hung.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    expect((await InboxMail.findOne({ messageId: m.messageId }).lean())).toMatchObject({ status: 'reading', readings: 2 });
    await hourAgo(m.messageId);
    mockPoDoc.mockReset();
    expect(await inbox.run()).toMatchObject({ mails: 0 });
    expect(mockPoDoc).not.toHaveBeenCalled();
    const shown = await InboxMail.findOne({ messageId: m.messageId }).lean();
    expect(shown.status).toBe('new');
    expect(shown.note).toMatch(/could not be read/i);
    const list = await request(app).get('/api/v2/accounts/customer-mail').set('Cookie', cookie());
    expect(list.body.rows.some((r) => r.subject === 'Purchase Order 4601')).toBe(true);
  });
});

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
    mockIntake.mockResolvedValue({ category: 'shade', reason: 'Shade differs from the last lot', jobs: [{ _id: job, jobOrderNo: 812, why: 'Delivered last week' }], elastic: null, aiSuggestion: 'ai2' });
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

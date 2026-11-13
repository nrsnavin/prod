'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY PHOTO SENT TO THE WHATSAPP NUMBER, SORTED
//  (services/whatsappPapers.js, through the real webhook)
//
//  A slip still goes to the slip reader; a bill to the bills inbox; a
//  cheque is read and kept to be entered; a customer's photo can only be
//  an order, an advice, a cheque or other. A wrong sort is put right by
//  a reply, setting aside what the first sort made. The model is a
//  stand-in: these pin what is done with what it says.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.PUBLIC_BASE_URL = 'https://erp.example.com';

const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));
const mockReadBill = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockReadBill(...a), SUPPORTED: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) }));
let mockClient = null;
let mockSort = 'other';
let mockCheque = {};
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClient, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const bizDates = require('../../utils/bizDates');

let mongo, app, M, svc, slips, admin, lead, clerk, sunrise, kotak;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const LEAD = '+919100000001';
const CLERK = '+919100000003';
const OWNER = '+919800000000';
const CUSTOMER = '+919840011111';
const iso = (d) => d.toISOString().slice(0, 10);

function sign(params) {
  let data = 'https://erp.example.com/api/v2/notify/incoming';
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', 'tok').update(data, 'utf8').digest('base64');
}
const send = (params) => request(app).post('/api/v2/notify/incoming').set('X-Twilio-Signature', sign(params)).type('form').send(params);
const replyOf = (res) => res.text.replace(/^.*<Message>|<\/Message>.*$/gs, '').replace(/&apos;/g, "'");
let sid = 0;
const photo = (from, Body = '', type = 'image/jpeg') => {
  sid += 1;
  return send({ From: `whatsapp:${from}`, Body, NumMedia: '1', MessageSid: `SM-P${sid}`, MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/AC/Messages/SM-P${sid}/Media/ME1`, MediaContentType0: type });
};
const text = (from, Body) => { sid += 1; return send({ From: `whatsapp:${from}`, Body, NumMedia: '0', MessageSid: `SM-T${sid}` }); };
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const lastPaper = () => M.WhatsAppPaper.findOne({}).sort({ createdAt: -1, _id: -1 }).lean();
const sortLast = async () => { const p = await lastPaper(); await svc.sortJob(p._id); return M.WhatsAppPaper.findById(p._id).lean(); };

const reading = (over = {}) => ({
  kind: 'bill', problem: null, supplierName: 'Sri Yarn Traders', supplierGstin: '33AAAPS0001F1Z5', billNo: 'SY/118', billDate: '2026-10-20', dueDate: null,
  lines: [{ description: 'Nylon 70D', hsn: '5402', quantity: 60, unit: 'kg', rate: 310, gstPercent: 5, amount: 18600, confidence: 0.9 }],
  totals: { taxable: 18600, cgst: 465, sgst: 465, igst: 0, grand: 19530 }, confidence: 0.9, model: 'test-vision', usage: {}, latencyMs: 5, ...over,
});
function modelReply({ messages }) {
  const prompt = messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  let out;
  if (prompt.includes('Say what paper it is')) out = { kind: mockSort, summary: `looks like ${mockSort}` };
  else if (prompt.includes('CTS-2010 cheque')) {
    out = { problem: null, chequeNo: '004512', date: iso(bizDates.today()), amount: 19530, amountWords: 'Rupees Nineteen Thousand Five Hundred Thirty Only', payee: 'Balu Elastics', drawer: 'SUNRISE GARMENTS PVT LTD', bankName: 'HDFC Bank', branch: 'Tiruppur', ifsc: 'HDFC0001234', micr: '004512 641240002', accountNo: '', crossed: true, signed: true, ...mockCheque };
  } else out = { problem: 'unreadable' };
  return Promise.resolve({ stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify(out) }] });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  svc = require('../../services/whatsappPapers');
  slips = require('../../services/slipIngest');
  M = {};
  for (const n of ['User', 'Employee', 'Customer', 'Supplier', 'WhatsAppPaper', 'SlipIngest', 'SlipPhoto', 'InboxBill', 'InboxMail', 'Outbox', 'AiSuggestion', 'NotificationSettings', 'Payment']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'wa-admin@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const e1 = await M.Employee.create({ name: 'Floor Lead', phoneNumber: '9100000001', department: 'weaving' });
  lead = await M.User.create({ name: 'Floor Lead', email: 'wa-lead@t.co', password: 'pass1234', role: 'production', department: 'production', employee: e1._id });
  const e3 = await M.Employee.create({ name: 'Clerk', phoneNumber: '9100000003', department: 'accounts' });
  clerk = await M.User.create({ name: 'Clerk', email: 'wa-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance', employee: e3._id });
  const s = await M.NotificationSettings.load();
  s.recipients = [OWNER];
  await s.save();
  sunrise = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9840011111', gstin: '33AAEPS1001F1Z2' });
  await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode', email: 'accounts@sriyarn.in' });
  await get('/accounts/bank-accounts');
  kotak = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 0, isDefault: true })).body.account;
  jest.spyOn(slips, 'downloadMedia').mockImplementation(async (media) => media.map((m) => ({ buffer: JPEG, mimetype: m.contentType || 'image/jpeg' })));
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  mockSend.mockClear();
  mockReadBill.mockReset();
  mockClient = { messages: { create: jest.fn(modelReply) } };
  mockSort = 'other';
  mockCheque = {};
});

describe('a photo is sorted, and handed to the reader for what it is', () => {
  it('a production login\'s photo with no caption: answered at once, sorted later; a slip goes to the slip reader', async () => {
    const res = await photo(LEAD);
    const paper = await lastPaper();
    expect(replyOf(res)).toBe(`Got it (${paper.code}). I'll work out what it is and reply in a minute or two.`);
    expect(paper).toMatchObject({ who: 'staff', status: 'received', mayRecordSlips: true, sentByName: 'Floor Lead' });
    expect(await M.Outbox.exists({ kind: 'paper.sort', 'payload.paperId': String(paper._id) })).toBeTruthy();

    mockSort = 'production_slip';
    const sorted = await sortLast();
    expect(sorted).toMatchObject({ status: 'done', kind: 'production_slip', kindBy: 'model', sentTo: { doc: 'SlipIngest' } });
    const slip = await M.SlipIngest.findById(sorted.sentTo.docId).lean();
    expect(slip).toMatchObject({ source: 'whatsapp', from: LEAD, sentByName: 'Floor Lead', pages: 1 });
    expect(String(slip.sentBy)).toBe(String(lead._id));
    expect(await M.SlipPhoto.countDocuments({ slip: slip._id })).toBe(1);
    expect(await M.Outbox.exists({ kind: 'slip.read', 'payload.slipId': String(slip._id) })).toBeTruthy();
    // The slip reader tells the sender what it read; the sorter says nothing over it.
    expect(mockSend).not.toHaveBeenCalled();
    // The photo is kept on the paper, and the second fetch never happens.
    expect((await M.WhatsAppPaper.findById(sorted._id).select('+files +media').lean())).toMatchObject({ media: [], files: [{ contentType: 'image/jpeg', size: JPEG.length }] });
  });

  it('a bill: the caption says so; it waits in the bills inbox, and the sender is told where', async () => {
    mockReadBill.mockResolvedValue(reading());
    await photo(CLERK, 'Sri yarn bill');
    const sorted = await sortLast();
    expect(sorted).toMatchObject({ status: 'done', kind: 'supplier_bill', kindBy: 'caption', sentTo: { doc: 'InboxBill' } });
    expect(mockClient.messages.create).not.toHaveBeenCalled();
    const ib = await M.InboxBill.findById(sorted.sentTo.docId).lean();
    expect(ib).toMatchObject({ status: 'new', source: 'whatsapp', from: CLERK, sentByName: 'Clerk', supplierName: 'Sri Yarn Traders', grand: 19530 });
    expect(String(ib.paper)).toBe(String(sorted._id));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe(CLERK);
    expect(mockSend.mock.calls[0][1]).toMatch(/^Bill from Sri Yarn Traders #SY\/118, ₹19,530 is in Accounts → Bills by mail, (ready to enter|needs a look: .+)\.$/);
    const listed = (await get('/accounts/bill-inbox')).body.bills.find((b) => String(b._id) === String(ib._id));
    expect(listed).toMatchObject({ source: 'whatsapp', sentByName: 'Clerk' });
  });

  it('a cheque from the owner: read and kept to enter; the receipt posted from it closes it', async () => {
    mockSort = 'cheque';
    await photo(OWNER);
    const sorted = await sortLast();
    expect(sorted).toMatchObject({ status: 'waiting', kind: 'cheque', kindBy: 'model', result: { customer: { name: 'Sunrise Garments' }, draft: { amount: 19530, mode: 'cheque', cheque: { number: '004512' } } } });
    expect(mockSend.mock.calls[0][1]).toBe(`Cheque 004512 from Sunrise Garments for ₹19,530, dated ${iso(bizDates.today()).split('-').reverse().join('/')}: ready to enter as a receipt in Accounts → Inbox.`);

    const inbox = (await get('/accounts/inbox')).body.whatsappPapers;
    expect(inbox).toMatchObject({ count: 1, top: [{ kind: 'cheque', label: 'Cheque from Sunrise Garments', amount: 19530, code: sorted.code }] });
    const listed = (await get('/accounts/whatsapp-papers')).body;
    expect(listed.papers.map((p) => p._id)).toContain(String(sorted._id));
    const file = await get(`/accounts/whatsapp-papers/${sorted._id}/file/0`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/image\/jpeg/);

    const { postDated, ...draft } = sorted.result.draft;
    const saved = await post('/accounts/payments', { ...draft, account: kotak._id, date: iso(bizDates.today()), paper: String(sorted._id), chequeSuggestion: sorted.result.aiSuggestion });
    expect(saved.status).toBe(201);
    const done = await M.WhatsAppPaper.findById(sorted._id).lean();
    expect(done).toMatchObject({ status: 'done', entered: { doc: 'Payment', label: saved.body.payment.voucherNo } });
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await M.AiSuggestion.findById(sorted.aiSuggestion).lean()).outcome).toBe('accepted');
    // The same cheque sent again is named, not offered to be entered twice.
    await photo(OWNER);
    const again = await sortLast();
    expect(again).toMatchObject({ status: 'done', note: `Already entered as ${saved.body.payment.voucherNo}` });
  });

  it('a wrong sort is put right by a reply: the slip it made is dropped, the bill filed, the sort scored', async () => {
    mockSort = 'production_slip';
    await photo(LEAD);
    const first = await sortLast();
    const slipId = first.sentTo.docId;
    mockReadBill.mockResolvedValue(reading({ billNo: 'SY/119' }));
    const res = await text(LEAD, `bill ${first.code}`);
    expect(replyOf(res)).toMatch(/^Bill from Sri Yarn Traders #SY\/119, ₹19,530 is in Accounts → Bills by mail/);
    expect((await M.SlipIngest.findById(slipId).lean()).status).toBe('discarded');
    const now = await M.WhatsAppPaper.findById(first._id).lean();
    expect(now).toMatchObject({ kind: 'supplier_bill', kindBy: 'person', status: 'done', sentTo: { doc: 'InboxBill' } });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await M.AiSuggestion.findById(first.aiSuggestion).lean()).toMatchObject({ outcome: 'edited', editedFields: ['kind'] });
    // Not a number of ours, or not one of our people: said so, or an ordinary message.
    expect(replyOf(await text(LEAD, 'bill 0001'))).toBe('There is no photo numbered 0001 from this phone this week.');
    expect(replyOf(await text('+919999999999', `bill ${first.code}`))).toMatch(/not authorized to act on orders/);
  });

  it('something nobody can tell waits for a person, with how to send it on; IGNORE sets it aside', async () => {
    mockSort = 'other';
    await photo(CLERK);
    const p = await sortLast();
    expect(p).toMatchObject({ status: 'waiting', kind: 'other' });
    expect(mockSend.mock.calls[0][1]).toBe(`I could not tell what this is (${p.code}).\nReply with what it is: BILL ${p.code}, RECEIPT ${p.code}, CHEQUE ${p.code}, SLIP ${p.code}, DC ${p.code}, PO ${p.code} or PAID ${p.code}. IGNORE ${p.code} if it is not for us.`);
    // An accounts login's photo is never read as a production slip.
    expect(replyOf(await text(CLERK, `slip ${p.code}`))).toBe('A photo from this sender cannot be a production slip');
    expect(replyOf(await text(CLERK, `ignore ${p.code}`))).toBe(`Photo ${p.code} set aside. Nothing was entered from it.`);
    expect((await M.WhatsAppPaper.findById(p._id).lean()).status).toBe('dismissed');
  });

  it('on the web: sent on as a cheque, or set aside', async () => {
    mockCheque = { chequeNo: '009001', micr: '009001 641240002' };
    await photo(CLERK);
    const p = await sortLast();
    const routed = await post(`/accounts/whatsapp-papers/${p._id}/route`, { kind: 'cheque' });
    expect(routed.status).toBe(200);
    expect(routed.body.paper).toMatchObject({ kind: 'cheque', kindBy: 'person', status: 'waiting', result: { draft: { amount: 19530 } } });
    const gone = await post(`/accounts/whatsapp-papers/${p._id}/dismiss`, { reason: 'Duplicate photo' });
    expect(gone.body.paper).toMatchObject({ status: 'dismissed', note: 'Duplicate photo' });
    expect((await post(`/accounts/whatsapp-papers/${p._id}/route`, { kind: 'supplier_bill' })).status).toBe(409);
    expect((await post(`/accounts/whatsapp-papers/${p._id}/route`, { kind: 'nonsense' })).status).toBe(400);
  });
});

describe('who may send what', () => {
  it('a customer is thanked at once and never told more; their photo cannot be a slip', async () => {
    const res = await photo(CUSTOMER);
    expect(replyOf(res)).toBe('Thank you, we have received it. Our office will look at it.');
    mockSort = 'production_slip';
    const p = await sortLast();
    expect(p).toMatchObject({ who: 'customer', partyName: 'Sunrise Garments', kind: 'other', status: 'waiting' });
    expect(String(p.customer)).toBe(String(sunrise._id));
    expect(mockSend).not.toHaveBeenCalled();
    expect(svc.allowedFor(p)).toEqual(['purchase_order', 'payment_advice', 'cheque', 'other']);
  });

  it('a stranger, a voice note, more than a day\'s photos: each said plainly, nothing kept', async () => {
    expect(replyOf(await photo('+919999999999'))).toMatch(/is not set up to send production slips or bills here/);
    expect(replyOf(await photo(CLERK, '', 'audio/ogg'))).toBe('I can read photos and PDFs only. Send the paper as a photo or a PDF.');
    await M.WhatsAppPaper.insertMany(Array.from({ length: 15 }, (_, i) => ({ who: 'customer', from: CUSTOMER, code: String(2000 + i), status: 'dismissed' })));
    const before = await M.WhatsAppPaper.countDocuments({});
    expect(replyOf(await photo(CUSTOMER))).toBe('That is more photos than one phone may send in a day. Send the rest tomorrow, or upload them on the web.');
    expect(await M.WhatsAppPaper.countDocuments({})).toBe(before);
  });

  it('with no AI key, a production login\'s photo goes to the slip reader, as it always did; anyone else\'s waits', async () => {
    mockClient = null;
    await photo(LEAD);
    expect(await sortLast()).toMatchObject({ kind: 'production_slip', kindBy: 'fallback', status: 'done' });
    await photo(CLERK);
    expect(await sortLast()).toMatchObject({ kind: 'other', kindBy: 'fallback', status: 'waiting' });
  });

  it('a caption decides before the model; a slip caption from a slip sender skips the sorting altogether', async () => {
    expect(svc.captionKind('cheque from sunrise')).toBe('cheque');
    expect(svc.captionKind('DC for PO 118')).toBe('delivery_challan');
    expect(svc.captionKind('petrol')).toBe('expense_receipt');
    expect(svc.captionKind('Invoice')).toBe('supplier_bill');
    expect(svc.captionKind('NEFT done')).toBe('payment_advice');
    expect(svc.captionKind('see this')).toBeNull();
    expect(svc.isSlipCaption('NIGHT 06-10')).toBe(true);
    expect(svc.isSlipCaption('bill 06-10')).toBe(false);
    const res = await photo(LEAD, 'DAY 06-10-2026');
    expect(replyOf(res)).toMatch(/^Got it, reading slip \d{4}\./);
    expect(await M.SlipIngest.exists({ caption: 'DAY 06-10-2026' })).toBeTruthy();
  });
});

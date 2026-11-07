'use strict';
// ══════════════════════════════════════════════════════════════════
//  ANSWERING A CUSTOMER ON WHATSAPP
//
//    • off (the default): a customer's message is a payment reply, as before
//    • on: "where is my order" is answered from the order and its
//      challans; "send statement" with what is due; "invoice 1182 again"
//      with that invoice (the office told to send the copy); a typed
//      order drafted into a WhatsApp order the office opens or dismisses;
//      "will pay by 15th" still a payment reply; anything else to the office
//    • the answer comes from the records; nothing is ordered or changed
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));
// The model: unsure when sorting (keywords stand), and reads a typed order like a PO.
const mockCreate = jest.fn(async ({ messages }) => {
  const text = JSON.stringify(messages);
  if (text.includes('This order came as a WhatsApp message')) {
    return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({
      sourceType: 'whatsapp_chat', poNumber: 'SG/PO/91', deliveryDate: '2026-11-20', confidence: 0.9,
      lines: [{ description: '25mm Knitted Elastic Black', quantity: 2000, unit: 'm' }, { description: '40mm Woven White', quantity: 1500, unit: 'm' }],
    }) }] };
  }
  return { content: [{ type: 'text', text: '{}' }], usage: {} };
});
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }), TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, customer, el25;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const incoming = (Body, from = '+919840011111') => request(app).post('/api/v2/notify/incoming').type('form').send({ From: `whatsapp:${from}`, Body });
const said = (res) => (String(res.text).match(/<Message>([\s\S]*?)<\/Message>/)?.[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const OFFICE = '+919800000000';
const DAY = 86_400_000;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'Order', 'Elastic', 'DeliveryChallan', 'NotificationSettings', 'OrderRequest', 'CollectionNote']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ca@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await M.NotificationSettings.create({ recipients: [OFFICE] });
  customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'Ravi', phoneNumber: '9840011111', gstin: '33AAEPS1001F1Z2' });
  el25 = await M.Elastic.create({ name: '25mm Knitted Elastic Black', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 0, hsn: '5806', gstPercent: 5 });
  const order = await M.Order.create({ customer: customer._id, po: 'SG/PO/88', date: new Date(Date.now() - 10 * DAY), supplyDate: new Date(Date.now() + 5 * DAY), status: 'InProgress',
    elasticOrdered: [{ elastic: el25._id, quantity: 5000, rate: 4 }], pendingElastic: [{ elastic: el25._id, quantity: 2000 }] });
  await M.DeliveryChallan.create({ dcNumber: 'E-26/27-0012', type: 'elastic', financialYear: '26/27', sequence: 12, order: order._id, orderNo: order.orderNo, customerName: customer.name, status: 'dispatched', dispatchDate: new Date(Date.now() - 2 * DAY), items: [{ elastic: el25._id, elasticName: el25.name, unit: 'm', quantity: 3000, rate: 0 }], totalQuantity: 3000 });
  await M.Invoice.create({ invoiceNumber: 'INV/2026-27/1182', financialYear: '2026-27', sequence: 1182, invoiceDate: new Date(Date.now() - 40 * DAY), dueDate: new Date(Date.now() - 10 * DAY), order: order._id, customer: customer._id, buyer: { name: customer.name }, supplyType: 'intra', lines: [], totals: { taxable: 50000, grand: 52500 }, status: 'issued', paidAmount: 2500 });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => mockSend.mockClear());

describe('a customer on WhatsApp', () => {
  it('off: read as a payment reply, as before', async () => {
    const res = await incoming('where is my order?');
    expect(res.status).toBe(200);
    expect(said(res)).toBe('');
    expect(await M.CollectionNote.countDocuments({ kind: 'reply' })).toBe(1);
  });

  it('on: where their order is, from the order and its challans', async () => {
    expect((await put('/accounts/settings', { collections: { assistant: true } })).status).toBe(200);
    const res = await incoming('Hi, where is my order? When will it be sent');
    const text = said(res);
    expect(text).toMatch(/Sunrise Garments — your order:/);
    expect(text).toMatch(/Order #\d+ \(your PO SG\/PO\/88\): in production, due \d{2} \w{3,4} — 3,000 of 5,000 m sent, last on \d{2} \w{3,4} \(E-26\/27-0012\)/);
    // By their PO, too.
    expect(said(await incoming('PO SG/PO/88 status?'))).toMatch(/your PO SG\/PO\/88/);
    // A number not on file: said so, and the office told.
    const none = said(await incoming('status of order #9999'));
    expect(none).toMatch(/could not find order #9999/);
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(/asked about order #9999, which is not on file/), expect.anything());
  });

  it('on: what is due, and an invoice they name; the office is told to send the copies', async () => {
    const st = said(await incoming('please send statement'));
    expect(st).toMatch(/INV\/2026-27\/1182 dated \d{2} \w{3,4}: ₹50,000 — \d+ days past due/);
    expect(st).toMatch(/Total due ₹50,000, of which ₹50,000 is past due/);
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(/asked for their statement/), expect.anything());
    const inv = said(await incoming('send invoice 1182 copy again'));
    expect(inv).toMatch(/Invoice INV\/2026-27\/1182 dated \d{2} \w{3,4} for ₹52,500 — ₹50,000 still due/);
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(/asked for a copy of INV\/2026-27\/1182/), expect.anything());
  });

  it('on: a typed order is drafted for the office, which opens it as an order or dismisses it', async () => {
    const res = await incoming('Need 2000 m 25mm black and 1500 m 40mm white, deliver by 20th. PO SG/PO/91');
    expect(said(res)).toBe('Thank you — we have your order (2 items). Our team will confirm it shortly.');
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(/sent an order on WhatsApp \(2 lines read\)/), expect.anything());
    const list = (await get('/order/requests')).body;
    expect(list.count).toBe(1);
    const r = list.requests[0];
    expect(r).toMatchObject({ customerName: 'Sunrise Garments', status: 'new', draft: { poNumber: 'SG/PO/91', deliveryDate: '2026-11-20', customer: { customerId: String(customer._id), confident: true } } });
    expect(r.draft.lines.map((l) => [l.quantity, l.match.elasticName])).toEqual([[2000, '25mm Knitted Elastic Black'], [1500, null]]);
    // Nothing was ordered.
    expect(await M.Order.countDocuments({ po: 'SG/PO/91' })).toBe(0);
    // Opened as an order (made by a person), then marked.
    const order = await M.Order.create({ customer: customer._id, po: 'SG/PO/91', date: new Date(), supplyDate: new Date('2026-11-20'), status: 'Open', elasticOrdered: [{ elastic: el25._id, quantity: 2000, rate: 4 }] });
    expect((await post(`/order/requests/${r._id}/converted`, { order: order._id })).body.request).toMatchObject({ status: 'converted', orderNo: order.orderNo });
    expect((await post(`/order/requests/${r._id}/dismissed`, {})).status).toBe(409);
    expect((await get('/order/requests')).body.count).toBe(0);
  });

  it('on: a promise still goes to the payment reply; anything else to the office', async () => {
    await incoming('Will pay Rs 50,000 by 15th');
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(/promises to pay ₹50,000/), expect.anything());
    const hi = said(await incoming('Hello, is Mr. Kumar there?'));
    expect(hi).toBe('Thank you — our team will get back to you shortly.');
    expect(mockSend).toHaveBeenLastCalledWith(OFFICE, expect.stringMatching(/wrote on WhatsApp:\n"Hello, is Mr. Kumar there\?"/), expect.anything());
  });
});

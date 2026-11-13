'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CHEQUE PHOTO, INTO A RECEIPT OR A POST-DATED CHEQUE
//  (services/chequeIntake.js, utils/amountWords.js, POST /accounts/cheques/read)
//
//  The model only copies what is written; these pin what the server
//  checks — the figure against the words, the date, who it is made out
//  to — who it finds paid, a cheque already entered, and that the
//  receipt posted from it scores the read.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockCreate = jest.fn();
let mockClient = null;
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClient, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const { wordsToNumber } = require('../../utils/amountWords');
const intake = require('../../services/chequeIntake');
const bizDates = require('../../utils/bizDates');

let mongo, app, M, admin, kotak, sunrise;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const iso = (d) => d.toISOString().slice(0, 10);
const today = bizDates.today();
const plusDays = (n) => iso(new Date(today.getTime() + n * bizDates.DAY));

const reply = (over = {}) => ({
  stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 80 },
  content: [{ type: 'text', text: JSON.stringify({
    problem: null, chequeNo: '004512', date: iso(today), amount: 19530, amountWords: 'Rupees Nineteen Thousand Five Hundred Thirty Only',
    payee: 'BALU ELASTICS', drawer: 'SUNRISE GARMENTS PVT LTD', bankName: 'HDFC Bank', branch: 'Tiruppur', ifsc: 'HDFC0001234',
    micr: '004512 641240002 001234 29', accountNo: '50200012345678', crossed: true, signed: true, ...over,
  }) }],
});
const readCheque = (body = {}) => request(app).post('/api/v2/accounts/cheques/read').set('Cookie', cookie())
  .field(body).attach('files', JPEG, { filename: 'cheque.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Payment', 'BankAccount', 'BankAlias', 'AiSuggestion', 'DocumentSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cheques@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await M.DocumentSettings.findOneAndUpdate({ key: 'document' }, { $set: { companyName: 'Balu Elastics' } }, { upsert: true });
  require('../../services/documentSettings').invalidate();
  await get('/accounts/bank-accounts');
  kotak = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 0, isDefault: true })).body.account;
  sunrise = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9840011111', gstin: '33AAEPS1001F1Z2' });
  await M.Customer.create({ name: 'Lakshmi Tapes', contactName: 'L', phoneNumber: '9840022222', gstin: '33AAEPL1001F1Z2' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { mockCreate.mockReset(); mockClient = { messages: { create: mockCreate } }; });

describe('the amount in words', () => {
  it('reads Indian numbering: lakh, crore, paise, and the ways it is written', () => {
    expect(wordsToNumber('Rupees Nineteen Thousand Five Hundred Thirty Only')).toBe(19530);
    expect(wordsToNumber('Nineteen Thousand Five Hundred and Thirty Rupees Only')).toBe(19530);
    expect(wordsToNumber('Two Lakh Fifty Thousand Rupees and Fifty Paise Only')).toBe(250000.5);
    expect(wordsToNumber('Rupees One Lac Twenty-Five Thousand Only')).toBe(125000);
    expect(wordsToNumber('One Crore Twenty Lakhs Only')).toBe(12000000);
    expect(wordsToNumber('Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise')).toBe(1234567.89);
  });
  it('a word it does not know is "cannot check", never a number', () => {
    expect(wordsToNumber('Rupees Nineteen Thousand Five Hundred Thrity Only')).toBeNull();
    expect(wordsToNumber('')).toBeNull();
  });
});

describe('the checks, by the server', () => {
  const base = { problem: null, chequeNo: '004512', date: iso(today), amount: 19530, amountWords: 'Rupees Nineteen Thousand Five Hundred Thirty Only', payee: 'Balu Elastics', micr: '004512 641240002', signed: true };
  const codes = (read) => intake.checkCheque({ ...base, ...read }, { today, firmName: 'Balu Elastics' }).map((c) => `${c.code}:${c.severity}`);
  it('a clean cheque has nothing to say', () => {
    expect(codes({})).toEqual([]);
  });
  it('words that disagree with the figure stop it; words it cannot read ask a person', () => {
    const [w] = intake.checkCheque({ ...base, amountWords: 'Rupees Nineteen Thousand Only' }, { today, firmName: 'Balu Elastics' });
    expect(w).toMatchObject({ code: 'WORDS', severity: 'danger', message: 'The words say ₹19,000; the figure says ₹19,530. A bank pays neither until they agree' });
    expect(codes({ amountWords: 'Rupees Ninteen Thosand' })).toEqual(['WORDS:warning']);
  });
  it('dated ahead is a post-dated cheque; more than three months old the bank will not pay', () => {
    expect(codes({ date: plusDays(10) })).toEqual(['POST_DATED:info']);
    expect(codes({ date: iso(intake.monthsBefore(today, 4)) })).toEqual(['STALE:danger']);
    expect(codes({ date: iso(new Date(intake.monthsBefore(today, 3).getTime() + bizDates.DAY)) })).toEqual([]);
  });
  it('made out to someone else, unsigned, a number that differs from the MICR line', () => {
    expect(codes({ payee: 'Sri Murugan Tex' })).toEqual(['PAYEE:warning']);
    expect(codes({ payee: 'M/s. BALU ELASTICS' })).toEqual([]);
    expect(codes({ signed: false })).toEqual(['UNSIGNED:warning']);
    expect(codes({ micr: '004513 641240002' })).toEqual(['MICR:warning']);
    expect(codes({ amount: null })).toContain('NO_AMOUNT:danger');
  });
});

describe('a cheque photo read into a receipt', () => {
  it('finds who paid by name, and opens a cheque receipt dated today', async () => {
    mockCreate.mockResolvedValue(reply());
    const res = await readCheque();
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ _id: String(sunrise._id), name: 'Sunrise Garments', matchedBy: 'name' });
    expect(res.body.checks).toEqual([]);
    expect(res.body.duplicate).toBeNull();
    expect(res.body.draft).toMatchObject({ kind: 'receipt', partyType: 'customer', customer: String(sunrise._id), amount: 19530, mode: 'cheque', reference: '004512', cheque: { number: '004512', bank: 'HDFC Bank, Tiruppur', date: iso(today) }, postDated: false });
    expect(mockCreate.mock.calls[0][0].model).toBe('test-vision');
    expect(await M.AiSuggestion.countDocuments({ surface: 'cheque-receipt-ocr' })).toBe(1);
  });

  it('a payer the bank lines taught wins over the name; two names alike are not guessed between', async () => {
    await M.BankAlias.create({ text: 'R K TRADING', direction: 'in', partyType: 'customer', party: sunrise._id, partyName: 'Sunrise Garments' });
    mockCreate.mockResolvedValueOnce(reply({ drawer: 'R K TRADING CO' }));
    expect((await readCheque()).body.customer).toMatchObject({ name: 'Sunrise Garments', matchedBy: 'payer' });
    await M.Customer.create({ name: 'Sunrise Garments Unit', contactName: 'S', phoneNumber: '9840033333', gstin: '33AAEPS1002F1Z2' });
    mockCreate.mockResolvedValueOnce(reply({ drawer: 'SUNRISE GARMENTS' }));
    const both = (await readCheque()).body;
    expect(both.customer).toBeNull();
    expect(both.draft.partyName).toBe('SUNRISE GARMENTS');
    // The person picked who paid: that stands.
    mockCreate.mockResolvedValueOnce(reply({ drawer: 'SUNRISE GARMENTS' }));
    expect((await readCheque({ customer: String(sunrise._id) })).body.customer).toMatchObject({ _id: String(sunrise._id), matchedBy: 'picked' });
    await M.BankAlias.deleteMany({});
    await M.Customer.deleteOne({ name: 'Sunrise Garments Unit' });
  });

  it('dated ahead: a post-dated cheque, which the receipt route holds in hand until its date', async () => {
    mockCreate.mockResolvedValue(reply({ date: plusDays(12), chequeNo: '004600', micr: '004600 641240002' }));
    const r = (await readCheque()).body;
    expect(r.draft.postDated).toBe(true);
    expect(r.checks.map((c) => c.code)).toEqual(['POST_DATED']);
    const { postDated, ...body } = r.draft;
    const saved = await post('/accounts/payments', { ...body, account: kotak._id, date: iso(today), chequeSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    expect(saved.body.payment.cheque).toMatchObject({ number: '004600', status: 'held' });
    expect(iso(new Date(saved.body.payment.cheque.date))).toBe(plusDays(12));
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await M.AiSuggestion.findById(r.aiSuggestion).lean()).outcome).toBe('accepted');
    // On the PDC register, with the cheques held.
    expect((await get('/accounts/pdc?status=held')).body.rows.map((x) => x.cheque.number)).toContain('004600');
  });

  it('the same cheque entered already is named; a corrected amount scores the read as edited', async () => {
    mockCreate.mockResolvedValue(reply({ chequeNo: '004700', micr: '004700 1', amount: 5000, amountWords: 'Rupees Five Thousand Only' }));
    const r = (await readCheque()).body;
    const { postDated, ...body } = r.draft;
    const saved = await post('/accounts/payments', { ...body, amount: 5500, account: kotak._id, date: iso(today), chequeSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await M.AiSuggestion.findById(r.aiSuggestion).lean()).toMatchObject({ outcome: 'edited', editedFields: ['amount'] });
    mockCreate.mockResolvedValue(reply({ chequeNo: '004700', micr: '004700 1', amount: 5500, amountWords: 'Rupees Five Thousand Five Hundred Only' }));
    expect((await readCheque()).body.duplicate).toMatchObject({ voucherNo: saved.body.payment.voucherNo, amount: 5500 });
  });

  it('not a cheque, or no AI key: said plainly', async () => {
    mockCreate.mockResolvedValue({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: '{"problem":"not_a_cheque"}' }] });
    expect((await readCheque()).body).toMatchObject({ read: { problem: 'not_a_cheque' }, draft: null });
    mockClient = null;
    const res = await readCheque();
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Reading cheques is not set up on this server: type the details in.');
    expect((await request(app).post('/api/v2/accounts/cheques/read').set('Cookie', cookie())).status).toBe(400);
  });
});

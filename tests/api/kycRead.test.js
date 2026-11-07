'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK DETAILS FROM A CANCELLED CHEQUE; AN EMPLOYEE FROM THEIR ID
//
//    • a cheque reads into account, IFSC and holder, and says whether the
//      holder is the supplier's name; saved from it, the supplier's bank
//      remembers it came from a cheque — and the payment check, when the
//      account changed lately, says so (or that the holder is NOT theirs)
//    • an Aadhaar / PAN card reads into the employee form; the Aadhaar's
//      check digit is tested; the accuracy record keeps its last four only
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 10, output_tokens: 10 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supplier;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const send = (url) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).attach('files', photo, { filename: 'x.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'kyc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode', phoneNumber: '9840000000', bank: { accountNo: '501001234567', ifsc: 'HDFC0001234' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a cancelled cheque', () => {
  it('reads the account and says whether the holder is the supplier', async () => {
    mockReply = { problem: null, accountNo: '9988 7766 55', ifsc: 'icic0000999', bankName: 'ICICI Bank', branch: 'Erode', holder: 'SRI YARN TRADERS' };
    const ok = await send('/supplier/read-cheque?name=Sri%20Yarn%20Traders');
    expect(ok.body).toMatchObject({ read: { accountNo: '9988776655', ifsc: 'ICIC0000999', holder: 'SRI YARN TRADERS' }, holderMatches: true });
    // The accuracy record keeps the last four, not the account.
    const rec = await M.AiSuggestion.findOne({ surface: 'cheque-ocr' }).sort({ _id: -1 }).lean();
    expect(JSON.stringify(rec.proposed)).not.toContain('9988776655');
    expect(rec.proposed.accountLast4).toBe('6655');

    mockReply = { ...mockReply, holder: 'AMAZON PAY INDIA' };
    expect((await send('/supplier/read-cheque?name=Sri%20Yarn%20Traders')).body.holderMatches).toBe(false);
    mockReply = { problem: 'not_a_cheque' };
    expect((await send('/supplier/read-cheque')).body.read.problem).toBe('not_a_cheque');
  });

  it('saved from it, the change says so in the payment check', async () => {
    const put = (bank) => request(app).put('/api/v2/supplier/edit-supplier').set('Cookie', cookie()).send({ _id: String(supplier._id), bank });
    expect((await put({ accountNo: '9988776655', ifsc: 'ICIC0000999', holder: 'SRI YARN TRADERS', source: 'cheque', holderMatches: true })).status).toBe(200);
    const s = await M.Supplier.findById(supplier._id).lean();
    expect(s.bank).toMatchObject({ accountNo: '9988776655', source: 'cheque', holderMatches: true, previousAccountNo: '501001234567' });
    const { paymentFlags } = require('../../services/paymentChecks');
    let flags = await paymentFlags({ kind: 'payment', partyType: 'supplier', supplier: String(supplier._id), amount: 1000 });
    expect(flags.find((f) => f.code === 'BANK_CHANGED').message).toMatch(/— read from their cancelled cheque —/);
    // A cheque whose holder is someone else: said plainly.
    await M.Supplier.updateOne({ _id: supplier._id }, { $set: { 'bank.holderMatches': false } });
    flags = await paymentFlags({ kind: 'payment', partyType: 'supplier', supplier: String(supplier._id), amount: 1000 });
    expect(flags.find((f) => f.code === 'BANK_CHANGED').message).toMatch(/read from a cheque whose holder is NOT their name/);
  });
});

describe('an ID card', () => {
  it('reads the person, tests the Aadhaar check digit, and keeps only its last four on record', async () => {
    mockReply = { problem: null, kind: 'both', name: 'R. Murugan', dob: '1990-03-12', gender: 'Male', pan: 'abcde1234f', aadhaar: '4991 1866 5246' };
    const res = await send('/employee/read-id');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.read).toMatchObject({ name: 'R. Murugan', dob: '1990-03-12', gender: 'male', pan: 'ABCDE1234F', aadhaar: '499118665246', aadhaarValid: true, aadhaarLast4: '5246' });
    const rec = await M.AiSuggestion.findOne({ surface: 'id-card-ocr' }).lean();
    expect(JSON.stringify(rec.proposed)).not.toContain('499118665246');
    // A digit misread: the check digit fails.
    mockReply = { ...mockReply, aadhaar: '499118665247' };
    expect((await send('/employee/read-id')).body.read.aadhaarValid).toBe(false);
  });
});

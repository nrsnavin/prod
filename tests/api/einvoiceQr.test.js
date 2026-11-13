'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SUPPLIER'S E-INVOICE QR CODE ON THEIR BILL
//
//  The code holds what the GST portal signed: both GSTINs, the number,
//  date and total, the IRN. It is found in a photo or a PDF
//  (utils/qrImage.js), read (utils/einvoiceQr.js), its figures win over
//  the bill reader's, and a bill keeps its IRN: the same e-invoice is not
//  entered twice. Codes here are signed with a test key standing in for
//  a portal's.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const PDFKit = require('pdfkit');
const MailComposer = require('nodemailer/lib/mail-composer');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockRead = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockRead(...a), SUPPORTED: new Set(['image/png', 'image/jpeg', 'application/pdf']) }));
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const einv = require('../../utils/einvoiceQr');
const { qrTexts } = require('../../utils/qrImage');

const OURS = '33AAECB1234F1Z5';
const portal = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const IRN = 'f1d2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signedQr(over = {}, key = portal.privateKey) {
  const data = { SellerGstin: '33AAAPS0001F1Z5', BuyerGstin: OURS, DocNo: 'SY/118', DocTyp: 'INV', DocDt: '04/07/2026', TotInvVal: 19530, ItemCnt: 1, MainHsnCode: '5402', Irn: IRN, IrnDt: '2026-07-04 11:20:00', ...over };
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ data: JSON.stringify(data), iss: 'NIC' })}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}
const pdfWith = async (png) => {
  const doc = new PDFKit({ size: 'A4' }); const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r)); doc.text('TAX INVOICE  SY/118'); doc.image(png, 420, 60, { width: 120 }); doc.end(); await done;
  return Buffer.concat(chunks);
};

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const reading = (over = {}) => ({
  kind: 'bill', problem: null, supplierName: 'Sri Yarn Traders', supplierGstin: '33AAAPS0007F1Z5', billNo: 'SY/113', billDate: '2026-07-04', dueDate: null,
  lines: [{ description: 'Nylon 70D', hsn: '5402', quantity: 60, unit: 'kg', rate: 310, gstPercent: 5, amount: 18600, confidence: 0.9 }],
  totals: { taxable: 18600, cgst: 465, sgst: 465, igst: null, grand: 19530 }, confidence: 0.8, model: 'test-vision', usage: {}, latencyMs: 5, ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'SupplierBill', 'InboxBill']) M[n] = require(`../../models/${n}.js`);
  await M.SupplierBill.syncIndexes();
  admin = await M.User.create({ name: 'Owner', email: 'einvqr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: OURS, invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { einv.setKeys(null); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { einv.setKeys([]); mockRead.mockReset(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

describe('reading the code', () => {
  it('gives the portal\'s figures, the date as a day, and says the signature is not checked without a key', () => {
    const qr = einv.parseSignedQr(signedQr());
    expect(qr).toMatchObject({ sellerGstin: '33AAAPS0001F1Z5', buyerGstin: OURS, docNo: 'SY/118', docType: 'INV', docDate: '2026-07-04', value: 19530, itemCount: 1, mainHsn: '5402', irn: IRN, issuer: 'NIC' });
    expect(qr).toMatchObject({ signature: 'unchecked', signatureNote: 'No e-invoice portal key is installed on this server' });
  });

  it('verified by an installed portal key; another key leaves it unchecked, never "forged"', () => {
    einv.setKeys([{ name: 'irp1.pem', key: portal.publicKey }]);
    expect(einv.parseSignedQr(signedQr())).toMatchObject({ signature: 'verified', signatureNote: 'Signed by the key in irp1.pem' });
    expect(einv.parseSignedQr(signedQr({}, stranger.privateKey))).toMatchObject({ signature: 'unchecked', signatureNote: 'None of the installed portal keys signed it' });
    // A figure changed after signing does not verify.
    const [h, p, s] = signedQr().split('.');
    const altered = JSON.parse(Buffer.from(p, 'base64url').toString());
    altered.data = altered.data.replace('19530', '9530');
    expect(einv.parseSignedQr(`${h}.${b64(altered)}.${s}`).signature).toBe('unchecked');
  });

  it('anything else is not an e-invoice code', () => {
    expect(einv.parseSignedQr('upi://pay?pa=sriyarn@okaxis&am=19530')).toBeNull();
    expect(einv.parseSignedQr(`${b64({ alg: 'HS256' })}.${b64({ sub: 'someone', name: 'x'.repeat(80) })}.abc`)).toBeNull();
    expect(einv.parseSignedQr('')).toBeNull();
  });

  it('its figures replace what was read, and say where they differ', () => {
    const { read, notes } = einv.applyToRead(reading(), einv.parseSignedQr(signedQr({ TotInvVal: 19531 })), { ourGstin: OURS });
    expect(read).toMatchObject({ supplierGstin: '33AAAPS0001F1Z5', billNo: 'SY/118', billDate: '2026-07-04', totals: expect.objectContaining({ grand: 19531 }) });
    expect(notes.map((n) => n.code)).toEqual(['QR_GSTIN', 'QR_NUMBER']);
    const other = einv.applyToRead(reading(), einv.parseSignedQr(signedQr({ BuyerGstin: '29AAACZ9999F1Z1', DocTyp: 'CRN' })), { ourGstin: OURS });
    expect(other.notes.filter((n) => n.severity === 'danger').map((n) => n.message)).toEqual([
      `The e-invoice was issued to GSTIN 29AAACZ9999F1Z1, not ours (${OURS})`,
      'The e-invoice code is for a credit note, not an invoice',
    ]);
  });
});

describe('finding the code', () => {
  it('in a photo and in a PDF from billing software', async () => {
    const token = signedQr();
    const png = await QRCode.toBuffer(token, { errorCorrectionLevel: 'M', margin: 2, width: 700 });
    expect(await qrTexts({ buffer: png, mimetype: 'image/png' })).toEqual([token]);
    expect(await qrTexts({ buffer: await pdfWith(png), mimetype: 'application/pdf' })).toEqual([token]);
    expect(await qrTexts({ buffer: Buffer.from('%PDF-1.4 broken'), mimetype: 'application/pdf' })).toEqual([]);
    expect(await qrTexts({ buffer: Buffer.from('not a png'), mimetype: 'image/png' })).toEqual([]);
  });
});

describe('a bill with its e-invoice code', () => {
  let supplier;
  beforeEach(async () => { supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5' }); });

  it('scanned: the code the browser found settles the supplier, the number, the date and the total', async () => {
    mockRead.mockResolvedValue(reading());
    const png = await QRCode.toBuffer('not the code', { width: 200 });
    const res = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).field('qr', signedQr()).attach('files', png, { filename: 'bill.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    // The reader saw another GSTIN and number; the code is the portal's.
    expect(res.body.read).toMatchObject({ supplierGstin: '33AAAPS0001F1Z5', billNo: 'SY/118' });
    expect(res.body.supplier).toMatchObject({ name: 'Sri Yarn Traders', matchedBy: 'gstin' });
    expect(res.body.einvoice).toMatchObject({ irn: IRN, signature: 'unchecked', notes: [expect.objectContaining({ code: 'QR_GSTIN' }), expect.objectContaining({ code: 'QR_NUMBER' })] });
    expect(res.body.einvoiceQr).toBe(signedQr());
    // The ledger keeps what the reader saw, to measure it.
    expect((await require('../../models/AiSuggestion').findOne({ surface: 'bill-ocr' }).lean()).proposed.billNo).toBe('SY/113');
  });

  it('scanned as a PDF: the server finds the code itself', async () => {
    mockRead.mockResolvedValue(reading());
    const pdf = await pdfWith(await QRCode.toBuffer(signedQr(), { errorCorrectionLevel: 'M', margin: 2, width: 700 }));
    const res = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', pdf, { filename: 'SY-118.pdf', contentType: 'application/pdf' });
    expect(res.body.einvoice).toMatchObject({ irn: IRN, docNo: 'SY/118' });
  });

  it('saved: the IRN is kept, checked again on the server, and the same e-invoice is not entered twice', async () => {
    const lines = [{ description: 'Nylon 70D', quantity: 60, rate: 310, gstPercent: 5 }];
    const body = { supplier: supplier._id, supplierBillNo: 'SY/118', billDate: '2026-07-04', lines, einvoiceQr: signedQr() };
    const res = await post('/accounts/bills', body);
    expect(res.status).toBe(201);
    const bill = await M.SupplierBill.findById(res.body.bill._id).lean();
    expect(bill.einvoice).toMatchObject({ irn: IRN, signature: 'unchecked', value: 19530 });
    expect(bill.einvoice.docDate.toISOString().slice(0, 10)).toBe('2026-07-04');
    const again = await post('/accounts/bills', { ...body, supplierBillNo: 'SY/118-A', einvoiceQr: signedQr({ DocNo: 'SY/118-A' }) });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(`This e-invoice is already entered as ${bill.billNo}`);
    // A scan of the same code says it is entered.
    mockRead.mockResolvedValue(reading());
    const png = await QRCode.toBuffer('x', { width: 100 });
    const scan = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).field('qr', signedQr()).attach('files', png, { filename: 'b.png', contentType: 'image/png' });
    expect(scan.body.alreadyEntered).toBe(bill.billNo);
  });

  it('a code for another supplier, another bill number, or no code at all is refused', async () => {
    const lines = [{ description: 'Nylon 70D', quantity: 60, rate: 310, gstPercent: 5 }];
    const base = { supplier: supplier._id, supplierBillNo: 'SY/118', billDate: '2026-07-04', lines };
    const wrongSeller = await post('/accounts/bills', { ...base, einvoiceQr: signedQr({ SellerGstin: '33AAAPS0002F1Z5' }) });
    expect(wrongSeller.status).toBe(400);
    expect(wrongSeller.body.message).toBe("The e-invoice QR is GSTIN 33AAAPS0002F1Z5's, not Sri Yarn Traders's");
    const wrongNo = await post('/accounts/bills', { ...base, supplierBillNo: 'SY/119' , einvoiceQr: signedQr() });
    expect(wrongNo.body.message).toBe('The bill number differs from its e-invoice QR (SY/118)');
    expect((await post('/accounts/bills', { ...base, einvoiceQr: 'hello' })).status).toBe(400);
    expect(await M.SupplierBill.countDocuments()).toBe(0);
  });

  it('a cancelled bill gives up its IRN: the e-invoice can be entered again', async () => {
    const lines = [{ description: 'Nylon 70D', quantity: 60, rate: 310, gstPercent: 5 }];
    const body = { supplier: supplier._id, supplierBillNo: 'SY/118', billDate: '2026-07-04', lines, einvoiceQr: signedQr() };
    const first = await post('/accounts/bills', body);
    expect((await post(`/accounts/bills/${first.body.bill._id}/cancel`, { reason: 'Entered against the wrong PO' })).status).toBe(200);
    expect((await post('/accounts/bills', body)).status).toBe(201);
  });

  it('from the bills mailbox: the code in the PDF is kept and used when the bill is opened', async () => {
    const box = require('../../services/billMailbox');
    mockRead.mockResolvedValue(reading());
    const pdf = await pdfWith(await QRCode.toBuffer(signedQr(), { errorCorrectionLevel: 'M', margin: 2, width: 700 }));
    const raw = await new MailComposer({ from: 'accounts@sriyarn.in', to: 'bills@baluelastics.com', subject: 'Invoice', text: 'Attached.', messageId: '<q1@sriyarn.in>', attachments: [{ filename: 'SY-118.pdf', content: pdf, contentType: 'application/pdf' }] }).compile().build();
    await box.handle({ messageId: '<q1@sriyarn.in>', source: raw }, { ...box.config(), senders: [] });
    const item = await M.InboxBill.findOne({ part: 1 }).lean();
    expect(item.einvoiceQr).toBe(signedQr());
    expect(item.supplier).toEqual(supplier._id);
    const open = await get(`/accounts/bill-inbox/${item._id}`);
    expect(open.body.read).toMatchObject({ billNo: 'SY/118', supplierGstin: '33AAAPS0001F1Z5' });
    expect(open.body.einvoice).toMatchObject({ irn: IRN });
  });
});

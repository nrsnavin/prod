'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE QR CODE ON AN AADHAAR CARD — utils/aadhaarQr.js, POST /aadhaar-qr
//
//  The codes here are built the way UIDAI builds them (fields ended by
//  0xFF, the photo, a 256-byte RSA/SHA-256 signature, gzip, one decimal
//  number) and signed with a key made for the test, standing in for
//  UIDAI's: its public half is the only "certificate" the reader has.
//
//    • a V2 code and an older unversioned one are read, and verify
//    • a changed byte, or another key, fails the signature; no
//      certificates leaves it unchecked; the fields are still read
//    • an unknown version is read only when every field has its shape
//    • the pre-2019 XML code fills a form and proves nothing
//    • the card is compared with the person: last 4 digits, name, phone
//    • the route needs consent and an admin; with an employee it keeps
//      the outcome (not the address or the number) and logs the check;
//      the new-employee form can send the code with the record
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const UIDAI = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const STRANGER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERTS = fs.mkdtempSync(path.join(os.tmpdir(), 'uidai-'));
const NO_CERTS = fs.mkdtempSync(path.join(os.tmpdir(), 'uidai-none-'));
fs.writeFileSync(path.join(CERTS, 'test-uidai.pem'), UIDAI.publicKey.export({ type: 'spki', format: 'pem' }));
process.env.AADHAAR_QR_CERT_DIR = CERTS;

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const qr = require('../../utils/aadhaarQr');

const FF = Buffer.from([0xff]);
// A stand-in photo with 0xFF bytes in it, as a JPEG 2000 has.
const PHOTO = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0xff, 0x4f, 0xff, 0x51, 0x12, 0xff, 0xd9]);
const ORDER = ['flag', 'referenceId', 'name', 'dob', 'gender', 'careOf', 'district', 'landmark', 'house', 'location', 'pincode', 'postOffice', 'state', 'street', 'subDistrict', 'vtc'];
const rounds = (text, n) => { let h = text; for (let i = 0; i < Math.max(1, n); i++) h = crypto.createHash('sha256').update(h).digest('hex'); return Buffer.from(h, 'hex'); };

/** A Secure QR code's text, as the scanner reads it. */
function code({ version = 'V2', fields = {}, mobile = '9876543210', email = 'murugan@example.com', key = UIDAI.privateKey, tamper = false } = {}) {
  const f = {
    flag: '2', referenceId: '9012' + '20250115103045123', name: 'Murugan R', dob: '12-03-1990', gender: 'M',
    careOf: 'S/O: Ramasamy', district: 'Erode', landmark: 'Near Temple', house: '12', location: 'Main Road',
    pincode: '638001', postOffice: 'Erode HO', state: 'Tamil Nadu', street: 'Mill Street', subDistrict: 'Erode', vtc: 'Erode',
    ...fields,
  };
  const parts = [];
  if (version) parts.push(Buffer.from(version, 'latin1'), FF);
  for (const k of ORDER) parts.push(Buffer.from(f[k], 'latin1'), FF);
  if (version === 'V2') parts.push(Buffer.from(mobile.slice(-4)), FF);
  parts.push(PHOTO);
  if (!version) {
    const last = Number(f.referenceId[3]);
    if (f.flag === '1' || f.flag === '3') parts.push(rounds(email, last));
    if (f.flag === '2' || f.flag === '3') parts.push(rounds(mobile, last));
  }
  let data = Buffer.concat(parts);
  const signature = crypto.sign('sha256', data, key);
  if (tamper) { data = Buffer.from(data); data[data.indexOf(Buffer.from('Murugan'))] = 0x4e; }
  const zipped = zlib.gzipSync(Buffer.concat([data, signature]));
  return BigInt(`0x${zipped.toString('hex')}`).toString(10);
}

const OLD_XML = '<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData uid="234567890124" name="Selvi K" gender="F" yob="1985" co="W/O: Kumar" house="5" street="Gandhi Road" lm="" loc="" vtc="Erode" po="Erode" dist="Erode" subdist="Erode" state="Tamil Nadu" pc="638001"/>';

describe('reading the code', () => {
  test('a V2 code: every field, when it was made, and UIDAI\'s signature', async () => {
    const r = await qr.readAadhaarQr(code());
    expect(r).toEqual(expect.objectContaining({ kind: 'secure', version: 'V2', layout: 'known', signature: 'valid', key: 'test-uidai.pem', last4: '9012', mobileLast4: '3210', aadhaar: null }));
    expect(r.issuedAt.toISOString()).toBe('2025-01-15T05:00:45.123Z'); // 10:30:45 in India
    expect(r.fields).toEqual(expect.objectContaining({ name: 'Murugan R', dob: '1990-03-12', gender: 'male', careOf: 'S/O: Ramasamy', pincode: '638001' }));
    expect(r.fields.address).toBe('12, Mill Street, Near Temple, Main Road, Erode, Erode HO, Tamil Nadu');
  });

  test('an older code with no version: the same fields, the mobile as a hash', async () => {
    const r = await qr.readAadhaarQr(code({ version: null, fields: { flag: '3' } }));
    expect(r).toEqual(expect.objectContaining({ version: null, layout: 'known', signature: 'valid', mobileLast4: null }));
    expect(r.fields.name).toBe('Murugan R');
    expect(qr.compare(r, { phoneNumber: '9876543210' }).phone).toBe(true);
    // A hash that does not match proves little, so it is not called a mismatch.
    expect(qr.compare(r, { phoneNumber: '9000000000' }).phone).toBeNull();
  });

  test('a changed byte or another key fails the signature; the fields are still read', async () => {
    const changed = await qr.readAadhaarQr(code({ tamper: true }));
    expect(changed.signature).toBe('invalid');
    expect(changed.fields.name).toBe('Nurugan R');
    expect((await qr.readAadhaarQr(code({ key: STRANGER.privateKey }))).signature).toBe('invalid');
  });

  test('with no UIDAI certificate on the server the signature is unchecked', async () => {
    process.env.AADHAAR_QR_CERT_DIR = NO_CERTS;
    try {
      const r = await qr.readAadhaarQr(code());
      expect(r.signature).toBe('unchecked');
      expect(r.fields.name).toBe('Murugan R');
    } finally {
      process.env.AADHAAR_QR_CERT_DIR = CERTS;
    }
  });

  test('an unknown version is read only when every field has its shape', async () => {
    const fine = await qr.readAadhaarQr(code({ version: 'V3' }));
    expect(fine).toEqual(expect.objectContaining({ version: 'V3', layout: 'guessed', signature: 'valid' }));
    expect(fine.fields.dob).toBe('1990-03-12');
    const odd = await qr.readAadhaarQr(code({ version: 'V3', fields: { gender: 'Erode', dob: 'Tamil Nadu' } }));
    expect(odd).toEqual(expect.objectContaining({ layout: 'unreadable', fields: null, signature: 'valid' }));
  });

  test('a year of birth alone, and a gender of T', async () => {
    const r = await qr.readAadhaarQr(code({ fields: { dob: '1990', gender: 'T' } }));
    expect(r.fields.dob).toBe('1990-01-01');
    expect(r.fields.gender).toBe('other');
  });

  test('the pre-2019 XML code fills a form and proves nothing', async () => {
    const r = await qr.readAadhaarQr(OLD_XML);
    expect(r).toEqual(expect.objectContaining({ kind: 'old', signature: 'unsigned', aadhaar: '234567890124', last4: '0124' }));
    expect(r.fields).toEqual(expect.objectContaining({ name: 'Selvi K', dob: '1985-01-01', gender: 'female', pincode: '638001' }));
  });

  test('anything else is not an Aadhaar QR code', async () => {
    for (const t of ['', 'hello', '12345', 'https://example.com', '9'.repeat(13000)]) {
      await expect(qr.readAadhaarQr(t)).rejects.toMatchObject({ code: 'NOT_AADHAAR_QR', status: 400 });
    }
    // Data that unzips to far more than a card holds.
    const bomb = BigInt(`0x${zlib.gzipSync(Buffer.alloc(200 * 1024)).toString('hex')}`).toString(10);
    await expect(qr.readAadhaarQr(bomb)).rejects.toMatchObject({ code: 'NOT_AADHAAR_QR' });
  });
});

describe('comparing the card with the person', () => {
  test('last 4 digits, the name and the phone', async () => {
    const r = await qr.readAadhaarQr(code());
    expect(qr.compare(r, { name: 'R. Murugan', phoneNumber: '9876543210', aadhar: '2345 6789 9012' })).toEqual({ last4: true, name: 'same', phone: true });
    expect(qr.compare(r, { name: 'Murugan Ramasamy', phoneNumber: '9000000000', aadhar: '234567891234' })).toEqual({ last4: false, name: 'close', phone: false });
    expect(qr.compare(r, { name: 'Selvi K' }).name).toBe('different');
    expect(qr.compare(r, {})).toEqual({ last4: null, name: null, phone: null });
  });

  test('honorifics do not count', () => {
    expect(qr.nameMatch('Smt. Selvi Kumar', 'SELVI KUMAR')).toBe('same');
  });
});

describe('POST /api/v2/employee/aadhaar-qr', () => {
  let mongo, app, User, Employee, AccessEvent, admin, supervisor;
  const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
  const post = (u, url, body) => request(app).post(`/api/v2/employee${url}`).set('Cookie', cookieFor(u)).send(body);

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    app = require('../../app.js');
    User = require('../../models/User');
    Employee = require('../../models/Employee');
    AccessEvent = require('../../models/AccessEvent');
    admin = await User.create({ name: 'Owner', email: 'qr-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
    supervisor = await User.create({ name: 'Floor', email: 'qr-floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
  }, 180_000);
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  test('needs the employee\'s consent, and an admin', async () => {
    const no = await post(admin, '/aadhaar-qr', { qr: code() });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/consent/);
    expect((await post(supervisor, '/aadhaar-qr', { qr: code(), consent: true })).status).toBe(403);
  });

  test('on the new-employee form: read and compared with what was typed, nothing kept', async () => {
    const res = await post(admin, '/aadhaar-qr', { qr: code(), consent: true, compare: { name: 'Murugan R', phoneNumber: '9876543210', aadhar: '234567899012' } });
    expect(res.status).toBe(200);
    expect(res.body.read).toEqual(expect.objectContaining({ signature: 'valid', last4: '9012' }));
    expect(res.body.read.fields.name).toBe('Murugan R');
    expect(res.body.read.mobileHash).toBeUndefined();
    expect(res.body.matches).toEqual({ last4: true, name: 'same', phone: true });
    expect(res.body.check).toBeNull();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('a code that is not an Aadhaar QR says so', async () => {
    const res = await post(admin, '/aadhaar-qr', { qr: 'hello', consent: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not an Aadhaar QR code/);
  });

  test('on an employee: the outcome is kept, and the check is logged', async () => {
    const emp = await Employee.create({ name: 'R. Murugan', department: 'weaving', phoneNumber: '9876543210', aadhar: '234567899012' });
    const res = await post(admin, '/aadhaar-qr', { qr: code(), consent: true, employeeId: String(emp._id) });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual({ last4: true, name: 'same', phone: true });
    const kept = (await Employee.findById(emp._id).lean()).aadhaarCheck;
    expect(kept).toEqual(expect.objectContaining({ method: 'qr', signature: 'valid', last4: '9012', nameOnCard: 'Murugan R', consent: true, byName: 'Owner' }));
    expect(kept.matches).toEqual({ last4: true, name: 'same', phone: true });
    expect(kept.address).toBeUndefined();
    expect(JSON.stringify(kept)).not.toMatch(/Mill Street|234567899012/);
    const ev = await AccessEvent.findOne({ code: 'AADHAAR_QR_CHECKED', 'subject.id': String(emp._id) }).lean();
    expect(ev).toBeTruthy();
    // The detail page sees it.
    const detail = await request(app).get('/api/v2/employee/get-employee-detail').query({ id: String(emp._id) }).set('Cookie', cookieFor(admin));
    expect(detail.body.employee.aadhaarCheck.signature).toBe('valid');
  });

  test('a record never checked has no check at all', async () => {
    const emp = await Employee.create({ name: 'New Person', department: 'weaving' });
    expect((await Employee.findById(emp._id).lean()).aadhaarCheck).toBeUndefined();
  });

  test('the new-employee form sends the code with the record: details and the check kept', async () => {
    const res = await post(admin, '/create-employee', {
      name: 'Murugan R', department: 'weaving', phoneNumber: '9876543211', aadhar: '234567899012',
      dob: '1990-03-12', gender: 'male', address: '12, Mill Street, Erode', pincode: '638001',
      aadhaarQr: code({ mobile: '9876543211' }), aadhaarQrConsent: true,
    });
    expect(res.status).toBe(201);
    const emp = await Employee.findById(res.body.employee._id).lean();
    expect(emp).toEqual(expect.objectContaining({ dob: '1990-03-12', gender: 'male', pincode: '638001', address: '12, Mill Street, Erode' }));
    expect(emp.aadhaarCheck).toEqual(expect.objectContaining({ signature: 'valid', matches: { last4: true, name: 'same', phone: true } }));
  });

  test('the form\'s code without consent creates nothing', async () => {
    const before = await Employee.countDocuments();
    const res = await post(admin, '/create-employee', { name: 'No Consent', department: 'weaving', aadhaarQr: code() });
    expect(res.status).toBe(400);
    expect(await Employee.countDocuments()).toBe(before);
  });

  test('date of birth, gender and pin code are checked when edited', async () => {
    const emp = await Employee.create({ name: 'Edit Me', department: 'weaving' });
    const put = (body) => request(app).put('/api/v2/employee/update').query({ id: String(emp._id) }).set('Cookie', cookieFor(admin)).send(body);
    expect((await put({ dob: '12-03-1990' })).status).toBe(400);
    expect((await put({ gender: 'm' })).status).toBe(400);
    expect((await put({ pincode: '6380' })).status).toBe(400);
    const ok = await put({ dob: '1990-03-12', gender: 'Female', pincode: '638001', address: 'Erode' });
    expect(ok.status).toBe(200);
    expect(ok.body.employee).toEqual(expect.objectContaining({ dob: '1990-03-12', gender: 'female', pincode: '638001', address: 'Erode' }));
  });
});

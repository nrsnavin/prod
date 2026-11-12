'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE QR CODE ON AN AADHAAR CARD: what it says, and whether UIDAI
//  signed it
//
//  Aadhaar letters, e-Aadhaar downloads and PVC cards carry a "Secure
//  QR code": the holder's name, date of birth, gender, address, photo
//  and the last four digits of the number, signed by UIDAI. Checking
//  that signature is offline verification. No UIDAI API and no network
//  are involved: the data is genuine when it verifies against one of
//  the certificates UIDAI publishes. It is the check a business may
//  make with the holder's consent, and the full number is not in it,
//  by design.
//
//  The code's text is one large decimal number:
//
//    decimal → big-endian bytes → gzip → the data
//
//  and the data is:
//
//    ["V2" 0xFF]          the version, on codes made since 2022
//    text fields, each ended by 0xFF:
//      email/mobile flag   0 none, 1 email, 2 mobile, 3 both
//      reference ID        the number's last 4 digits, then when the
//                          code was made: YYYYMMDDHHMMSS[mmm], India time
//      name, date of birth (DD-MM-YYYY, or a year), gender (M/F/T)
//      care of, district, landmark, house, location, pin code,
//      post office, state, street, sub-district, village/town/city
//      V2: the mobile number's last 4 digits
//    the photo             JPEG 2000
//    unversioned codes:    SHA-256 of the email and/or the mobile,
//                          32 bytes each, as the flag says
//    the signature         256 bytes, RSA with SHA-256, over every
//                          byte before it
//
//  Only the text fields are split on 0xFF: the photo holds that byte
//  too. A version this code does not know (V3, V5…) still has its
//  signature checked, but its fields are used only when each one has
//  the shape it should (a date, M/F/T, a six-digit pin code). A misread
//  layout would still verify, so a guess has to prove itself.
//
//  Cards printed before 2019 carry an XML QR code with the full number
//  and no signature. It can fill a form, and it proves nothing.
//
//  UIDAI's certificates are kept in config/uidai/. Run
//  scripts/fetch-uidai-certs.js to download them from UIDAI's site,
//  which answers from India. If there are none on the first read, they
//  are fetched then. Every certificate is tried: a card signed in 2021
//  verifies against the key UIDAI used then, expired or not.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const SIGNATURE_BYTES = 256;
const HASH_BYTES = 32;
/** The longest QR text taken: a real code is about 3,000 digits. */
const MAX_TEXT = 12000;
/** The most the data may grow to when unzipped: a guard against a crafted code. */
const MAX_DATA = 64 * 1024;

/** UIDAI's certificates for the Secure QR code and offline e-KYC (uidai.gov.in → Data and Downloads). */
const UIDAI_CERTS = [
  'uidai_offline_publickey_2026.cer',
  'uidai_offline_publickey_17022026.cer',
  'uidai_offline_publickey_26022021.cer',
  'uidai_offline_publickey_29032019.cer',
  'uidai_offline_publickey_26022019.cer',
  'uidai_12_06_18_cer.cer',
  'uidai_prod_cdup.cer',
];
const UIDAI_BASE = 'https://backend.uidai.gov.in/get/files/media/document/2026-07/';

const CORE_FIELDS = [
  'flag', 'referenceId', 'name', 'dob', 'gender', 'careOf', 'district', 'landmark', 'house',
  'location', 'pincode', 'postOffice', 'state', 'street', 'subDistrict', 'vtc',
];
const GENDER = { M: 'male', F: 'female', T: 'other' };

class QrError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
const NOT_AADHAAR = 'This is not an Aadhaar QR code. Scan the large QR code on the Aadhaar letter, the e-Aadhaar or the PVC card.';

// ── UIDAI's certificates ──────────────────────────────────────────

const certDir = () => process.env.AADHAAR_QR_CERT_DIR || path.join(__dirname, '..', 'config', 'uidai');

let cache = null; // { dir, keys: [{ name, key, validTo }] }

/** The public keys in config/uidai/ (certificates, or PEM public keys). */
function loadKeys({ fresh = false } = {}) {
  const dir = certDir();
  if (!fresh && cache && cache.dir === dir) return cache.keys;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(cer|crt|pem)$/i.test(f)).sort(); } catch { files = []; }
  const keys = [];
  for (const name of files) {
    try {
      const buf = fs.readFileSync(path.join(dir, name));
      let key;
      let validTo = null;
      try {
        const cert = new crypto.X509Certificate(buf);
        key = cert.publicKey;
        validTo = cert.validTo;
      } catch {
        key = crypto.createPublicKey(buf);
      }
      if (key.asymmetricKeyType === 'rsa') keys.push({ name, key, validTo });
    } catch (err) {
      console.warn(`[aadhaar-qr] could not read ${name}: ${err.message}`);
    }
  }
  cache = { dir, keys };
  return keys;
}

function fetchOne(url, timeoutMs, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'jarvis-erp' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchOne(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(new Error('too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/**
 * Download UIDAI's certificates into config/uidai/. Each must parse as
 * an X.509 certificate with an RSA key before it is kept.
 * @returns {{ saved: object[], failed: object[] }}
 */
async function downloadCertificates({ timeoutMs = 15000, log = () => {} } = {}) {
  const dir = certDir();
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const failed = [];
  await Promise.all(UIDAI_CERTS.map(async (name) => {
    try {
      const buf = await fetchOne(UIDAI_BASE + name, timeoutMs);
      const cert = new crypto.X509Certificate(buf);
      if (cert.publicKey.asymmetricKeyType !== 'rsa') throw new Error('not an RSA certificate');
      fs.writeFileSync(path.join(dir, name), buf);
      const row = { name, subject: cert.subject.replace(/\n/g, ', '), validTo: cert.validTo, sha256: cert.fingerprint256 };
      saved.push(row);
      log(`saved ${name}  valid to ${row.validTo}  SHA-256 ${row.sha256}`);
    } catch (err) {
      failed.push({ name, error: err.message });
      log(`could not get ${name}: ${err.message}`);
    }
  }));
  loadKeys({ fresh: true });
  return { saved, failed };
}

let lastFetchFailed = 0;

/** The keys, fetching UIDAI's certificates once if there are none (not in tests). */
async function keysForChecking() {
  let keys = loadKeys();
  if (keys.length || process.env.NODE_ENV === 'test') return keys;
  if (Date.now() - lastFetchFailed < 15 * 60 * 1000) return keys;
  try {
    const r = await downloadCertificates({ timeoutMs: 8000 });
    if (!r.saved.length) lastFetchFailed = Date.now();
    else console.log(`[aadhaar-qr] fetched ${r.saved.length} UIDAI certificate(s) into ${certDir()}`);
  } catch (err) {
    lastFetchFailed = Date.now();
    console.warn(`[aadhaar-qr] could not fetch UIDAI's certificates: ${err.message}`);
  }
  keys = loadKeys();
  return keys;
}

// ── Reading the code ──────────────────────────────────────────────

function bytesOfDecimal(text) {
  let hex = BigInt(text).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

function unzip(buf) {
  const opts = { maxOutputLength: MAX_DATA };
  for (const fn of [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync]) {
    try { return fn(buf, opts); } catch { /* the next */ }
  }
  return null;
}

const textOf = (buf) => {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
};

/** The first `count` 0xFF-ended fields from `start`, and where the rest begins. */
function fieldsFrom(data, start, count) {
  const out = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    const end = data.indexOf(0xff, at);
    if (end < 0) return null;
    out.push(textOf(data.subarray(at, end)).trim());
    at = end + 1;
  }
  return { values: out, next: at };
}

/** A date of birth as YYYY-MM-DD; a year alone as YYYY-01-01, as the ID card reader does. */
function dobOf(s) {
  const t = String(s || '').trim();
  let y; let m; let d;
  let r = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(t);
  if (r) [, d, m, y] = r;
  else if ((r = /^(\d{4})[-/.](\d{2})[-/.](\d{2})$/.exec(t))) [, y, m, d] = r;
  else if ((r = /^(\d{4})$/.exec(t))) [y, m, d] = [r[1], '01', '01'];
  else return null;
  const year = Number(y);
  if (year < 1900 || year > new Date().getFullYear() || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${m}-${d}`;
}

/** The reference ID: the number's last 4 digits, and when the code was made (India time). */
function referenceOf(s) {
  const t = String(s || '');
  const r = /^(\d{4})(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{0,3})/.exec(t);
  if (!r) return { last4: /^\d{4}/.test(t) ? t.slice(0, 4) : null, issuedAt: null };
  const [, last4, Y, Mo, D, h, mi, se, ms] = r;
  const at = new Date(`${Y}-${Mo}-${D}T${h}:${mi}:${se}.${(ms || '0').padEnd(3, '0')}+05:30`);
  return { last4, issuedAt: Number.isNaN(at.getTime()) ? null : at };
}

/** The address on one line, without the pin code, each part once. */
function addressOf(f) {
  const seen = new Set();
  return [f.house, f.street, f.landmark, f.location, f.vtc, f.postOffice, f.subDistrict, f.district, f.state]
    .map((p) => String(p || '').trim())
    .filter((p) => p && !seen.has(p.toUpperCase()) && seen.add(p.toUpperCase()))
    .join(', ');
}

/** Each field the shape it should have: a guessed layout is used only then. */
function shapesHold(f) {
  return /^[0-3]$/.test(f.flag) && /^\d{4}/.test(f.referenceId) && f.name.length > 0 && f.name.length <= 150
    && !!dobOf(f.dob) && /^[MFT]$/i.test(f.gender) && (!f.pincode || /^\d{6}$/.test(f.pincode));
}

function cleanFields(f) {
  const out = {
    name: f.name, dob: dobOf(f.dob), gender: GENDER[String(f.gender).toUpperCase()] || null,
    careOf: f.careOf, house: f.house, street: f.street, landmark: f.landmark, location: f.location,
    vtc: f.vtc, postOffice: f.postOffice, subDistrict: f.subDistrict, district: f.district,
    state: f.state, pincode: /^\d{6}$/.test(f.pincode || '') ? f.pincode : '',
  };
  out.address = addressOf(out);
  return out;
}

function verifyWith(keys, signed, signature) {
  for (const k of keys) {
    try { if (crypto.verify('sha256', signed, k.key, signature)) return k; } catch { /* another size of key */ }
  }
  return null;
}

async function readSecure(data) {
  if (data.length <= SIGNATURE_BYTES + 32) throw new QrError(NOT_AADHAAR, 'NOT_AADHAAR_QR');
  const head = data.subarray(0, 4).toString('latin1');
  const v = /^V(\d{1,2})\xff/.exec(head);
  const version = v ? `V${v[1]}` : null;
  const start = v ? v[0].length : 0;
  const known = version === null || version === 'V2';

  const signature = data.subarray(data.length - SIGNATURE_BYTES);
  const signed = data.subarray(0, data.length - SIGNATURE_BYTES);
  const keys = await keysForChecking();
  const key = keys.length ? verifyWith(keys, signed, signature) : null;
  const signatureState = !keys.length ? 'unchecked' : key ? 'valid' : 'invalid';

  const read = {
    kind: 'secure', version, layout: 'unreadable', signature: signatureState, key: key ? key.name : null,
    last4: null, issuedAt: null, fields: null, aadhaar: null, mobileLast4: null, mobileHash: null,
  };
  const parsed = fieldsFrom(signed, start, CORE_FIELDS.length + (version === 'V2' ? 1 : 0));
  if (!parsed) return read;
  const f = Object.fromEntries(CORE_FIELDS.map((k, i) => [k, parsed.values[i]]));
  if (!shapesHold(f)) return read;

  read.layout = known ? 'known' : 'guessed';
  read.fields = cleanFields(f);
  Object.assign(read, referenceOf(f.referenceId));
  if (version === 'V2') {
    const m = parsed.values[CORE_FIELDS.length];
    read.mobileLast4 = /^\d{4}$/.test(m || '') ? m : null;
  } else if (version === null && (f.flag === '2' || f.flag === '3')) {
    // The mobile's hash is the last 32 bytes before the signature.
    read.mobileHash = signed.subarray(signed.length - HASH_BYTES);
  }
  return read;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);

/** The QR code on cards printed before 2019: XML, the full number, no signature. */
function readOldXml(text) {
  if (!/<(PrintLetterBarcodeData|QPDB)\b/i.test(text)) return null;
  const a = {};
  for (const m of text.matchAll(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g)) a[m[1].toLowerCase()] = unescapeXml(m[2]).trim();
  const uid = String(a.uid || a.u || '').replace(/\s/g, '');
  const g = String(a.gender || a.g || '').trim().toUpperCase();
  const f = {
    name: a.name || a.n || '', dob: dobOf(a.dob || a.d || a.yob || ''), gender: GENDER[g.charAt(0)] || null,
    careOf: a.co || '', house: a.house || '', street: a.street || '', landmark: a.lm || '', location: a.loc || '',
    vtc: a.vtc || '', postOffice: a.po || '', subDistrict: a.subdist || '', district: a.dist || '',
    state: a.state || '', pincode: /^\d{6}$/.test(a.pc || '') ? a.pc : '',
  };
  f.address = addressOf(f) || a.a || '';
  if (!f.name) return null;
  return {
    kind: 'old', version: null, layout: 'known', signature: 'unsigned', key: null,
    last4: /^\d{12}$/.test(uid) ? uid.slice(-4) : null, issuedAt: null, fields: f,
    aadhaar: /^\d{12}$/.test(uid) ? uid : null, mobileLast4: null, mobileHash: null,
  };
}

/**
 * Read the text of an Aadhaar card's QR code.
 * @returns the card's details and the state of UIDAI's signature
 * @throws QrError (status 400, code NOT_AADHAAR_QR) for anything else
 */
async function readAadhaarQr(text) {
  const t = String(text || '').trim();
  if (!t || t.length > MAX_TEXT) throw new QrError(NOT_AADHAAR, 'NOT_AADHAAR_QR');
  if (/^\d+$/.test(t)) {
    const data = unzip(bytesOfDecimal(t));
    if (!data) throw new QrError(NOT_AADHAAR, 'NOT_AADHAAR_QR');
    return readSecure(data);
  }
  const old = readOldXml(t);
  if (old) return old;
  throw new QrError(NOT_AADHAAR, 'NOT_AADHAAR_QR');
}

// ── Comparing it with the person ──────────────────────────────────

const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'SHRI', 'SRI', 'SMT', 'KUMARI', 'KUM', 'DR', 'SELVI', 'THIRU', 'TMT']);
const nameWords = (s) => String(s || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((w) => w && !HONORIFICS.has(w));

/** 'same', 'close' (initials or a word fewer), 'different', or null when either is missing. */
function nameMatch(a, b) {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return null;
  if ([...x].sort().join(' ') === [...y].sort().join(' ')) return 'same';
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const pool = [...long];
  const fits = short.every((w) => {
    const i = pool.findIndex((p) => p === w || (w.length === 1 && p[0] === w) || (p.length === 1 && w[0] === p));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
  return fits ? 'close' : 'different';
}

/**
 * Does the phone match the mobile number registered with this Aadhaar?
 * true or false from a V2 code's last 4 digits; from an older code's
 * hash only a match is reported (true), anything else is null.
 */
function phoneMatch(read, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  if (read.mobileLast4) return digits.slice(-4) === read.mobileLast4;
  if (read.mobileHash && read.last4) {
    const last = Number(read.last4.slice(-1));
    let h = digits;
    for (let i = 0; i < Math.max(1, last); i++) h = crypto.createHash('sha256').update(h).digest('hex');
    return h === read.mobileHash.toString('hex') ? true : null;
  }
  return null;
}

/** The card against a person: their name, phone and Aadhaar number (any may be missing). */
function compare(read, { name, phoneNumber, aadhar } = {}) {
  const typed = String(aadhar || '').replace(/\D/g, '');
  return {
    last4: read.last4 && typed.length === 12 ? typed.slice(-4) === read.last4 : null,
    name: read.fields ? nameMatch(read.fields.name, name) : null,
    phone: phoneMatch(read, phoneNumber),
  };
}

/** What is kept on the employee: the outcome, never the photo, the address or the number. */
function checkRecord(read, matches, user) {
  return {
    method: 'qr',
    kind: read.kind,
    version: read.version || '',
    layout: read.layout,
    signature: read.signature,
    key: read.key || '',
    last4: read.last4 || '',
    issuedAt: read.issuedAt || null,
    nameOnCard: read.fields?.name || '',
    dobOnCard: read.fields?.dob || '',
    genderOnCard: read.fields?.gender || '',
    matches,
    consent: true,
    at: new Date(),
    by: user?._id || null,
    byName: user?.name || '',
  };
}

/** The read as the screens get it: without the hashes. */
function publicRead(read) {
  const { mobileHash, ...rest } = read;
  return rest;
}

module.exports = {
  readAadhaarQr, compare, checkRecord, publicRead, nameMatch, phoneMatch, dobOf, referenceOf,
  downloadCertificates, loadKeys, certDir, UIDAI_CERTS, QrError,
};

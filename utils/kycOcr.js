'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK DETAILS FROM A CANCELLED CHEQUE, AND A PERSON FROM THEIR ID
//
//  readCheque(pages) → { problem, accountNo, ifsc, bankName, branch, holder }
//    A cancelled cheque, a passbook's first page or a bank's letter. The
//    holder is compared with the party's name by the route.
//  readIdCard(pages) → { problem, kind, name, dob, gender, pan, aadhaar,
//    aadhaarValid, aadhaarLast4 }
//    An Aadhaar or PAN card (or both). The Aadhaar number goes back only
//    to the form being filled — as typing it would — checked by its
//    Verhoeff digit; anything kept for accuracy keeps its last four only.
// ══════════════════════════════════════════════════════════════════

const { readJson, str } = require('./docRead');

const CHEQUE_PROMPT = [
  'This is a cancelled cheque, the first page of a bank passbook, or a bank\'s letter confirming an account, from India.',
  'Read the account it names. Return ONLY JSON:',
  '{"problem":null,"accountNo":"50100123456789","ifsc":"HDFC0001234","bankName":"HDFC Bank","branch":"Erode Main","holder":"SRI YARN TRADERS"}',
  '- problem: "not_a_cheque" when this is none of those; "unreadable" when it cannot be read; else null.',
  '- accountNo: digits only, exactly as printed (not the cheque number, not the MICR line). ifsc: the 11-character IFSC.',
  '- holder: the account holder\'s name as printed (for a business, the firm\'s name). Never guess a digit; leave a field "" when unsure.',
].join('\n');

const ID_PROMPT = [
  'These are photos of an Indian identity card: an Aadhaar card and/or a PAN card, of a person joining a factory. Return ONLY JSON:',
  '{"problem":null,"kind":"aadhaar","name":"R. Murugan","dob":"1990-03-12","gender":"male","pan":"","aadhaar":"234567890123"}',
  '- problem: "not_an_id" when these are not an Aadhaar or PAN card; "unreadable" when they cannot be read; else null.',
  '- kind: aadhaar, pan, or both. name as printed in English. dob as YYYY-MM-DD (year only cards: YYYY-01-01). gender: male, female or other.',
  '- aadhaar: the 12 digits, no spaces, exactly as printed (not the VID, not the enrolment number). pan: 10 characters.',
  '- Never guess a digit; leave a field "" when unsure.',
].join('\n');

// ── Verhoeff: Aadhaar's last digit checks the other eleven ─────────
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeffOk(num) {
  const s = String(num || '');
  if (!/^\d+$/.test(s)) return false;
  let c = 0;
  s.split('').reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]]; });
  return c === 0;
}
/** A real Aadhaar: 12 digits, not starting 0 or 1, the Verhoeff digit holding. */
const aadhaarOk = (n) => /^[2-9]\d{11}$/.test(String(n || '')) && verhoeffOk(n);

function normaliseCheque(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_cheque' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const accountNo = String(raw.accountNo || '').replace(/\D/g, '');
  const ifsc = String(raw.ifsc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return {
    problem: null,
    accountNo: /^\d{6,18}$/.test(accountNo) ? accountNo : '',
    ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ? ifsc : '',
    bankName: str(raw.bankName, 80), branch: str(raw.branch, 80), holder: str(raw.holder, 120),
    ...meta,
  };
}

function normaliseId(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_an_id' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const aadhaar = String(raw.aadhaar || '').replace(/\D/g, '');
  const pan = String(raw.pan || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return {
    problem: null,
    kind: ['aadhaar', 'pan', 'both'].includes(raw.kind) ? raw.kind : '',
    name: str(raw.name, 100),
    dob: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dob || '')) ? raw.dob : '',
    gender: ['male', 'female', 'other'].includes(String(raw.gender || '').toLowerCase()) ? String(raw.gender).toLowerCase() : '',
    pan: /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : '',
    aadhaar: aadhaar.length === 12 ? aadhaar : '',
    aadhaarValid: aadhaarOk(aadhaar),
    aadhaarLast4: aadhaar.length === 12 ? aadhaar.slice(-4) : '',
    ...meta,
  };
}

async function readCheque(pages) {
  const r = await readJson({ pages, prompt: CHEQUE_PROMPT, maxTokens: 400, maxPages: 2 });
  return normaliseCheque(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

async function readIdCard(pages) {
  const r = await readJson({ pages, prompt: ID_PROMPT, maxTokens: 400, maxPages: 2 });
  return normaliseId(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

/** How alike two names are, once "M/s", "Pvt Ltd" and punctuation are set aside: true when the same firm or person. */
function sameName(a, b) {
  const squash = (s) => String(s || '').toUpperCase().replace(/\b(M\/S|MS|THE|PVT|PRIVATE|LTD|LIMITED|LLP|AND|CO|COMPANY|MR|MRS|MS)\b/g, '').replace(/[^A-Z0-9]/g, '');
  const x = squash(a); const y = squash(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const { distance } = require('../services/paymentChecks');
  return Math.min(x.length, y.length) >= 6 && distance(x, y, 2) <= 2;
}

module.exports = { readCheque, readIdCard, normaliseCheque, normaliseId, verhoeffOk, aadhaarOk, sameName, CHEQUE_PROMPT, ID_PROMPT };

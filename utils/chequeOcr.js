'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S CHEQUE, READ FROM A PHOTO
//
//  readCustomerCheque(pages) → { problem, chequeNo, date, amount,
//    amountWords, payee, drawer, bankName, branch, ifsc, micr, accountNo,
//    crossed, signed, model, usage, latencyMs }
//
//  The cheque a customer hands over, photographed on the counter or sent
//  on WhatsApp, read so the receipt (or the post-dated cheque) is not
//  typed: number, bank, date, amount. What is read is only copied; the
//  checks — the figure against the words, the date, who it is made out
//  to — are services/chequeIntake.js's, never the model's.
//  (A cancelled cheque giving a supplier's bank account is
//  utils/kycOcr.js's readCheque: a different question.)
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const PROMPT = [
  'This is a photo of a bank cheque from India (a CTS-2010 cheque) that a customer gave to an elastic factory.',
  'Read what is written and printed on it. Return ONLY JSON:',
  '{"problem":null,"chequeNo":"004512","date":"2026-11-20","amount":19530,"amountWords":"Rupees Nineteen Thousand Five Hundred Thirty Only",',
  ' "payee":"BALU ELASTICS","drawer":"SUNRISE GARMENTS PVT LTD","bankName":"HDFC Bank","branch":"Tiruppur","ifsc":"HDFC0001234",',
  ' "micr":"004512 641240002 001234 29","accountNo":"50200012345678","crossed":true,"signed":true}',
  '- problem: "not_a_cheque" when this is not a cheque; "unreadable" when it cannot be read; else null.',
  '- date: from the date boxes (DD MM YYYY) as YYYY-MM-DD; "" when blank.',
  '- amount: the figure in the amount box, in rupees (paise as decimals); null when blank.',
  '- amountWords: the amount as written in words, word for word, spelling and all; "" when blank.',
  '- payee: the name after "Pay". drawer: the account holder printed or stamped over the signature (for a firm, its name).',
  '- chequeNo: the 6-digit cheque number (the first group of the MICR line along the bottom). micr: the whole MICR line, digits and spaces only.',
  '- crossed: true when two parallel lines or "A/c Payee" cross a corner. signed: true when it carries a signature.',
  '- Never guess a digit or a letter; leave a field "" (or null for amount) when unsure.',
].join('\n');

function normalise(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_cheque' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const chequeNo = String(raw.chequeNo || '').replace(/\D/g, '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) && !Number.isNaN(new Date(`${raw.date}T00:00:00Z`).getTime()) ? raw.date : '';
  const amount = num(raw.amount);
  const ifsc = String(raw.ifsc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const accountNo = String(raw.accountNo || '').replace(/\D/g, '');
  return {
    problem: null,
    chequeNo: /^\d{6}$/.test(chequeNo) ? chequeNo : '',
    date,
    amount: amount != null && amount > 0 && amount < 1e10 ? Math.round(amount * 100) / 100 : null,
    amountWords: str(raw.amountWords, 200),
    payee: str(raw.payee, 120),
    drawer: str(raw.drawer, 120),
    bankName: str(raw.bankName, 80),
    branch: str(raw.branch, 80),
    ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ? ifsc : '',
    micr: String(raw.micr || '').replace(/[^\d ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60),
    accountNo: /^\d{6,18}$/.test(accountNo) ? accountNo : '',
    crossed: raw.crossed === true,
    signed: raw.signed !== false,
    ...meta,
  };
}

async function readCustomerCheque(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 600, maxPages: 2 });
  return normalise(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readCustomerCheque, normalise, PROMPT };
